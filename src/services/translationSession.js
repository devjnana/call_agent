import { decodeMuLawToPcm16 } from '../utils/mulaw.js';
import { pcm8kTo24k, openAiPcmToPlivoMuLaw } from '../utils/audioResample.js';
import { isLikelySpeech } from '../utils/vad.js';
import { isoToPromptLabel } from '../utils/languageLabels.js';
import { env } from '../config/index.js';
import { OpenAiRealtimeTranslation } from '../openai/realtimeTranslation.js';
import { OpenAiRealtimeVoiceInterpreter } from '../openai/realtimeVoiceInterpreter.js';
import { SarvamElevenTranslator } from '../pipelines/sarvamElevenTranslator.js';
import { log } from '../utils/logger.js';

/** Chunk TTS PCM for Plivo playAudio frames (~75ms at 24kHz mono s16le). */
const PLAY_PCM24_CHUNK_BYTES = 3600;

function sendPcm24ToPlivo(ws, pcm24kDelta, troubleshootCtx) {
  const troubleshoot =
    env.openaiRealtimePipeline === 'sarvam_eleven' && env.pipelineTroubleshootLog;
  const sid = troubleshootCtx?.sessionId;
  const listener = troubleshootCtx?.listenerLeg;
  if (!ws || ws.readyState !== 1 || !pcm24kDelta?.length) {
    if (troubleshoot && pcm24kDelta?.length) {
      log.warn(
        `[engine] playAudio skipped session=${sid} listener=${listener} wsReady=${ws?.readyState} pcm24_bytes=${pcm24kDelta.length}`,
      );
    }
    return;
  }
  let frames = 0;
  for (let i = 0; i < pcm24kDelta.length; i += PLAY_PCM24_CHUNK_BYTES) {
    const slice = pcm24kDelta.subarray(
      i,
      Math.min(i + PLAY_PCM24_CHUNK_BYTES, pcm24kDelta.length),
    );
    const mu = openAiPcmToPlivoMuLaw(slice).toString('base64');
    ws.send(
      JSON.stringify({
        event: 'playAudio',
        media: {
          contentType: 'audio/x-mulaw',
          sampleRate: '8000',
          payload: mu,
        },
      }),
    );
    frames += 1;
  }
  if (troubleshoot) {
    log.info(
      `[engine] playAudio ok session=${sid} listener=${listener} pcm24_bytes=${pcm24kDelta.length} mulaw_chunks=${frames}`,
    );
  }
}

/**
 * Bridges two muted conference legs with independent realtime translators (OpenAI or Sarvam+ElevenLabs).
 */
export class TranslationSession {
  /**
   * @param {object} p
   * @param {string} p.id
   * @param {string} p.agentE164
   * @param {string} p.customerE164
   * @param {string} p.toAgentTag
   * @param {string} p.toCustomerTag
   * @param {string} p.agentSpokenApprox ISO-like tag inferred from CRM languages
   * @param {string} p.customerSpokenApprox ISO-like inferred tag
   */
  constructor(p) {
    this.id = p.id;
    this.agentE164 = p.agentE164;
    this.customerE164 = p.customerE164;
    this.toAgentTag = p.toAgentTag;
    this.toCustomerTag = p.toCustomerTag;
    /** @see resolveTranslationTargets */
    this.agentSpokenApprox = p.agentSpokenApprox;
    this.customerSpokenApprox = p.customerSpokenApprox;

    /** @type {string | null} */
    this.agentCallUuid = null;
    /** @type {string | null} */
    this.customerCallUuid = null;

    /** @type {import('ws').WebSocket | null} */
    this.agentPlivoWs = null;
    /** @type {import('ws').WebSocket | null} */
    this.customerPlivoWs = null;

    /** @type {string | null} */
    this.agentStreamId = null;
    /** @type {string | null} */
    this.customerStreamId = null;

    /** @type {OpenAiRealtimeTranslation | OpenAiRealtimeVoiceInterpreter | SarvamElevenTranslator | null} */
    this.oaiTowardAgent = null;
    /** @type {OpenAiRealtimeTranslation | OpenAiRealtimeVoiceInterpreter | SarvamElevenTranslator | null} */
    this.oaiTowardCustomer = null;

    this.customerDialStarted = false;
    this.closed = false;
    this.lastActivityMs = Date.now();
    /** @type {Set<() => void>} */
    this.destroyListeners = new Set();
    /** @type {boolean} */
    this._openAiWarmed = false;
    /** @type {Set<string>} */
    this._trFirstMediaLog = new Set();
  }

  idleMs() {
    return Date.now() - this.lastActivityMs;
  }

  touch() {
    this.lastActivityMs = Date.now();
  }

  onDestroy(cb) {
    this.destroyListeners.add(cb);
    return () => this.destroyListeners.delete(cb);
  }

  warmTranslators() {
    if (this._openAiWarmed || this.closed) return;
    this._openAiWarmed = true;

    const pipeline = env.openaiRealtimePipeline;
    /** @typedef {typeof OpenAiRealtimeTranslation | typeof OpenAiRealtimeVoiceInterpreter | typeof SarvamElevenTranslator} PipeCtor */

    /** @type {PipeCtor} */
    let TowAgent;
    /** @type {PipeCtor} */
    let TowCustomer;

    let argsTowAgent;
    let argsTowCust;

    if (pipeline === 'sarvam_eleven') {
      TowAgent = SarvamElevenTranslator;
      TowCustomer = SarvamElevenTranslator;
      argsTowAgent = {
        sourceIso639: this.customerSpokenApprox,
        targetIso639: this.toAgentTag,
        elevenLabsVoiceId: env.elevenLabsVoiceIdForIso(this.toAgentTag),
        onDeltaPcm: (pcm24delta) => this.playMuLawOnAgentLeg(pcm24delta),
        onError: (e) => log.warn('Sarvam+11 cust→agent', this.id, e.message),
        label: 'cust→agent',
      };
      argsTowCust = {
        sourceIso639: this.agentSpokenApprox,
        targetIso639: this.toCustomerTag,
        elevenLabsVoiceId: env.elevenLabsVoiceIdForIso(this.toCustomerTag),
        onDeltaPcm: (pcm24delta) => this.playMuLawOnCustomerLeg(pcm24delta),
        onError: (e) => log.warn('Sarvam+11 agent→cust', this.id, e.message),
        label: 'agent→cust',
      };
    } else if (pipeline === 'voice') {
      TowAgent = OpenAiRealtimeVoiceInterpreter;
      TowCustomer = OpenAiRealtimeVoiceInterpreter;
      argsTowAgent = {
        sourceLabel: isoToPromptLabel(this.customerSpokenApprox),
        targetLabel: isoToPromptLabel(this.toAgentTag),
        onDeltaPcm: (pcm24delta) => this.playMuLawOnAgentLeg(pcm24delta),
        onError: (e) => log.warn('OpenAI cust→agent', this.id, e.message),
      };
      argsTowCust = {
        sourceLabel: isoToPromptLabel(this.agentSpokenApprox),
        targetLabel: isoToPromptLabel(this.toCustomerTag),
        onDeltaPcm: (pcm24delta) => this.playMuLawOnCustomerLeg(pcm24delta),
        onError: (e) => log.warn('OpenAI agent→cust', this.id, e.message),
      };
    } else {
      TowAgent = OpenAiRealtimeTranslation;
      TowCustomer = OpenAiRealtimeTranslation;
      argsTowAgent = {
        outputLanguageTag: this.toAgentTag,
        onDeltaPcm: (pcm24delta) => this.playMuLawOnAgentLeg(pcm24delta),
        onError: (e) => log.warn('OpenAI cust→agent', this.id, e.message),
      };
      argsTowCust = {
        outputLanguageTag: this.toCustomerTag,
        onDeltaPcm: (pcm24delta) => this.playMuLawOnCustomerLeg(pcm24delta),
        onError: (e) => log.warn('OpenAI agent→cust', this.id, e.message),
      };
    }

    this.oaiTowardAgent = new TowAgent(argsTowAgent);
    this.oaiTowardCustomer = new TowCustomer(argsTowCust);

    this.oaiTowardAgent.connect();
    this.oaiTowardCustomer.connect();
  }

  /** @param {"agent"|"customer"} role */
  setCallUuid(role, uuid) {
    this.touch();
    if (role === 'agent') this.agentCallUuid = uuid;
    else this.customerCallUuid = uuid;
  }

  /**
   * Persist live Plivo websocket + stream metadata per leg (Gateway calls once on `start`).
   * @param {"agent"|"customer"} role
   */
  attachPlivoSocket(role, ws, meta) {
    this.touch();
    const streamId = meta?.streamId ?? null;
    if (role === 'agent') {
      this.agentPlivoWs = ws;
      this.agentStreamId = streamId;
    } else {
      this.customerPlivoWs = ws;
      this.customerStreamId = streamId;
    }

    ws.once('close', () => {
      this.onPlivoSocketClosed(role);
    });
  }

  /** @param {"agent"|"customer"} spokeRole RTP source mic */
  ingestPlivoMedia(spokeRole, mulawPayload) {
    if (this.closed) return;
    if (!this._openAiWarmed) this.warmTranslators();
    this.touch();

    if (mulawPayload.length === 0) return;

    if (
      env.openaiRealtimePipeline === 'sarvam_eleven' &&
      env.pipelineTroubleshootLog &&
      !this._trFirstMediaLog.has(spokeRole)
    ) {
      this._trFirstMediaLog.add(spokeRole);
      log.info(
        `[engine] Plivo media first packet session=${this.id} speaker_leg=${spokeRole} mulaw_bytes=${mulawPayload.length} likely_speech_energy=${isLikelySpeech(mulawPayload)}`,
      );
    }

    if (spokeRole === 'agent' && this.agentStreamId && isLikelySpeech(mulawPayload)) {
      this.clearPlivoPlaybackForListener('customer', this.customerStreamId);
    }
    if (spokeRole === 'customer' && this.customerStreamId && isLikelySpeech(mulawPayload)) {
      this.clearPlivoPlaybackForListener('agent', this.agentStreamId);
    }

    const pcm16 = decodeMuLawToPcm16(mulawPayload);
    const pcm24 = pcm8kTo24k(pcm16);

    if (spokeRole === 'customer') {
      this.oaiTowardAgent?.appendPcm24kMono(pcm24);
    } else {
      this.oaiTowardCustomer?.appendPcm24kMono(pcm24);
    }
  }

  /**
   * @param {Buffer} pcm24kDelta mono int16 LE (OpenAI deltas)
   */
  playMuLawOnAgentLeg(pcm24kDelta) {
    sendPcm24ToPlivo(this.agentPlivoWs, pcm24kDelta, {
      sessionId: this.id,
      listenerLeg: 'agent',
    });
  }

  playMuLawOnCustomerLeg(pcm24kDelta) {
    sendPcm24ToPlivo(this.customerPlivoWs, pcm24kDelta, {
      sessionId: this.id,
      listenerLeg: 'customer',
    });
  }

  /**
   * @param {"agent"|"customer"} listener — who *hears* the translated audio queue to clear.
   */
  clearPlivoPlaybackForListener(listener, streamId) {
    const ws =
      listener === 'agent' ? this.agentPlivoWs : this.customerPlivoWs;
    if (!ws || ws.readyState !== 1 || !streamId) return;
    ws.send(JSON.stringify({ event: 'clearAudio', streamId }));
  }

  /**
   * @param {"agent"|"customer"} role
   */
  onPlivoSocketClosed(role) {
    if (this.closed) return;
    log.warn(
      `Plivo media websocket closed session=${this.id} leg=${role} — ending bridge (any leg disconnect destroys session)`,
    );
    if (role === 'agent') {
      this.agentPlivoWs = null;
      this.agentStreamId = null;
    } else {
      this.customerPlivoWs = null;
      this.customerStreamId = null;
    }
    this.touch();
    /** Any media socket loss ends the bilingual bridge */
    this.destroy(`${role}_stream_closed`);
  }

  destroy(reason) {
    if (this.closed) return;
    this.closed = true;
    log.info('Session destroy', this.id, reason);
    try {
      this.oaiTowardAgent?.close();
      this.oaiTowardCustomer?.close();
    } catch (_) {}
    this.oaiTowardAgent = null;
    this.oaiTowardCustomer = null;
    for (const cb of [...this.destroyListeners]) {
      try {
        cb();
      } catch (_) {}
    }
    this.destroyListeners.clear();
  }
}
