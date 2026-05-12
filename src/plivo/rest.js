import { env } from '../config/index.js';
import { log } from '../utils/logger.js';

const plivoBaseUrl = () => `https://api.plivo.com/v1/Account/${env.plivoAuthId}/Call`;

function authHeader() {
  const tok = Buffer.from(`${env.plivoAuthId}:${env.plivoAuthToken}`, 'utf8').toString('base64');
  return `Basic ${tok}`;
}

/**
 * Outbound call — telecaller dialled first from orchestrator.
 */
export async function originateCall(body) {
  const url = `${plivoBaseUrl()}/`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    log.error(
      'Plivo originate failed',
      resp.status,
      text,
      'answer_url:',
      body?.answer_url,
    );
    let detail = text;
    try {
      const j = JSON.parse(text);
      if (j.error) detail = j.error;
    } catch {
      //
    }
    const hint =
      /answer_url/i.test(detail) || /hangup_url/i.test(detail)
        ? ' Set BASE_URL in .env to a real public HTTPS origin (e.g. ngrok), not placeholders or localhost.'
        : '';
    throw new Error(`Plivo originate failed (${resp.status}): ${detail}${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Attach bidirectional 8 kHz µ-law WS stream to answered call UUID.
 */
export async function startBidirectionalMuLawStream(callUuid, serviceUrl) {
  const url = `${plivoBaseUrl()}/${callUuid}/Stream/`;
  const track = String(env.plivoStreamAudioTrack || 'inbound').toLowerCase();
  const audioTrack = track === 'both' ? 'both' : 'inbound';
  const body = {
    service_url: serviceUrl,
    bidirectional: true,
    audio_track: audioTrack,
    content_type: 'audio/x-mulaw;rate=8000',
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    log.error('Plivo stream start failed', resp.status, text);
    throw new Error(`Plivo stream failed: HTTP ${resp.status}`);
  }
  try {
    const j = JSON.parse(text);
    log.info(
      'Plivo Stream/ OK',
      'call',
      String(callUuid).slice(0, 8) + '…',
      'audio_track=',
      audioTrack,
      'stream_id=',
      j.stream_id ?? j.stream_uuid ?? '?',
      'service_url=',
      String(serviceUrl).slice(0, 72) + (String(serviceUrl).length > 72 ? '…' : ''),
    );
    return j;
  } catch {
    log.info(
      'Plivo Stream/ OK (non-JSON)',
      String(callUuid).slice(0, 8) + '…',
      String(serviceUrl).slice(0, 64),
    );
    return { raw: text };
  }
}

export async function hangupCall(callUuid) {
  const url = `${plivoBaseUrl()}/${callUuid}/`;
  await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader(),
    },
  });
}
