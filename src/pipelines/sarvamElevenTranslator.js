/**
 * Plivo-friendly chain: buffer utterances (RMS silence) → Sarvam STT + translate → ElevenLabs PCM stream.
 * Targets Indian + English pairs via Sarvam `/translate`; other language pairs are not supported.
 */
import { env } from '../config/index.js';
import { log } from '../utils/logger.js';
import { pcm24kTo16k, pcm16leMonoToWav } from '../utils/audioResample.js';
import { pcm16MonoRms } from '../utils/vad.js';
import { iso639ToSarvam, iso639ToSarvamSttHint } from '../utils/sarvamLanguages.js';

const SARVAM = 'https://api.sarvam.ai';

export class SarvamElevenTranslator {
  /**
   * @param {object} opts
   * @param {string} opts.sourceIso639 — spoken language on this leg (e.g. hi, en)
   * @param {string} opts.targetIso639 — language the listener should hear
   * @param {string} opts.elevenLabsVoiceId
   * @param {(pcm24: Buffer) => void} opts.onDeltaPcm
   * @param {(err: Error) => void} [opts.onError]
   * @param {string} [opts.label] — log prefix (cust→agent / agent→cust)
   */
  constructor(opts) {
    this.sourceIso639 = opts.sourceIso639;
    this.targetIso639 = opts.targetIso639;
    this.elevenLabsVoiceId = opts.elevenLabsVoiceId;
    this.onDeltaPcm = opts.onDeltaPcm;
    this.onError = opts.onError || ((_e) => {});
    this.label = opts.label || 'sarvam+11';

    this.closed = false;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.silenceMs = env.pipelineUtteranceSilenceMs;
    this.rmsThreshold = env.pipelineUtteranceRmsThreshold;
    this.maxHoldMs = env.pipelineMaxHoldBeforeFlushMs;
    /** When non-buffer became non-empty — for forced flush of quiet speech */
    this._bufferStartTs = null;
    /** @type {Buffer[]} */
    this.jobQueue = [];
    this._processing = false;
    /** @type {AbortController | null} */
    this._abort = null;

    const bps = (24000 * 2) / 1000;
    this.minPcmBytes = Math.ceil(bps * env.pipelineMinUtteranceMs);
    this.maxPcmBytes = Math.ceil(bps * env.pipelineMaxUtteranceMs);
  }

  connect() {
    const tgt = iso639ToSarvam(this.targetIso639);
    if (!env.sarvamApiKey || !env.elevenlabsApiKey) {
      queueMicrotask(() =>
        this.onError(
          new Error(
            'Sarvam+ElevenLabs pipeline: set SARVAM_API_KEY and ELEVENLABS_API_KEY',
          ),
        ),
      );
      return;
    }
    if (!this.elevenLabsVoiceId) {
      queueMicrotask(() =>
        this.onError(
          new Error(
            'Sarvam+ElevenLabs pipeline: set ELEVENLABS_VOICE_ID (and optional ELEVENLABS_VOICE_EN / _HI)',
          ),
        ),
      );
      return;
    }
    if (!tgt) {
      queueMicrotask(() =>
        this.onError(
          new Error(
            `Sarvam translate does not support target language ISO "${this.targetIso639}" — use en, hi, ta, … (see Sarvam docs).`,
          ),
        ),
      );
      return;
    }
    log.info(`Sarvam+11 translator ready (${this.label}) · target Sarvam=${tgt}`);
  }

  /** @param {Buffer} pcm16le24k mono */
  appendPcm24kMono(pcm16le24k) {
    if (this.closed || !pcm16le24k.length) return;

    const prevLen = this.buffer.length;
    this.buffer = Buffer.concat([this.buffer, pcm16le24k]);
    if (prevLen === 0) this._bufferStartTs = Date.now();

    if (this.buffer.length > this.maxPcmBytes) {
      const cut = this.buffer.length - this.maxPcmBytes;
      this.buffer = this.buffer.subarray(cut);
      this._bufferStartTs = Date.now();
    }

    const loud = pcm16MonoRms(pcm16le24k) > this.rmsThreshold;
    if (loud) {
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = setTimeout(() => this.flushUtterance(), this.silenceMs);
    }

    /* Soft PSTN audio often never crosses a high RMS bar — still cut & send a segment periodically. */
    if (
      this.buffer.length >= this.minPcmBytes &&
      this._bufferStartTs &&
      Date.now() - this._bufferStartTs >= this.maxHoldMs
    ) {
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
      this.flushUtterance();
    }
  }

  flushUtterance() {
    if (this.closed) return;
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this.buffer.length < this.minPcmBytes) return;
    const pcm = Buffer.from(this.buffer);
    this.buffer = Buffer.alloc(0);
    this._bufferStartTs = null;
    this.jobQueue.push(pcm);
    this.drainQueue();
  }

  async drainQueue() {
    if (this._processing || this.jobQueue.length === 0 || this.closed) return;
    this._processing = true;
    const pcm24 = this.jobQueue.shift();
    this._abort = new AbortController();
    try {
      await this.processPcmUtterance(pcm24, this._abort.signal);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Sarvam+11 ${this.label}`, msg);
      this.onError(e instanceof Error ? e : new Error(msg));
    } finally {
      this._abort = null;
      this._processing = false;
      if (!this.closed) this.drainQueue();
    }
  }

  /**
   * @param {Buffer} pcm24
   * @param {AbortSignal} signal
   */
  async processPcmUtterance(pcm24, signal) {
    const targetSarvam = iso639ToSarvam(this.targetIso639);
    if (!targetSarvam) {
      throw new Error(`Unsupported target ISO for Sarvam: ${this.targetIso639}`);
    }

    const pcm16 = pcm24kTo16k(pcm24);
    const wav = pcm16leMonoToWav(pcm16, 16000);
    const sttLang = iso639ToSarvamSttHint(this.sourceIso639);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utt.wav');
    form.append('model', env.sarvamSttModel);
    form.append('language_code', sttLang);

    const tr = await fetch(`${SARVAM}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': env.sarvamApiKey },
      body: form,
      signal,
    });
    const trText = await tr.text();
    if (!tr.ok) {
      throw new Error(`Sarvam STT ${tr.status}: ${trText.slice(0, 500)}`);
    }
    /** @type {{ transcript?: string; language_code?: string | null }} */
    let stt;
    try {
      stt = JSON.parse(trText);
    } catch {
      throw new Error(`Sarvam STT: invalid JSON ${trText.slice(0, 200)}`);
    }
    const raw = (stt.transcript || '').trim();
    if (!raw) {
      log.warn(`Sarvam+11 ${this.label}: STT returned empty transcript (check audio / language_code)`);
      return;
    }

    const sourceMapped = iso639ToSarvam(this.sourceIso639);
    const detected =
      stt.language_code && String(stt.language_code).toLowerCase() !== 'unknown'
        ? String(stt.language_code)
        : null;

    let needsTranslate = true;
    if (detected && detected === targetSarvam) needsTranslate = false;
    if (!detected && sourceMapped && sourceMapped === targetSarvam) needsTranslate = false;

    let line = raw;
    if (needsTranslate) {
      const trBody = {
        input: raw,
        source_language_code: detected || sourceMapped || 'auto',
        target_language_code: targetSarvam,
        model: env.sarvamTranslateModel,
      };
      const tl = await fetch(`${SARVAM}/translate`, {
        method: 'POST',
        headers: {
          'api-subscription-key': env.sarvamApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(trBody),
        signal,
      });
      const tlText = await tl.text();
      if (!tl.ok) {
        throw new Error(`Sarvam translate ${tl.status}: ${tlText.slice(0, 500)}`);
      }
      /** @type {{ translated_text?: string }} */
      let tj;
      try {
        tj = JSON.parse(tlText);
      } catch {
        throw new Error(`Sarvam translate: invalid JSON ${tlText.slice(0, 200)}`);
      }
      line = (tj.translated_text || '').trim() || raw;
    }

    if (!line.trim()) return;

    const u = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}/stream`);
    u.searchParams.set('output_format', 'pcm_24000');

    const el = await fetch(u.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': env.elevenlabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: line,
        ...(env.elevenlabsTtsModel ? { model_id: env.elevenlabsTtsModel } : {}),
      }),
      signal,
    });
    if (!el.ok) {
      const errBody = await el.text();
      throw new Error(`ElevenLabs TTS ${el.status}: ${errBody.slice(0, 500)}`);
    }

    const reader = el.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await el.arrayBuffer());
      if (buf.length) this.onDeltaPcm(buf);
      return;
    }

    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) this.onDeltaPcm(Buffer.from(value));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = null;
    this.jobQueue = [];
    try {
      this._abort?.abort();
    } catch (_) {}
  }
}
