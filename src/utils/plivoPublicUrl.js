/**
 * Plivo requires answer_url / hangup_url / callback URLs to be real, publicly reachable HTTPS endpoints.
 */

const PLACEHOLDER_PATTERNS = [
  /your-ngrok-url/i,
  /example\.invalid/i,
];

/**
 * Returns a human-readable reason or `null` if the base looks usable.
 *
 * @param {string} baseUrl — `BASE_URL` without trailing slash
 */
export function plivoWebhookBaseUrlIssue(baseUrl) {
  const trimmed = String(baseUrl || '').trim();
  if (!trimmed) {
    return 'BASE_URL is empty. Set it to your HTTPS tunnel URL (ngrok / Cloudflare / ALB).';
  }

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return 'BASE_URL is not a valid URL.';
  }

  if (u.protocol !== 'https:') {
    return `BASE_URL must use https:// (got ${u.protocol}). Plivo rejects plain http for outbound webhooks on most accounts.`;
  }

  const host = u.hostname.toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    return 'BASE_URL cannot be localhost — Plivo’s servers cannot reach your machine. Use an HTTPS tunnel (ngrok, etc.).';
  }

  if (host.endsWith('.local')) {
    return 'BASE_URL uses a .local hostname Plivo cannot resolve from the cloud.';
  }

  /** RFC 2606 documentation TLD — not routable on the public Internet */
  if (host === 'example.com' || host.endsWith('.example')) {
    return 'BASE_URL still points at a documentation/placeholder host (.example). Replace it with your real tunnel domain.';
  }

  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(host) || re.test(trimmed)) {
      return 'BASE_URL matches a template placeholder. Paste your actual ngrok (or public) HTTPS origin.';
    }
  }

  return null;
}

/**
 * @param {string} baseUrl
 * @throws {Error}
 */
export function assertPlivoWebhookBaseUrl(baseUrl) {
  const issue = plivoWebhookBaseUrlIssue(baseUrl);
  if (issue) {
    throw new Error(`${issue} Example: BASE_URL=https://abc123.ngrok-free.app`);
  }
}

/** Same host rules as HTTP; protocol must be `wss:` for cloud↔telephony streams. */
export function plivoWsBaseUrlIssue(wsBaseUrl) {
  const trimmed = String(wsBaseUrl || '').trim();
  if (!trimmed) return 'WS_BASE_URL is empty. Usually same host as BASE_URL but with wss://.';
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return 'WS_BASE_URL is not a valid URL.';
  }
  if (u.protocol !== 'wss:') {
    return `WS_BASE_URL must use wss:// (got ${u.protocol}). Insecure ws:// is blocked by browsers and rejected by Plivo edges for production.`;
  }

  const host = u.hostname.toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1') {
    return 'WS_BASE_URL cannot be localhost — expose an HTTPS/WSS tunnel and use that hostname.';
  }
  if (host.endsWith('.local')) {
    return 'WS_BASE_URL hostname is not reachable from Plivo.';
  }
  if (host === 'example.com' || host.endsWith('.example')) {
    return 'WS_BASE_URL still uses a placeholder .example host.';
  }
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(host) || re.test(trimmed)) {
      return 'WS_BASE_URL matches a README placeholder.';
    }
  }
  return null;
}

/** @throws {Error} */
export function assertPlivoStreamWsUrl(wsUrl) {
  const issue = plivoWsBaseUrlIssue(wsUrl);
  if (issue) {
    throw new Error(`${issue} Example: WS_BASE_URL=wss://abc123.ngrok-free.app`);
  }
}
