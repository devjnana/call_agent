import { decodeMuLawToPcm16 } from '../utils/mulaw.js';
import { pcm8kTo24k, openAiPcmToPlivoMuLaw } from '../utils/audioResample.js';
import { isLikelySpeech } from '../utils/vad.js';
import { log } from '../utils/logger.js';
import { OpenAiRealtimeTranslation } from '../openai/realtimeTranslation.js';

/**
 * Bridges two muted conference legs with independent OpenAI Realtime translators.
 */
export class TranslationSession {
  /**
   * @param {object} p
   * @param {string} p.id
   * @param {string} p.agentE164
   * @param {string} p.customerE164
   * @param {string} p.toAgentTag
   * @param {string} p.toCustomerTag
   */
  constructor(p) {
    this.id = p.id;
    this.agentE164 = p.agentE164;
    this.customerE164 = p.customerE164;
    this.toAgentTag = p.toAgentTag;
    this.toCustomerTag = p.toCustomerTag;

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

    /** @type {OpenAiRealtimeTranslation | null} */
    this.oaiTowardAgent = null;
    /** @type {OpenAiRealtimeTranslation | null} */
    this.oaiTowardCustomer = null;

    this.customerDialStarted = false;
    this.closed = false;
    this.lastActivityMs = Date.now();
    /** @type {Set<() => void>} */
    this.destroyListeners = new Set();
    /** @type {boolean} */
    this._openAiWarmed = false;
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

    this.oaiTowardAgent = new OpenAiRealtimeTranslation({
      outputLanguageTag: this.toAgentTag,
      onDeltaPcm: (pcm24delta) => this.playMuLawOnAgentLeg(pcm24delta),
      onError: (e) => log.warn('OpenAI cust→agent', this.id, e.message),
    });
    this.oaiTowardCustomer = new OpenAiRealtimeTranslation({
      outputLanguageTag: this.toCustomerTag,
      onDeltaPcm: (pcm24delta) => this.playMuLawOnCustomerLeg(pcm24delta),
      onError: (e) => log.warn('OpenAI agent→cust', this.id, e.message),
    });

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
    if (!this.agentPlivoWs || this.agentPlivoWs.readyState !== 1) return;
    const mu = openAiPcmToPlivoMuLaw(pcm24kDelta).toString('base64');
    this.agentPlivoWs.send(JSON.stringify({
      event: 'playAudio',
      media: {
        contentType: 'audio/x-mulaw',
        sampleRate: '8000',
        payload: mu,
      },
    }));
  }

  playMuLawOnCustomerLeg(pcm24kDelta) {
    if (!this.customerPlivoWs || this.customerPlivoWs.readyState !== 1) return;
    const mu = openAiPcmToPlivoMuLaw(pcm24kDelta).toString('base64');
    this.customerPlivoWs.send(JSON.stringify({
      event: 'playAudio',
      media: {
        contentType: 'audio/x-mulaw',
        sampleRate: '8000',
        payload: mu,
      },
    }));
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
