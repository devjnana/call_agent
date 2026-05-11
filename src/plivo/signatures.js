import plivoPkg from 'plivo';
import { log } from '../utils/logger.js';

/**
 * Validates Plivo voice HTTP callbacks (handles reverse proxies via X-Forwarded-*).
 * @returns {boolean}
 */
export function verifyPlivoHttpSignature(req, authToken, enabled) {
  if (!enabled) return true;
  if (!authToken) {
    log.warn('PLIVO_VALIDATE_SIGNATURES on but PLIVO_AUTH_TOKEN missing');
    return false;
  }
  const signature = req.headers['x-plivo-signature-v2'];
  const nonce = req.headers['x-plivo-signature-v2-nonce'];
  if (!signature || !nonce) return false;

  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const path = `${proto}://${host}${req.originalUrl}`;

  return plivoPkg.validateSignature(path, nonce, signature, authToken);
}
