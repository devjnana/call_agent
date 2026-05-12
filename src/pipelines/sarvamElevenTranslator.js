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
    /** Set in `connect()` when voice id / Sarvam target invalid — do not run STT/TTS. */
    this.configInvalid = false;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.silenceMs = env.pipelineUtteranceSilenceMs;
    this.rmsThreshold = env.pipelineUtteranceRmsThreshold;
    this.maxHoldMs = env.pipelineMaxHoldBeforeFlushMs;
    /** When buffer became non-empty — for forced flush of quiet speech */
    this._bufferStartTs = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._silenceTimer = null;
    this._loggedFirstIngress = false;
    this._appendCount = 0;
    /** @type {Buffer[]} */
    this.jobQueue = [];
    this._processing = false;
    /** @type {AbortController | null} */
    this._abort = null;

    const bps = (24000 * 2) / 1000;
    this.minPcmBytes = Math.ceil(bps * env.pipelineMinUtteranceMs);
    this.maxPcmBytes = Math.ceil(bps * env.pipelineMaxUtteranceMs);
    /** Min RMS over the full pending buffer before max-hold may call STT (blocks noise/silence hallucination loops). */
    this.maxHoldMinRms =
      env.pipelineMaxHoldMinRms > 0
        ? env.pipelineMaxHoldMinRms
        : Math.max(45, Math.round(this.rmsThreshold * 0.45));
  }

  connect() {
    const tgt = iso639ToSarvam(this.targetIso639);
    if (!env.sarvamApiKey || !env.elevenlabsApiKey) {
      this.configInvalid = true;
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
      this.configInvalid = true;
      queueMicrotask(() =>
        this.onError(
          new Error(
            'Sarvam+ElevenLabs pipeline: set ELEVENLABS_VOICE_ID and/or per-language ELEVENLABS_VOICE_EN, ELEVENLABS_VOICE_HI (agent hears EN → need VOICE_EN or VOICE_ID).',
          ),
        ),
      );
      return;
    }
    if (!tgt) {
      this.configInvalid = true;
      queueMicrotask(() =>
        this.onError(
          new Error(
            `Sarvam translate does not support target language ISO "${this.targetIso639}" — use en, hi, ta, … (see Sarvam docs).`,
          ),
        ),
      );
      return;
    }
    log.info(
      `Sarvam+11 translator ready (${this.label}) · Sarvam=${tgt} · eleven_voice=${String(this.elevenLabsVoiceId).slice(0, 8)}… · rms≥${this.rmsThreshold} silenceMs=${this.silenceMs} minClipMs=${env.pipelineMinUtteranceMs} maxHoldMs=${this.maxHoldMs} maxHoldMinBufRms=${this.maxHoldMinRms} troubleshoot=${env.pipelineTroubleshootLog}`,
    );
  }

  /** @param {Buffer} pcm16le24k mono */
  appendPcm24kMono(pcm16le24k) {
    if (this.closed || this.configInvalid || !pcm16le24k.length) return;

    if (env.pipelineTroubleshootLog && !this._loggedFirstIngress) {
      this._loggedFirstIngress = true;
      log.info(
        `Sarvam+11 [${this.label}] first PCM24 ingress chunk_bytes=${pcm16le24k.length} (Plivo→STT path live)`,
      );
    }

    const prevLen = this.buffer.length;
    this.buffer = Buffer.concat([this.buffer, pcm16le24k]);
    if (prevLen === 0) this._bufferStartTs = Date.now();

    if (this.buffer.length > this.maxPcmBytes) {
      const cut = this.buffer.length - this.maxPcmBytes;
      this.buffer = this.buffer.subarray(cut);
      this._bufferStartTs = Date.now();
      if (env.pipelineTroubleshootLog) {
        log.warn(`Sarvam+11 [${this.label}] ring buffer trimmed (max ${this.maxPcmBytes}b)`);
      }
    }

    const rms = pcm16MonoRms(pcm16le24k);
    this._appendCount += 1;
    if (env.pipelineVerboseLog && this._appendCount % 20 === 1) {
      log.info(
        `Sarvam+11 [${this.label}] ingest#${this._appendCount} chunk_rms=${rms.toFixed(0)} thresh=${this.rmsThreshold} buf_bytes=${this.buffer.length} hold_age_ms=${this._bufferStartTs ? Date.now() - this._bufferStartTs : 0}`,
      );
    }

    const loud = rms > this.rmsThreshold;
    if (loud) {
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = setTimeout(
        () => this.flushUtterance('silence_after_speech'),
        this.silenceMs,
      );
    }

    /* Soft PSTN audio often never crosses a high RMS bar — still cut & send a segment periodically. */
    if (
      this.buffer.length >= this.minPcmBytes &&
      this._bufferStartTs &&
      Date.now() - this._bufferStartTs >= this.maxHoldMs
    ) {
      const bufRms = pcm16MonoRms(this.buffer);
      if (bufRms < this.maxHoldMinRms) {
        if (this._silenceTimer) clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
        if (env.pipelineTroubleshootLog) {
          log.info(
            `Sarvam+11 [${this.label}] max_hold dropped (quiet buffer) buf_rms=${bufRms.toFixed(1)} need≥${this.maxHoldMinRms}`,
          );
        }
        this.buffer = Buffer.alloc(0);
        this._bufferStartTs = null;
        return;
      }
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
      if (env.pipelineTroubleshootLog) {
        log.info(
          `Sarvam+11 [${this.label}] max_hold ${this.maxHoldMs}ms elapsed → flush buf_rms=${bufRms.toFixed(1)}`,
        );
      }
      this.flushUtterance('max_hold');
    }
  }

  /**
   * @param {'silence_after_speech' | 'max_hold' | string} [reason]
   */
  flushUtterance(reason = 'unknown') {
    if (this.closed) return;
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this.buffer.length < this.minPcmBytes) {
      if (
        env.pipelineTroubleshootLog &&
        (this.buffer.length > 0 ||
          reason === 'silence_after_speech' ||
          reason === 'max_hold')
      ) {
        log.info(
          `Sarvam+11 [${this.label}] flush skipped reason=${reason} buf_bytes=${this.buffer.length} min_bytes=${this.minPcmBytes} (~need ${env.pipelineMinUtteranceMs}ms@24kHz)`,
        );
      }
      return;
    }
    const pcm = Buffer.from(this.buffer);
    const msAudio = Math.round(((pcm.length / 2) * 1000) / 24000);
    this.buffer = Buffer.alloc(0);
    this._bufferStartTs = null;
    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] flush → queue reason=${reason} pcm24_bytes=${pcm.length} ~${msAudio}ms_audio`,
      );
    }
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
    if (this.configInvalid || !this.elevenLabsVoiceId) return;
    const targetSarvam = iso639ToSarvam(this.targetIso639);
    if (!targetSarvam) {
      throw new Error(`Unsupported target ISO for Sarvam: ${this.targetIso639}`);
    }

    const pcm16 = pcm24kTo16k(pcm24);
    const wav = pcm16leMonoToWav(pcm16, 16000);
    const sttLang = iso639ToSarvamSttHint(this.sourceIso639);

    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] STT POST wav_bytes=${wav.length} pcm16@16k=${pcm16.length}b pcm24_in=${pcm24.length}b model=${env.sarvamSttModel} language_code=${sttLang}`,
      );
    }

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
    /** @type {{ transcript?: string; language_code?: string | null; error?: unknown }} */
    let stt;
    try {
      stt = JSON.parse(trText);
    } catch {
      throw new Error(`Sarvam STT: invalid JSON ${trText.slice(0, 200)}`);
    }
    if (stt.error) {
      throw new Error(`Sarvam STT error field: ${JSON.stringify(stt.error)}`);
    }
    const raw = (stt.transcript || '').trim();
    if (!raw) {
      log.warn(
        `Sarvam+11 [${this.label}] STT empty transcript · wav=${wav.length}b lang_hint=${sttLang} snip=${trText.slice(0, 280).replace(/\s+/g, ' ')}`,
      );
      return;
    }

    const sourceMapped = iso639ToSarvam(this.sourceIso639);
    const detected =
      stt.language_code && String(stt.language_code).toLowerCase() !== 'unknown'
        ? String(stt.language_code)
        : null;

    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] STT OK len=${raw.length} detected_lang=${detected ?? String(stt.language_code ?? '')} snippet=${JSON.stringify(raw.slice(0, 96))}`,
      );
    }

    // Skip translation only when CRM speaker language and listener target match (same Sarvam locale).
    // Do **not** skip when STT `language_code === target` — wrong detection skips translation and leaves English text for a Hindi leg.
    let needsTranslate = true;
    if (sourceMapped && targetSarvam && sourceMapped === targetSarvam) {
      needsTranslate = false;
    }

    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] translate_gate needs=${needsTranslate} sourceMapped=${sourceMapped ?? 'null'} target=${targetSarvam} stt_detected=${detected ?? 'null'}`,
      );
    }
    let line = raw;
    if (needsTranslate) {
      const trBody = {
        input: raw,
        source_language_code: sourceMapped || detected || 'auto',
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
      if (
        needsTranslate &&
        line === raw &&
        targetSarvam &&
        targetSarvam !== 'en-IN'
      ) {
        log.warn(
          `Sarvam+11 [${this.label}] translate returned same text as transcript — check Sarvam response, source=${trBody.source_language_code} target=${targetSarvam}`,
        );
      }
    }

    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] ElevenLabs request text_chars=${line.length} translate_used=${needsTranslate} snippet=${JSON.stringify(line.slice(0, 120))}`,
      );
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

    const elType = el.headers.get('content-type') || '?';
    if (env.pipelineTroubleshootLog) {
      log.info(`Sarvam+11 [${this.label}] ElevenLabs response content-type=${elType}`);
    }

    const reader = el.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await el.arrayBuffer());
      let b = buf;
      if (b.length % 2 === 1) b = b.subarray(0, b.length - 1);
      if (b.length) this.onDeltaPcm(b);
      if (env.pipelineTroubleshootLog) {
        log.info(`Sarvam+11 [${this.label}] ElevenLabs body (non-stream) pcm24_bytes=${buf.length}`);
      }
      return;
    }

    /** Carry split int16 samples across fetch chunks (avoids misaligned PCM → noise/clicks). */
    let pcmCarry = Buffer.alloc(0);
    let streamed = 0;
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        streamed += value.length;
        let merged = Buffer.concat([pcmCarry, Buffer.from(value)]);
        const even = merged.length & ~1;
        pcmCarry = merged.subarray(even);
        merged = merged.subarray(0, even);
        if (merged.length) this.onDeltaPcm(merged);
      }
    }
    if (env.pipelineTroubleshootLog) {
      log.info(
        `Sarvam+11 [${this.label}] ElevenLabs stream done total_pcm24_bytes=${streamed} (callbacks to playAudio should follow)`,
      );
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
