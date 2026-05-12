/** Build Plivo-compatible conference dial XML.
 * Plivo `muted=true`: that leg does **not transmit** into its room.
 * Agent/customer use **separate** room names so there is no raw cross-talk; TTS is injected with `playAudio`.
 */

/**
 * Per-session Plivo conference name.
 * @param {string} sessionId
 * @param {"agent"|"customer"|undefined} [leg] — **Pass `leg`** so agent and customer sit in *different* rooms: they
 * cannot hear each other’s raw voice on the bridge; only `playAudio` carries speech to each leg (no leak).
 * Omit `leg` to get the logical session prefix (logging / API).
 */
export function conferenceRoomName(sessionId, leg) {
  const base = `tr-${String(sessionId).replace(/[^a-zA-Z0-9-_]/g, '')}`;
  if (leg === 'agent') return `${base}-agent`;
  if (leg === 'customer') return `${base}-cust`;
  return base;
}

/**
 * @param {object} opts
 * @param {boolean} opts.mutedParticipants — when true callers do not expose raw mic audio to the bridge.
 */
export function conferenceJoinXml(roomName, opts = {}) {
  const mutedAttr = opts.mutedParticipants ?? true ? 'true' : 'false';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference muted="${mutedAttr}"
              enterSound="false"
              exitSound="false"
              startConferenceOnEnter="true"
              endConferenceOnExit="true"
              waitSound="">${escapeXml(roomName)}</Conference>
</Response>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
