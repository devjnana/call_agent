/** Build Plivo-compatible conference dial XML — both legs join muted so only streamed audio reaches each party. */

/**
 * Conference room name derived from CRM session UUID.
 */
export function conferenceRoomName(sessionId) {
  return `tr-${sessionId.replace(/[^a-zA-Z0-9-_]/g, '')}`;
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
