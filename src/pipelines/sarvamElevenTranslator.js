/**
 * Plivo-friendly chain: buffer utterances (RMS silence) → Sarvam STT + translate → ElevenLabs PCM stream.
 * Targets Indian + English pairs via Sarvam `/translate`; other language pairs are not supported.
 */
import { env } from '../config/index.js';
import { log } from '../utils/logger.js';
import { pcm24kTo16k, pcm16leMonoToWav } from '../utils/audioResample.js';
import { pcm16MonoRms, pcm16MonoLoudFrameRatio } from '../utils/vad.js';
import { repairSttMisheardBrand, repairAgentSpokenName } from '../utils/sttBrandRepair.js';
import { looksRomanizedHindi } from '../utils/romanizedHindi.js';
import { iso639ToSarvam, iso639ToSarvamSttHint } from '../utils/sarvamLanguages.js';

const SARVAM = 'https://api.sarvam.ai';

/** Maps internal chunk labels to `[voice→text]` route names. */
function voiceTextRouteHuman(label) {
  if (label === 'cust→agent') return 'customer→agent';
  if (label === 'agent→cust') return 'agent→customer';
  return label;
}

/** Collapse text for duplicate-TTS detection (same phrase → ElevenLabs sounds different each call). */
function normalizeForTtsDedupe(text) {
  return String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    this._appendCount = 0;
    /** @type {{ pcm: Buffer; reason?: string }[]} */
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
    this._silenceFlushMinRms =
      env.pipelineSilenceFlushMinRms > 0
        ? env.pipelineSilenceFlushMinRms
        : Math.max(36, Math.round(this.maxHoldMinRms * 0.88));

    /** agent→customer: fewer STT runs on line tone (Sarvam hallucinations). */
    this._strictAgentToCust =
      this.label === 'agent→cust' && env.pipelineAgentToCustomerStrictStt;
    if (this._strictAgentToCust) {
      const holdMs = env.pipelineAgentToCustomerMaxHoldMs;
      this.maxHoldMs = holdMs > 0 ? holdMs : Number.POSITIVE_INFINITY;
      const ur = env.pipelineAgentToCustomerUtteranceRms;
      if (ur > 0) this.rmsThreshold = ur;
      if (env.pipelineSilenceFlushMinRms <= 0) {
        const floor = env.pipelineAgentToCustomerSilenceFlushFloorRms;
        this._silenceFlushMinRms = Math.max(this._silenceFlushMinRms, floor);
      }
      const stMin = env.pipelineAgentToCustomerSttMinBufferRms;
      this._strictSttMinBufRms =
        stMin > 0 ? stMin : Math.max(this._silenceFlushMinRms + 8, 52);
      this._strictSttMinLoudRatio = Math.max(
        0,
        env.pipelineAgentToCustomerMinLoudFrameRatio,
      );
      this._agentCustMinConsecLoudMs =
        env.pipelineAgentToCustomerMinConsecutiveLoudMs;
      this._agentCustConsecutiveLoudMs = 0;
      this._lastSttCompletedAt = 0;
      const as = env.pipelineAgentToCustomerUtteranceSilenceMs;
      this.silenceMs =
        as > 0 ? as : Math.max(env.pipelineUtteranceSilenceMs, 640);
    } else {
      this._strictSttMinBufRms = 0;
      this._strictSttMinLoudRatio = 0;
      this._agentCustMinConsecLoudMs = 0;
      this._agentCustConsecutiveLoudMs = 0;
      this._lastSttCompletedAt = 0;
    }

    this._ttsDedupeWindowMs = env.pipelineTtsDedupeWindowMs;
    this._ttsDedupeMinChars = env.pipelineTtsDedupeMinChars;
    /** @type {string} */
    this._lastTtsKey = '';
    this._lastTtsAt = 0;
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
  }

  /** @param {Buffer} pcm16le24k mono */
  appendPcm24kMono(pcm16le24k) {
    if (this.closed || this.configInvalid || !pcm16le24k.length) return;

    const prevLen = this.buffer.length;
    this.buffer = Buffer.concat([this.buffer, pcm16le24k]);
    if (prevLen === 0) this._bufferStartTs = Date.now();

    if (this.buffer.length > this.maxPcmBytes) {
      const cut = this.buffer.length - this.maxPcmBytes;
      this.buffer = this.buffer.subarray(cut);
      this._bufferStartTs = Date.now();
    }

    const rms = pcm16MonoRms(pcm16le24k);
    this._appendCount += 1;
    if (env.pipelineVerboseLog && this._appendCount % 20 === 1) {
      log.info(
        `Sarvam+11 [${this.label}] ingest#${this._appendCount} chunk_rms=${rms.toFixed(0)} thresh=${this.rmsThreshold} buf_bytes=${this.buffer.length} hold_age_ms=${this._bufferStartTs ? Date.now() - this._bufferStartTs : 0}`,
      );
    }

    const loud = rms > this.rmsThreshold;
    const chunkMs = (pcm16le24k.length / (24000 * 2)) * 1000;

    if (this._strictAgentToCust && this._agentCustMinConsecLoudMs > 0) {
      if (loud) {
        this._agentCustConsecutiveLoudMs += chunkMs;
      } else {
        this._agentCustConsecutiveLoudMs = 0;
      }
      if (
        loud &&
        this._agentCustConsecutiveLoudMs >= this._agentCustMinConsecLoudMs
      ) {
        if (this._silenceTimer) clearTimeout(this._silenceTimer);
        this._silenceTimer = setTimeout(
          () => this.flushUtterance('silence_after_speech'),
          this.silenceMs,
        );
      }
    } else if (loud) {
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
        this.buffer = Buffer.alloc(0);
        this._bufferStartTs = null;
        return;
      }
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
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
      return;
    }
    const pcm = Buffer.from(this.buffer);
    if (reason === 'silence_after_speech') {
      const bufRms = pcm16MonoRms(pcm);
      if (this._strictAgentToCust) {
        const gap = env.pipelineAgentToCustomerMinMsBetweenStt;
        if (
          gap > 0 &&
          this._lastSttCompletedAt > 0 &&
          Date.now() - this._lastSttCompletedAt < gap
        ) {
          const extra = Math.max(
            0,
            env.pipelineAgentToCustomerCooldownExtraRms,
          );
          const bufRms16 = pcm16MonoRms(pcm24kTo16k(pcm));
          if (bufRms16 < this._strictSttMinBufRms + extra) {
            this.buffer = Buffer.alloc(0);
            this._bufferStartTs = null;
            this._agentCustConsecutiveLoudMs = 0;
            return;
          }
        }
      }
      if (bufRms < this._silenceFlushMinRms) {
        this.buffer = Buffer.alloc(0);
        this._bufferStartTs = null;
        this._agentCustConsecutiveLoudMs = 0;
        return;
      }
    }
    this.buffer = Buffer.alloc(0);
    this._bufferStartTs = null;
    this._agentCustConsecutiveLoudMs = 0;
    this.jobQueue.push({ pcm, reason });
    this.drainQueue();
  }

  async drainQueue() {
    if (this._processing || this.jobQueue.length === 0 || this.closed) return;
    this._processing = true;
    const job = this.jobQueue.shift();
    const pcm24 = job?.pcm;
    const reason = job?.reason ?? 'unknown';
    this._abort = new AbortController();
    try {
      await this.processPcmUtterance(pcm24, reason, this._abort.signal);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Sarvam+11 ${this.label}`, msg);
      this.onError(e instanceof Error ? e : new Error(msg));
    } finally {
      this._abort = null;
      this._processing = false;
      if (!this.closed) this.drainQueue();
    }
  }

  /**
   * @param {Buffer} pcm24
   * @param {string} [reason]
   * @param {AbortSignal} signal
   */
  async processPcmUtterance(pcm24, reason, signal) {
    if (this.configInvalid || !this.elevenLabsVoiceId) return;
    const targetSarvam = iso639ToSarvam(this.targetIso639);
    if (!targetSarvam) {
      throw new Error(`Unsupported target ISO for Sarvam: ${this.targetIso639}`);
    }

    if (!pcm24?.length) return;

    const pcm16 = pcm24kTo16k(pcm24);
    if (this._strictAgentToCust) {
      const wholeRms = pcm16MonoRms(pcm16);
      if (wholeRms < this._strictSttMinBufRms) return;
      if (this._strictSttMinLoudRatio > 0) {
        const ratio = pcm16MonoLoudFrameRatio(pcm16, this.rmsThreshold);
        if (ratio < this._strictSttMinLoudRatio) return;
      }
    }
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
    if (!raw) return;
    if (this._strictAgentToCust) this._lastSttCompletedAt = Date.now();

    const sourceMapped = iso639ToSarvam(this.sourceIso639);
    const detected =
      stt.language_code && String(stt.language_code).toLowerCase() !== 'unknown'
        ? String(stt.language_code)
        : null;

    const sourceEnish = /^en/i.test(String(this.sourceIso639 || ''));
    let textForTranslate = raw;
    if (sourceEnish && env.pipelinePrimaryBrand) {
      const repaired = repairSttMisheardBrand(raw, env.pipelinePrimaryBrand);
      textForTranslate = repaired;
    }
    if (
      sourceEnish &&
      this.label === 'agent→cust' &&
      env.pipelineAgentSpokenName &&
      env.pipelineAgentNameSttAliases
    ) {
      textForTranslate = repairAgentSpokenName(
        textForTranslate,
        env.pipelineAgentSpokenName,
        env.pipelineAgentNameSttAliases,
      );
    }

    if (env.pipelineVoiceTextLog) {
      const route = voiceTextRouteHuman(this.label);
      const extra =
        textForTranslate !== raw ? ` │ normalized=${JSON.stringify(textForTranslate)}` : '';
      log.info(`[voice→text] ${route} │ ${JSON.stringify(raw)}${extra}`);
    }

    // Skip translation only when CRM speaker language and listener target match (same Sarvam locale).
    // Do **not** skip when STT `language_code === target` — wrong detection skips translation and leaves English text for a Hindi leg.
    let needsTranslate = true;
    if (sourceMapped && targetSarvam && sourceMapped === targetSarvam) {
      needsTranslate = false;
    }

    let line = textForTranslate;
    if (needsTranslate) {
      let translateSource = sourceMapped || detected || 'auto';
      if (
        env.pipelineTranslateRomanHindiSourceHi &&
        targetSarvam === 'hi-IN' &&
        sourceEnish &&
        looksRomanizedHindi(textForTranslate)
      ) {
        translateSource = 'hi-IN';
      }

      const trBody = {
        input: textForTranslate,
        source_language_code: translateSource,
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
      line = (tj.translated_text || '').trim() || textForTranslate;
    }

    if (!line.trim()) return;

    if (env.pipelineTranslationConsoleLog) {
      const repairNote =
        textForTranslate !== raw
          ? ` │ STT_repaired=${JSON.stringify(textForTranslate)}`
          : '';
      log.info(
        `TRANSLATION ${this.label} │ STT(${this.sourceIso639})=${JSON.stringify(raw)}${repairNote} │ TTS_text(${this.targetIso639})=${JSON.stringify(line)} │ Sarvam_detected_lang=${detected ?? '?'} │ translate_API=${needsTranslate}`,
      );
    }

    const dedupeKey = normalizeForTtsDedupe(line);
    const now = Date.now();
    if (
      dedupeKey.length >= this._ttsDedupeMinChars &&
      dedupeKey === this._lastTtsKey &&
      now - this._lastTtsAt < this._ttsDedupeWindowMs
    ) {
      return;
    }

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
      let b = buf;
      if (b.length % 2 === 1) b = b.subarray(0, b.length - 1);
      if (b.length) this.onDeltaPcm(b);
      this._lastTtsKey = dedupeKey;
      this._lastTtsAt = Date.now();
      return;
    }

    /** Carry split int16 samples across fetch chunks (avoids misaligned PCM → noise/clicks). */
    let pcmCarry = Buffer.alloc(0);
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        let merged = Buffer.concat([pcmCarry, Buffer.from(value)]);
        const even = merged.length & ~1;
        pcmCarry = merged.subarray(even);
        merged = merged.subarray(0, even);
        if (merged.length) this.onDeltaPcm(merged);
      }
    }
    this._lastTtsKey = dedupeKey;
    this._lastTtsAt = Date.now();
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
