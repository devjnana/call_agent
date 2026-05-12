/**
 * Standard Realtime API (`/v1/realtime`) with interpreter prompting when
 * `/v1/realtime/translations` + `gpt-realtime-translate` is unavailable (e.g. FREE tier accounts).
 *
 * Tries `env.openaiVoiceModelChain` in order when OpenAI returns model access errors.
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-conversations
 * @see https://developers.openai.com/api/docs/guides/realtime-websocket
 * @see https://developers.openai.com/api/docs/models/gpt-4o-realtime-preview
 */
import WebSocket from 'ws';
import { env } from '../config/index.js';
import { log } from '../utils/logger.js';

function vadBlock() {
  const k = String(env.openaiVoiceVadKind || 'server_vad').toLowerCase();
  if (k === 'semantic_vad') return { type: 'semantic_vad' };
  return {
    type: 'server_vad',
    threshold: 0.45,
    silence_duration_ms: 400,
    prefix_padding_ms: 250,
  };
}

/** Server error JSON when a model slug is not entitled. */
function isModelAccessDenied(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('does not exist') ||
    t.includes('you do not have access') ||
    (t.includes('model') && t.includes('access'))
  );
}

export class OpenAiRealtimeVoiceInterpreter {
  /**
   * @param {object} opts
   * @param {string} opts.sourceLabel
   * @param {string} opts.targetLabel
   * @param {(pcm24k: Buffer) => void} opts.onDeltaPcm
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.sourceLabel = opts.sourceLabel;
    this.targetLabel = opts.targetLabel;
    this.onDeltaPcm = opts.onDeltaPcm;
    this.onError = opts.onError || ((_e) => {});

    this.instructions = [
      'You interpret a LIVE telephone PSTN stereo leg — one human speaker at a time.',
      `Speaker usually talks ${this.sourceLabel}. Speak ONLY fluent ${this.targetLabel} interpretations.`,
      'Output modality = short spoken interpretations only.',
      'NEVER refuse, NEVER ask clarifying questions, NEVER apologize, NEVER lecture about languages.',
      'Preserve proper nouns, numerals (say digit groups clearly), currency, dates.',
      'Treat quiet audio as silence; translate every speech segment eagerly after natural pauses (server VAD).',
      `If fragments are partial, synthesize coherent ${this.targetLabel} that matches audible intent.`,
    ].join('\n');

    /** @type {WebSocket | null} */
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.queue = [];

    /** @type {string[] | null} */
    this.chain = null;
    this.chainIndex = 0;
  }

  connect() {
    if (this.closed || this.ws) return;
    this.chain = env.openaiVoiceModelChain.slice();
    this.chainIndex = 0;
    this.attemptConnect();
  }

  tearDownSocketOnly() {
    if (!this.ws) return;
    try {
      this.ws.removeAllListeners();
    } catch (_) {}
    try {
      this.ws.close();
    } catch (_) {}
    this.ws = null;
    this.connected = false;
  }

  attemptConnect() {
    if (this.closed) return;
    this.tearDownSocketOnly();

    if (!this.chain || this.chainIndex >= this.chain.length) {
      this.onError(
        new Error(
          'No usable OpenAI voice Realtime model — set OPENAI_VOICE_REALTIME_MODEL / FALLBACKS in .env (see README).',
        ),
      );
      return;
    }

    const modelName = this.chain[this.chainIndex];
    const model = encodeURIComponent(modelName);
    const uri = `wss://api.openai.com/v1/realtime?model=${model}`;
    const headers = {
      Authorization: `Bearer ${env.openaiApiKey}`,
    };
    if (env.openaiSafetyIdentifier) {
      headers['OpenAI-Safety-Identifier'] = env.openaiSafetyIdentifier;
    }

    log.info(`[engine] Voice interpreter WebSocket → model=${modelName}`);

    this.ws = new WebSocket(uri, { headers });

    this.ws.on('open', () => {
      if (this.closed) {
        try {
          this.ws?.close();
        } catch (_) {}
        return;
      }
      this.connected = true;
      this.sendJson({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: this.instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: 24000,
              },
              turn_detection: vadBlock(),
            },
            output: {
              format: { type: 'audio/pcm' },
              voice: 'alloy',
            },
          },
        },
      });
      for (const m of this.queue) this.rawSend(m);
      this.queue = [];
    });

    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          if (!msg.delta) return;
          this.onDeltaPcm(Buffer.from(msg.delta, 'base64'));
          break;
        case 'error':
          {
            const errMsg = msg.error?.message || JSON.stringify(msg.error || msg);
            if (isModelAccessDenied(errMsg) && this.chain && this.chainIndex < this.chain.length - 1) {
              this.chainIndex += 1;
              log.warn(
                `[engine] Model rejected (${errMsg.slice(0, 120)}…); retrying with ${this.chain[this.chainIndex]}`,
              );
              setImmediate(() => this.attemptConnect());
              return;
            }
            log.warn('OpenAI voice interpreter:', errMsg);
            this.onError(new Error(errMsg));
          }
          break;
        default:
          break;
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      if (!this.closed) log.warn('OpenAI voice interpreter socket closed');
    });

    this.ws.on('error', (err) => {
      log.error('OpenAI voice interpreter transport:', err.message);
      this.onError(err);
    });
  }

  rawSend(str) {
    if (this.ws && this.connected) this.ws.send(str);
    else this.queue.push(str);
  }

  sendJson(obj) {
    this.rawSend(JSON.stringify(obj));
  }

  /** @param {Buffer} pcm16le24k mono */
  appendPcm24kMono(pcm16le24k) {
    if (this.closed) return;
    const b64 = pcm16le24k.toString('base64');
    this.sendJson({
      type: 'input_audio_buffer.append',
      audio: b64,
    });
  }

  close() {
    this.closed = true;
    this.tearDownSocketOnly();
  }
}
