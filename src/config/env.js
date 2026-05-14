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

const _pipelineUtteranceRms = reqNum('PIPELINE_UTTERANCE_RMS', 95);

/** Plivo Stream `content_type` + derived flag (must match `playAudio` codec). */
const _plivoStreamCt = req('PLIVO_STREAM_CONTENT_TYPE', 'audio/x-l16;rate=8000');

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
  /**
   * Must match `playAudio` encoding. Plivo defaults to linear PCM; µ-law works if set explicitly.
   * @see https://www.plivo.com/docs/voice/api/audio-stream/initiate-an-audio-stream/
   */
  plivoStreamContentType: _plivoStreamCt,
  /** True when stream uses G.711 µ-law (otherwise 8 kHz s16le linear PCM). */
  plivoStreamUsesMulaw: String(_plivoStreamCt).toLowerCase().includes('mulaw'),
  /**
   * Plivo `playAudio`: frame size in ms of 24 kHz mono TTS before downsample to 8 kHz.
   * ~40–60 ms can feel smoother / less bursty than 75 ms; must stay 6-byte aligned internally (derived).
   */
  pipelinePlivoPlayaudioChunkMs: Math.min(
    120,
    Math.max(28, reqNum('PIPELINE_PLAYAUDIO_CHUNK_MS', 75)),
  ),
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
  pipelineUtteranceRmsThreshold: _pipelineUtteranceRms,
  /**
   * L16 ingress: RMS per Plivo chunk to treat as “speech” for barge-in `clearAudio`. Must align with PIPELINE_UTTERANCE_RMS
   * (formerly a hard-coded 480, which blocked real speech and behaved inconsistently vs Sarvam’s ~95 RMS scale).
   * Set PIPELINE_BARGE_IN_L16_RMS to override.
   */
  pipelineBargeInL16MinRms: req('PIPELINE_BARGE_IN_L16_RMS')
    ? reqNum('PIPELINE_BARGE_IN_L16_RMS', _pipelineUtteranceRms)
    : _pipelineUtteranceRms,
  /**
   * Minimum ms between outbound `clearAudio` to the same Plivo listener (limits echo-driven clear storms).
   */
  pipelineClearAudioDebounceMs: reqNum('PIPELINE_CLEAR_AUDIO_DEBOUNCE_MS', 280),
  /**
   * When set (e.g. Saasgold), English STT lines get `Sanskrit`/`Sanscrit` → this string before Sarvam translate.
   */
  pipelinePrimaryBrand: String(req('PIPELINE_PRIMARY_BRAND', '') || '').trim(),
  /**
   * If RMS never crosses the threshold (very soft speech), still flush after this many ms of audio
   * in the buffer so Sarvam STT still runs.
   */
  pipelineMaxHoldBeforeFlushMs: reqNum('PIPELINE_MAX_HOLD_BEFORE_FLUSH_MS', 3200),
  /**
   * Sarvam+11: min whole-buffer RMS (int16) before max-hold can run STT. Stops silence/comfort-noise
   * from being sent every PIPELINE_MAX_HOLD_BEFORE_FLUSH_MS (avoids repeated bogus TTS). 0 = auto from PIPELINE_UTTERANCE_RMS.
   */
  pipelineMaxHoldMinRms: reqNum('PIPELINE_MAX_HOLD_MIN_RMS', 0),
  /**
   * Sarvam+11: skip ElevenLabs when normalized text matches the last line within this window
   * (stops repeated TTS from STT noise/echo with a different tone).
   */
  pipelineTtsDedupeWindowMs: reqNum('PIPELINE_TTS_DEDUPE_WINDOW_MS', 14000),
  /** Sarvam+11: only dedupe strings at least this long (after normalize). */
  pipelineTtsDedupeMinChars: reqNum('PIPELINE_TTS_DEDUPE_MIN_CHARS', 2),
  /**
   * Sarvam+11: min whole-buffer RMS for `silence_after_speech` flush before STT. 0 ≈ 0.88× max-hold min RMS.
   */
  pipelineSilenceFlushMinRms: reqNum('PIPELINE_SILENCE_FLUSH_MIN_RMS', 0),

  /**
   * Sarvam+11 agent→customer: stricter gates before Sarvam STT (fewer hallucinations on line tone / silence).
   * Default **true**. Set `false` for legacy parity with cust→agent.
   */
  pipelineAgentToCustomerStrictStt:
    String(req('PIPELINE_AGENT_TO_CUSTOMER_STRICT_STT', 'true')).toLowerCase() === 'true',
  /**
   * Max ms of buffered audio without flush before forcing STT (same idea as PIPELINE_MAX_HOLD_BEFORE_FLUSH_MS).
   * Default **0** = disabled on agent→customer when strict STT is on (recommended). Set **3200** to restore periodic flush.
   */
  pipelineAgentToCustomerMaxHoldMs: reqNum('PIPELINE_AGENT_TO_CUSTOMER_MAX_HOLD_MS', 0),
  /**
   * Min share of 20 ms @ 16 kHz frames with RMS ≥ utterance threshold before STT (strict agent→customer). 0 = skip check.
   */
  pipelineAgentToCustomerMinLoudFrameRatio: reqNum(
    'PIPELINE_AGENT_TO_CUSTOMER_MIN_LOUD_FRAME_RATIO',
    0.14,
  ),
  /** Min whole-clip RMS (int16 mono 16 kHz upsampled PCM) before STT; 0 = auto from silence-flush floor. */
  pipelineAgentToCustomerSttMinBufferRms: reqNum(
    'PIPELINE_AGENT_TO_CUSTOMER_STT_MIN_BUFFER_RMS',
    0,
  ),
  /** Optional higher utterance RMS for agent→customer only; 0 = use PIPELINE_UTTERANCE_RMS. */
  pipelineAgentToCustomerUtteranceRms: reqNum('PIPELINE_AGENT_TO_CUSTOMER_UTTERANCE_RMS', 0),
  /**
   * Floor for silence-flush min RMS on strict agent→customer (only when PIPELINE_SILENCE_FLUSH_MIN_RMS is unset/0).
   */
  pipelineAgentToCustomerSilenceFlushFloorRms: reqNum(
    'PIPELINE_AGENT_TO_CUSTOMER_SILENCE_FLUSH_FLOOR_RMS',
    52,
  ),

  /** OpenAI voice (`server_vad`): ms of silence before end-of-speech. Higher reduces spurious turns on a quiet line. */
  openaiVoiceServerVadSilenceMs: reqNum('OPENAI_VOICE_SERVER_VAD_SILENCE_MS', 520),

  /** Rare deep debug: flush RMS, ElevenLabs, Plivo quirks. Usually keep false. */
  pipelineTroubleshootLog:
    String(req('PIPELINE_TROUBLESHOOT_LOG', 'false')).toLowerCase() === 'true',
  /** Frequent per-chunk RMS (very noisy). */
  pipelineVerboseLog: String(req('PIPELINE_VERBOSE_LOG', 'false')).toLowerCase() === 'true',
  /** Verbose TRANSLATION line with TTS snippet (mostly superseded by pipelineVoiceTextLog). */
  pipelineTranslationConsoleLog:
    String(req('PIPELINE_TRANSLATION_CONSOLE_LOG', 'false')).toLowerCase() === 'true',
  /**
   * Sarvam+11: one line per recognized utterance: `[voice→text] agent→customer │ "…"`.
   */
  pipelineVoiceTextLog:
    String(req('PIPELINE_VOICE_TEXT_LOG', 'true')).toLowerCase() === 'true',

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

  const p = env.openaiRealtimePipeline;
  const pcm = env.plivoStreamUsesMulaw ? 'mulaw' : 'l16';
  console.info(
    `[boot] voice-agent PORT=${env.port} pipeline=${p} stream_pcm=${pcm} voice_text_log=${env.pipelineVoiceTextLog}`,
  );
  if (!env.sarvamApiKey && p === 'sarvam_eleven') {
    console.warn('[boot] SARVAM_API_KEY missing');
  }
  if (!env.elevenlabsApiKey && p === 'sarvam_eleven') {
    console.warn('[boot] ELEVENLABS_API_KEY missing');
  }
  if (p === 'sarvam_eleven') {
    const vid = String(process.env.ELEVENLABS_VOICE_ID || '').trim();
    const ven = String(process.env.ELEVENLABS_VOICE_EN || '').trim();
    const vhi = String(process.env.ELEVENLABS_VOICE_HI || '').trim();
    if (!vid && (!ven || !vhi)) {
      console.warn('[boot] Set ELEVENLABS_VOICE_ID or both _EN / _HI for bilingual output');
    }
  }
}
