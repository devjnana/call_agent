/**
 * Centralized environment loader with sane defaults for the translation engine.
 */
import 'dotenv/config';

function req(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function reqNum(name, fallback) {
  const v = Number(req(name));
  return Number.isFinite(v) ? v : fallback;
}

function normalizeBaseUrl(url) {
  return (url || '').replace(/\/$/, '');
}

function normalizePipeline(v) {
  const k = String(v || '').trim().toLowerCase();
  if (k === 'voice' || k === 'interpreter') return 'voice';
  if (k === 'sarvam_eleven' || k === 'sarvam' || k === 'sarvam+eleven') return 'sarvam_eleven';
  return 'translation';
}

/**
 * Voice interpreter connects to `wss://api.openai.com/v1/realtime?model=…`.
 * Default: **gpt-4o-realtime-preview** — aliases and fallbacks include mini + `gpt-realtime*` slugs
 * (API may entitle different models per account; Realtime is **not** available on the API “Free” usage tier).
 *
 * @see https://developers.openai.com/api/docs/models/gpt-4o-realtime-preview
 */
function buildOpenAiVoiceModelChain() {
  const primary = req('OPENAI_VOICE_REALTIME_MODEL', 'gpt-4o-realtime-preview');
  const fallbacks = req(
    'OPENAI_VOICE_REALTIME_MODEL_FALLBACKS',
    [
      'gpt-4o-mini-realtime-preview',
      'gpt-realtime',
      'gpt-realtime-mini',
      'gpt-4o-realtime-preview-2025-06-03',
      'gpt-4o-realtime-preview-2024-12-17',
      'gpt-4o-realtime-preview-2024-10-01',
    ].join(','),
  );
  const parts = [primary, ...String(fallbacks).split(',')]
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.length ? out : ['gpt-4o-realtime-preview'];
}

const _voiceChain = buildOpenAiVoiceModelChain();

export const env = {
  port: reqNum('PORT', 3000),
  /** HTTPS base for Plivo answer/hangup webhooks */
  baseUrl: normalizeBaseUrl(req('BASE_URL', 'http://127.0.0.1:3000')),
  /** WSS origin for bidirectional streams (must be reachable by Plivo) */
  wsBaseUrl: normalizeBaseUrl(req('WS_BASE_URL', 'ws://127.0.0.1:3000')),
  openaiApiKey: req('OPENAI_API_KEY'),
  /**
   * `translation`: `/v1/realtime/translations` + `gpt-realtime-translate` (needs paid tier · not FREE).
   * `voice`: `/v1/realtime` + model chain (interpreter persona · turn-based VAD).
   * `sarvam_eleven`: Sarvam STT + Sarvam text translate + ElevenLabs streaming TTS (no OpenAI).
   */
  openaiRealtimePipeline: normalizePipeline(req('OPENAI_REALTIME_PIPELINE')),
  openaiTranslationModel: req(
    'OPENAI_TRANSLATION_MODEL',
    req('OPENAI_REALTIME_MODEL', 'gpt-realtime-translate'),
  ),
  /** Ordered list for voice interpreter (primary OPENAI_VOICE_REALTIME_MODEL + fallbacks). */
  openaiVoiceModelChain: _voiceChain,
  /** First model in `openaiVoiceModelChain` — backwards compat / quick logs */
  openaiVoiceRealtimeModel: _voiceChain[0],
  /** `semantic_vad` or `server_vad` · voice pipeline only */
  openaiVoiceVadKind: req('OPENAI_VOICE_VAD_KIND', 'server_vad'),
  openaiSafetyIdentifier: req('OPENAI_SAFETY_IDENTIFIER', ''),
  plivoAuthId: req('PLIVO_AUTH_ID'),
  plivoAuthToken: req('PLIVO_AUTH_TOKEN'),
  plivoCallerId: req('PLIVO_PHONE_NUMBER'),
  plivoValidateSignatures: req('PLIVO_VALIDATE_SIGNATURES', 'false') === 'true',
  /**
   * Plivo `<Conference muted>`: that leg does **not transmit** into its conference room.
   * Agent and customer join **different** rooms (`conferenceRoomName(id, leg)`), so they never hear each other’s raw voice on the bridge.
   * Default **false** so the bidirectional Stream still receives mic RTP. Set **true** only if you also need to suppress mic→bridge.
   */
  plivoConferenceMuted:
    String(req('PLIVO_CONFERENCE_MUTED', 'false')).toLowerCase() === 'true',
  /** Plivo Stream REST: `inbound` (default) or `both` if inbound gives silence in conference. */
  plivoStreamAudioTrack: req('PLIVO_STREAM_AUDIO_TRACK', 'inbound'),
  customerDialDelayMs: reqNum('CUSTOMER_DIAL_DELAY_MS', 400),
  sessionIdleTtlMs: reqNum('SESSION_IDLE_TTL_MS', 2 * 60 * 60 * 1000),
  callSetupTimeoutMs: reqNum('CALL_SETUP_TIMEOUT_MS', 120000),

  /** Sarvam + ElevenLabs phone pipeline */
  sarvamApiKey: req('SARVAM_API_KEY'),
  sarvamSttModel: req('SARVAM_STT_MODEL', 'saarika:v2.5'),
  sarvamTranslateModel: req('SARVAM_TRANSLATE_MODEL', 'mayura:v1'),
  elevenlabsApiKey: req('ELEVENLABS_API_KEY'),
  elevenlabsTtsModel: req('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
  /** Utterance chunking for REST STT (RMS silence gate, Plivo 8 kHz upsampled to 24 kHz). */
  pipelineUtteranceSilenceMs: reqNum('PIPELINE_UTTERANCE_SILENCE_MS', 420),
  pipelineMinUtteranceMs: reqNum('PIPELINE_MIN_UTTERANCE_MS', 100),
  pipelineMaxUtteranceMs: reqNum('PIPELINE_MAX_UTTERANCE_MS', 15000),
  /** Int16 PCM RMS — telco audio is often quiet; 380 was too high and blocked all flushes. */
  pipelineUtteranceRmsThreshold: reqNum('PIPELINE_UTTERANCE_RMS', 95),
  /**
   * If RMS never crosses the threshold (very soft speech), still flush after this many ms of audio
   * in the buffer so Sarvam STT still runs.
   */
  pipelineMaxHoldBeforeFlushMs: reqNum('PIPELINE_MAX_HOLD_BEFORE_FLUSH_MS', 3200),

  /** Sarvam+11 milestones: flush, STT/TTS/playAudio skips. Default true; set PIPELINE_TROUBLESHOOT_LOG=false to mute. */
  pipelineTroubleshootLog:
    String(req('PIPELINE_TROUBLESHOOT_LOG', 'true')).toLowerCase() === 'true',
  /** Frequent RMS / buffer dumps (PIPELINE_VERBOSE_LOG=true). */
  pipelineVerboseLog: String(req('PIPELINE_VERBOSE_LOG', 'false')).toLowerCase() === 'true',

  /**
   * Per-listener voice: `ELEVENLABS_VOICE_EN`, `ELEVENLABS_VOICE_HI`, … else `ELEVENLABS_VOICE_ID`.
   * @param {string} [iso639]
   */
  elevenLabsVoiceIdForIso(iso639) {
    const k = String(iso639 || '').toLowerCase().slice(0, 2);
    const fromEnv = process.env[`ELEVENLABS_VOICE_${k.toUpperCase()}`];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') return String(fromEnv).trim();
    return req('ELEVENLABS_VOICE_ID', '');
  },
};

export function assertEnvForRuntime() {
  const missing = [];
  if (env.openaiRealtimePipeline !== 'sarvam_eleven' && !env.openaiApiKey) {
    missing.push('OPENAI_API_KEY');
  }
  if (!env.plivoAuthId) missing.push('PLIVO_AUTH_ID');
  if (!env.plivoAuthToken) missing.push('PLIVO_AUTH_TOKEN');
  if (!env.plivoCallerId) missing.push('PLIVO_PHONE_NUMBER');
  if (!env.baseUrl) missing.push('BASE_URL');
  if (!env.wsBaseUrl) missing.push('WS_BASE_URL');
  if (missing.length) {
    console.warn(`[boot] Missing env (some features offline): ${missing.join(', ')}`);
  }

  console.info(
    `[boot] PLIVO_CONFERENCE_MUTED=${env.plivoConferenceMuted} · PLIVO_STREAM_AUDIO_TRACK=${env.plivoStreamAudioTrack} (agent/customer use separate conference rooms — no raw cross-talk)`,
  );
  const p = env.openaiRealtimePipeline;
  if (p === 'voice') {
    console.info(
      `[boot] OPENAI_REALTIME_PIPELINE=voice • models (try until one accepts): ${env.openaiVoiceModelChain.join(' → ')} · VAD=${env.openaiVoiceVadKind}`,
    );
  } else if (p === 'sarvam_eleven') {
    console.info(
      `[boot] OPENAI_REALTIME_PIPELINE=sarvam_eleven • Sarvam STT (${env.sarvamSttModel}) + translate (${env.sarvamTranslateModel}) + ElevenLabs (${env.elevenlabsTtsModel})`,
    );
    if (!env.sarvamApiKey) console.warn('[boot] SARVAM_API_KEY missing — pipeline will error until set');
    if (!env.elevenlabsApiKey) console.warn('[boot] ELEVENLABS_API_KEY missing — pipeline will error until set');
    const vid = String(process.env.ELEVENLABS_VOICE_ID || '').trim();
    const ven = String(process.env.ELEVENLABS_VOICE_EN || '').trim();
    const vhi = String(process.env.ELEVENLABS_VOICE_HI || '').trim();
    if (!vid && (!ven || !vhi)) {
      console.warn(
        '[boot] ElevenLabs: set ELEVENLABS_VOICE_ID (single voice for every leg) **or** both ELEVENLABS_VOICE_EN and ELEVENLABS_VOICE_HI for Hindi↔English. Missing EN voice → agent hears nothing (cust→agent).',
      );
    }
    if (env.pipelineTroubleshootLog) {
      console.info('[boot] PIPELINE_TROUBLESHOOT_LOG=true — Sarvam+11 will log flush/STT/TTS/playAudio details');
    }
    if (env.pipelineVerboseLog) {
      console.info('[boot] PIPELINE_VERBOSE_LOG=true — extra per-chunk RMS logs');
    }
  } else {
    console.info(
      `[boot] OPENAI_REALTIME_PIPELINE=translation • model=${env.openaiTranslationModel} (/v1/realtime/translations — requires billed access; GPT Realtime Translate is unavailable on FREE tier per OpenAI docs)`,
    );
  }
}
