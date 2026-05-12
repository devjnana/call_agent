import { decodeMuLawToPcm16 } from '../utils/mulaw.js';
import {
  pcm8kTo24k,
  pcm24kTo8k,
  openAiPcmToPlivoMuLaw,
} from '../utils/audioResample.js';
import { isLikelySpeech, pcm16MonoRms } from '../utils/vad.js';
import { isoToPromptLabel } from '../utils/languageLabels.js';
import { env } from '../config/index.js';
import { OpenAiRealtimeTranslation } from '../openai/realtimeTranslation.js';
import { OpenAiRealtimeVoiceInterpreter } from '../openai/realtimeVoiceInterpreter.js';
import { SarvamElevenTranslator } from '../pipelines/sarvamElevenTranslator.js';
import { log } from '../utils/logger.js';

/** Chunk TTS PCM for Plivo playAudio frames (~75ms at 24kHz mono s16le). */
const PLAY_PCM24_CHUNK_BYTES = 3600;

/** Plivo requires `playAudio.media` to match the Stream `content_type` (incl. rate suffix for µ-law). */
function sendPcm24ToPlivo(ws, pcm24kDelta, troubleshootCtx) {
  const troubleshoot =
    env.openaiRealtimePipeline === 'sarvam_eleven' && env.pipelineTroubleshootLog;
  const sid = troubleshootCtx?.sessionId;
  const listener = troubleshootCtx?.listenerLeg;
  const streamId = troubleshootCtx?.streamId;
  const useMulaw = troubleshootCtx?.useMulaw ?? env.plivoStreamUsesMulaw;
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
    const bytes8k = useMulaw ? openAiPcmToPlivoMuLaw(slice) : pcm24kTo8k(slice);
    const media = useMulaw
      ? {
          contentType: 'audio/x-mulaw;rate=8000',
          sampleRate: 8000,
          payload: bytes8k.toString('base64'),
        }
      : {
          contentType: 'audio/x-l16',
          sampleRate: 8000,
          payload: bytes8k.toString('base64'),
        };
    const out = { event: 'playAudio', media };
    if (streamId) out.streamId = streamId;
    ws.send(JSON.stringify(out));
    frames += 1;
  }
  if (troubleshoot) {
    log.info(
      `[engine] playAudio ok session=${sid} listener=${listener} codec=${useMulaw ? 'mulaw' : 'l16'} streamId=${streamId ? 'yes' : 'no'} pcm24_bytes=${pcm24kDelta.length} chunks=${frames}`,
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
    /**
     * Plivo inbound framing per leg (from Stream `start.mediaFormat` or env default).
     * @type {{ agent: 'mulaw' | 'l16', customer: 'mulaw' | 'l16' }}
     */
    this.inboundCodec = {
      agent: env.plivoStreamUsesMulaw ? 'mulaw' : 'l16',
      customer: env.plivoStreamUsesMulaw ? 'mulaw' : 'l16',
    };
    /** TTS PCM queued until `streamId` from Plivo `start` */
    this._pendingTtsAgent = [];
    this._pendingTtsCustomer = [];
    /** @type {boolean} */
    /** Int16 fragments held until we have full 24 kHz sample triplets for clean 24k→8k downsample */
    this._ttsPcm24TailAgent = Buffer.alloc(0);
    this._ttsPcm24TailCustomer = Buffer.alloc(0);
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
  attachPlivoSocket(role, ws, meta = {}) {
    this.touch();
    const streamId = meta?.streamId ?? null;
    if (role === 'agent') {
      if (this.agentPlivoWs !== ws) {
        this.agentPlivoWs = ws;
        ws.once('close', () => {
          this.onPlivoSocketClosed('agent');
        });
      }
      if (streamId) this.agentStreamId = streamId;
    } else {
      if (this.customerPlivoWs !== ws) {
        this.customerPlivoWs = ws;
        ws.once('close', () => {
          this.onPlivoSocketClosed('customer');
        });
      }
      if (streamId) this.customerStreamId = streamId;
    }
    if (streamId) this.flushPendingTts(role);
  }

  /**
   * Plivo `start` — set inbound codec + stream id (playAudio must target this `streamId`).
   * @param {"agent"|"customer"} leg
   * @param {object} start
   * @param {import('ws').WebSocket} ws
   */
  onPlivoStreamStart(leg, start, ws) {
    const s = start && typeof start === 'object' ? start : {};
    const mf = s.mediaFormat || s.media_format || {};
    const enc = String(mf.encoding || '').toLowerCase();
    if (enc.includes('mulaw')) this.inboundCodec[leg] = 'mulaw';
    else if (enc) this.inboundCodec[leg] = 'l16';

    const streamId = s.streamId || s.stream_uuid || s.streamID || null;
    this.attachPlivoSocket(leg, ws, { streamId });
  }

  /**
   * @param {"agent"|"customer"} role
   */
  flushPendingTts(role) {
    const useMulaw = env.plivoStreamUsesMulaw;
    if (role === 'agent') {
      while (this.agentStreamId && this._pendingTtsAgent.length > 0) {
        const b = this._pendingTtsAgent.shift();
        sendPcm24ToPlivo(this.agentPlivoWs, b, {
          sessionId: this.id,
          listenerLeg: 'agent',
          streamId: this.agentStreamId,
          useMulaw,
        });
      }
    } else {
      while (this.customerStreamId && this._pendingTtsCustomer.length > 0) {
        const b = this._pendingTtsCustomer.shift();
        sendPcm24ToPlivo(this.customerPlivoWs, b, {
          sessionId: this.id,
          listenerLeg: 'customer',
          streamId: this.customerStreamId,
          useMulaw,
        });
      }
    }
  }

  /** @param {"agent"|"customer"} spokeRole RTP source mic */
  ingestPlivoMedia(spokeRole, rawPayload) {
    if (this.closed) return;
    if (!this._openAiWarmed) this.warmTranslators();
    this.touch();

    if (rawPayload.length === 0) return;

    const codec = this.inboundCodec[spokeRole];
    const speech =
      codec === 'mulaw'
        ? isLikelySpeech(rawPayload)
        : pcm16MonoRms(rawPayload) > 480;

    if (
      env.openaiRealtimePipeline === 'sarvam_eleven' &&
      env.pipelineTroubleshootLog &&
      !this._trFirstMediaLog.has(spokeRole)
    ) {
      this._trFirstMediaLog.add(spokeRole);
      const extra =
        codec === 'mulaw'
          ? `mulaw_bytes=${rawPayload.length} likely_speech_mulaw=${isLikelySpeech(rawPayload)}`
          : `pcm16_bytes=${rawPayload.length} likely_speech_l16_rms=${pcm16MonoRms(rawPayload).toFixed(0)}`;
      log.info(
        `[engine] Plivo media first packet session=${this.id} speaker_leg=${spokeRole} codec=${codec} ${extra}`,
      );
    }

    /**
     * Barge-in: clear Plivo playAudio only for the leg that is *speaking*, so we do not
     * cancel the translation the callee is supposed to hear.
     *
     * Example bug: agent talks → TTS to customer while agent mic packets still arrive;
     * clearing "customer" playback here chopped the customer's audio mid-sentence.
     */
    if (spokeRole === 'agent' && this.agentStreamId && speech) {
      this.clearPlivoPlaybackForListener('agent', this.agentStreamId);
    }
    if (spokeRole === 'customer' && speech) {
      if (this.agentStreamId) {
        this.clearPlivoPlaybackForListener('agent', this.agentStreamId);
      }
      if (this.customerStreamId) {
        this.clearPlivoPlaybackForListener('customer', this.customerStreamId);
      }
    }

    const pcm16 =
      codec === 'mulaw' ? decodeMuLawToPcm16(rawPayload) : rawPayload;
    const pcm24 = pcm8kTo24k(pcm16);

    if (spokeRole === 'customer') {
      this.oaiTowardAgent?.appendPcm24kMono(pcm24);
    } else {
      this.oaiTowardCustomer?.appendPcm24kMono(pcm24);
    }
  }

  /**
   * Carry partial PCM across TTS chunks so 24 kHz s16le stays sample-aligned for 3:1 decimation to 8 kHz.
   * @param {"agent"|"customer"} leg
   * @param {Buffer} pcm24kDelta
   * @returns {Buffer}
   */
  _normalizeTtsPcm24ForPlivo(leg, pcm24kDelta) {
    if (!pcm24kDelta?.length) return Buffer.alloc(0);
    const key = leg === 'agent' ? '_ttsPcm24TailAgent' : '_ttsPcm24TailCustomer';
    const merged = Buffer.concat([this[key], pcm24kDelta]);
    let L = merged.length;
    if (L < 2) {
      this[key] = merged;
      return Buffer.alloc(0);
    }
    if (L % 2 === 1) L -= 1;
    const n6 = Math.floor(L / 6) * 6;
    this[key] = merged.subarray(n6);
    return n6 > 0 ? merged.subarray(0, n6) : Buffer.alloc(0);
  }

  /**
   * @param {Buffer} pcm24kDelta mono int16 LE (OpenAI deltas)
   */
  playMuLawOnAgentLeg(pcm24kDelta) {
    const pcm = this._normalizeTtsPcm24ForPlivo('agent', pcm24kDelta);
    if (!pcm.length) return;
    const useMulaw = env.plivoStreamUsesMulaw;
    if (!this.agentStreamId) {
      this._pendingTtsAgent.push(pcm);
      if (
        env.pipelineTroubleshootLog &&
        !this._playDeferredLoggedAgent
      ) {
        this._playDeferredLoggedAgent = true;
        log.warn(
          `[engine] playAudio queued until streamId session=${this.id} listener=agent pcm24_bytes=${pcm.length}`,
        );
      }
      return;
    }
    sendPcm24ToPlivo(this.agentPlivoWs, pcm, {
      sessionId: this.id,
      listenerLeg: 'agent',
      streamId: this.agentStreamId,
      useMulaw,
    });
  }

  playMuLawOnCustomerLeg(pcm24kDelta) {
    const pcm = this._normalizeTtsPcm24ForPlivo('customer', pcm24kDelta);
    if (!pcm.length) return;
    const useMulaw = env.plivoStreamUsesMulaw;
    if (!this.customerStreamId) {
      this._pendingTtsCustomer.push(pcm);
      if (
        env.pipelineTroubleshootLog &&
        !this._playDeferredLoggedCustomer
      ) {
        this._playDeferredLoggedCustomer = true;
        log.warn(
          `[engine] playAudio queued until streamId session=${this.id} listener=customer pcm24_bytes=${pcm.length}`,
        );
      }
      return;
    }
    sendPcm24ToPlivo(this.customerPlivoWs, pcm, {
      sessionId: this.id,
      listenerLeg: 'customer',
      streamId: this.customerStreamId,
      useMulaw,
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
    this._ttsPcm24TailAgent = Buffer.alloc(0);
    this._ttsPcm24TailCustomer = Buffer.alloc(0);
    for (const cb of [...this.destroyListeners]) {
      try {
        cb();
      } catch (_) {}
    }
    this.destroyListeners.clear();
  }
}
