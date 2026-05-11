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

export const env = {
  port: reqNum('PORT', 3000),
  /** HTTPS base for Plivo answer/hangup webhooks */
  baseUrl: normalizeBaseUrl(req('BASE_URL', 'http://127.0.0.1:3000')),
  /** WSS origin for bidirectional streams (must be reachable by Plivo) */
  wsBaseUrl: normalizeBaseUrl(req('WS_BASE_URL', 'ws://127.0.0.1:3000')),
  openaiApiKey: req('OPENAI_API_KEY'),
  openaiRealtimeModel: req('OPENAI_REALTIME_MODEL', 'gpt-realtime-translate'),
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
}
