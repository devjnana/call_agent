/** Very light E.164 sanity check — Plivo rejects invalid payloads server-side anyway. */

const RE = /^\+[1-9]\d{6,14}$/;

export function assertE164like(label, value) {
  if (!RE.test(String(value).trim())) {
    throw new Error(`${label} must be E.164 (+country…) format`);
  }
}
