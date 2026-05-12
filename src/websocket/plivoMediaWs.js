/**
 * Bridges Plivo Bidirectional Streams into TranslationSession ingestion.
 *
 * Optionally validates `X-Plivo-Signature-V3*` against the canonical `service_url`
 * (origin from `WS_BASE_URL` + inbound upgrade path + query).
 */
import { WebSocketServer } from 'ws';
import plivoPkg from 'plivo';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';

/**
 * Must match the `service_url` string you POST from `startBidirectionalMuLawStream`.
 *
 * @param {import('http').IncomingMessage} req
 */
export function canonicalServiceUrl(req) {
  const origin = env.wsBaseUrl.trim().replace(/\/+$/, '');
  const prefix = /^wss?:\/\//i.test(origin) ? origin : `wss://${origin}`;
  const u = new URL(prefix);

  /** @type {string} */
  const pathAndQuery =
    typeof req.url === 'string'
      ? (req.url.startsWith('/') ? req.url : `/${req.url}`)
      : '/ws/plivo';

  return `${u.protocol}//${u.host}${pathAndQuery}`;
}

export function verifyPlivoWsHandshake(req) {
  if (!env.plivoValidateSignatures) return true;

  const signature = req.headers['x-plivo-signature-v3'];
  const nonce = req.headers['x-plivo-signature-v3-nonce'];
  if (!signature || !nonce) {
    log.warn('Rejecting websocket without Plivo signing headers');
    return false;
  }

  try {
    if (typeof plivoPkg.validateV3Signature !== 'function') {
      log.warn('Installed Plivo SDK has no validateV3Signature helper');
      return true;
    }
    const canonical = canonicalServiceUrl(req);
    const ok = plivoPkg.validateV3Signature(
      'GET',
      canonical,
      nonce,
      env.plivoAuthToken,
      signature,
    );
    if (!ok) log.warn('Plivo WS signature mismatch for', canonical);
    return !!ok;
  } catch (e) {
    log.error('WS signature crashed', e);
    return false;
  }
}

/**
 * @param {import('http').Server} server
 * @param {import('../services/sessionRegistry.js').SessionRegistry} registry
 */
export function attachPlivoMediaWs(server, registry) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathOnly = request.url?.split?.('?')?.[0] || '';
    if (pathOnly !== '/ws/plivo') {
      socket.destroy();
      return;
    }

    const fwd = request.headers['x-forwarded-for'];
    const clientIp =
      (typeof fwd === 'string' && fwd.split(',')[0]?.trim()) ||
      request.socket?.remoteAddress ||
      '?';
    log.info('[plivo-ws] upgrade /ws/plivo from', clientIp);

    if (!verifyPlivoWsHandshake(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (socket2) => {
      wss.emit('connection', socket2, request);
    });
  });

  wss.on('connection', (ws, req) => {
    const u = new URL(req.url || '/ws/plivo', 'http://127.0.0.1');
    const sessionId = u.searchParams.get('session');
    const leg = u.searchParams.get('leg') === 'customer' ? 'customer' : 'agent';

    const sess = sessionId ? registry.get(sessionId) : null;

    if (!sess) {
      log.warn('Plivo WS unknown session', sessionId, req.url?.slice(0, 160));
      ws.close(4404, 'unknown_session');
      return;
    }

    log.info(
      'Plivo WS socket open',
      sess.id,
      leg,
      'from',
      req.socket?.remoteAddress ?? '?',
      'url',
      (req.url || '').slice(0, 140),
    );

    /** Bind socket before Plivo may send audio — avoids playAudio to a null leg if `media` precedes `start`. */
    sess.attachPlivoSocket(leg, ws, {});

    ws.on('close', (code, reason) => {
      log.info(
        'Plivo WS socket closed (before events?)',
        sess.id,
        leg,
        'code',
        code,
        String(reason || ''),
      );
    });

    ws.on('message', (frame) => {
      let evt;
      try {
        evt = JSON.parse(frame.toString());
      } catch {
        return;
      }

      const ev = String(evt.event || '').toLowerCase();
      switch (ev) {
        case 'start':
          sess.onPlivoStreamStart(leg, evt.start || evt.Start || {}, ws);
          log.info('Plivo stream start', sess.id, leg);
          break;

        case 'media': {
          const b64 =
            evt.media?.payload ??
            evt.Media?.payload ??
            evt.payload ??
            null;
          if (!b64) {
            if (env.pipelineTroubleshootLog) {
              log.warn('Plivo media frame missing payload keys', sess.id, leg, Object.keys(evt));
            }
            return;
          }
          /** Plivo protocol puts `streamId` on every media chunk — we need it if `start` was delayed or skipped. */
          const sid = evt.streamId ?? evt.stream_id;
          if (sid) {
            sess.attachPlivoSocket(leg, ws, { streamId: String(sid) });
          }
          sess.ingestPlivoMedia(leg, Buffer.from(b64, 'base64'));
          break;
        }

        case 'stop':
          log.info('Plivo stream stop', sess.id, leg);
          break;

        default:
          if (env.pipelineTroubleshootLog && evt.event) {
            log.warn('Plivo WS unhandled event', sess.id, leg, evt.event, Object.keys(evt));
          }
          break;
      }
    });
  });

  const iv = setInterval(() => {
    for (const c of wss.clients) {
      if (c.readyState === 1) {
        try {
          c.ping();
        } catch {
          //
        }
      }
    }
  }, 45000);

  iv.unref();

  return wss;
}
