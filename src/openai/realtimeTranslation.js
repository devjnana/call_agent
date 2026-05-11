/**
 * Thin OpenAI Realtime Translation websocket (server-side streaming).
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-translation
 */
import WebSocket from 'ws';
import { env } from '../config/index.js';
import { log } from '../utils/logger.js';

export class OpenAiRealtimeTranslation {
  /**
   * @param {object} opts
   * @param {string} opts.outputLanguageTag — ISO-ish tag (en, hi, …)
   * @param {(pcm24k: Buffer) => void} opts.onDeltaPcm
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.outputLanguageTag = opts.outputLanguageTag;
    this.onDeltaPcm = opts.onDeltaPcm;
    this.onError = opts.onError || ((_e) => {});
    /** @type {WebSocket | null} */
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.queue = [];
  }

  connect() {
    if (this.ws || this.closed) return;

    const model = encodeURIComponent(env.openaiRealtimeModel);
    const uri = `wss://api.openai.com/v1/realtime/translations?model=${model}`;
    const headers = {
      Authorization: `Bearer ${env.openaiApiKey}`,
    };
    if (env.openaiSafetyIdentifier) {
      headers['OpenAI-Safety-Identifier'] = env.openaiSafetyIdentifier;
    }
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
          audio: {
            output: {
              language: this.outputLanguageTag,
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
        case 'session.output_audio.delta': {
          if (!msg.delta) return;
          const buf = Buffer.from(msg.delta, 'base64');
          this.onDeltaPcm(buf);
          break;
        }
        case 'error': {
          const errMsg = msg.error?.message || JSON.stringify(msg.error || msg);
          log.warn('OpenAI translation error:', errMsg);
          this.onError(new Error(errMsg));
          break;
        }
        default:
          break;
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      if (!this.closed) log.warn('OpenAI translation socket closed');
    });

    this.ws.on('error', (err) => {
      log.error('OpenAI translation socket:', err.message);
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

  /**
   * @param {Buffer} pcm16le24k mono
   */
  appendPcm24kMono(pcm16le24k) {
    if (this.closed) return;
    const b64 = pcm16le24k.toString('base64');
    this.sendJson({
      type: 'session.input_audio_buffer.append',
      audio: b64,
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch (_) {}
    this.ws = null;
    this.connected = false;
  }
}
