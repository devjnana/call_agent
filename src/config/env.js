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
  customerDialDelayMs: reqNum('CUSTOMER_DIAL_DELAY_MS', 400),
  sessionIdleTtlMs: reqNum('SESSION_IDLE_TTL_MS', 2 * 60 * 60 * 1000),
  callSetupTimeoutMs: reqNum('CALL_SETUP_TIMEOUT_MS', 120000),
};

export function assertEnvForRuntime() {
  const missing = [];
  if (!env.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!env.plivoAuthId) missing.push('PLIVO_AUTH_ID');
  if (!env.plivoAuthToken) missing.push('PLIVO_AUTH_TOKEN');
  if (!env.plivoCallerId) missing.push('PLIVO_PHONE_NUMBER');
  if (!env.baseUrl) missing.push('BASE_URL');
  if (!env.wsBaseUrl) missing.push('WS_BASE_URL');
  if (missing.length) {
    console.warn(`[boot] Missing env (some features offline): ${missing.join(', ')}`);
  }

  const p = env.openaiRealtimePipeline;
  if (p === 'voice') {
    console.info(
      `[boot] OPENAI_REALTIME_PIPELINE=voice • models (try until one accepts): ${env.openaiVoiceModelChain.join(' → ')} · VAD=${env.openaiVoiceVadKind}`,
    );
  } else {
    console.info(
      `[boot] OPENAI_REALTIME_PIPELINE=translation • model=${env.openaiTranslationModel} (/v1/realtime/translations — requires billed access; GPT Realtime Translate is unavailable on FREE tier per OpenAI docs)`,
    );
  }
}
