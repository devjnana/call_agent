import { verifyPlivoHttpSignature } from '../plivo/signatures.js';
import { conferenceJoinXml, conferenceRoomName } from '../plivo/xml.js';
import { env } from '../config/index.js';
import { log } from '../utils/logger.js';

export function buildPlivoWebhookController(registry, orchestrator) {
  return {
    async answer(req, res) {
      if (
        !verifyPlivoHttpSignature(req, env.plivoAuthToken, env.plivoValidateSignatures)
      ) {
        return res.status(403).send('forbidden');
      }

      const sessionId = String(req.query.session || '');
      const leg = req.query.leg === 'customer' ? 'customer' : 'agent';
      const callUuid = req.body?.CallUUID || req.query.CallUUID || '';

      const sess = registry.get(sessionId);
      if (!sess || !callUuid) {
        log.warn('Plivo answer orphan', sessionId, callUuid);
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
        return;
      }

      const xml = conferenceJoinXml(conferenceRoomName(sessionId), {
        mutedParticipants: env.plivoConferenceMuted,
      });
      res.type('text/xml').send(xml);

      setImmediate(() => {
        orchestrator.legAnswered(sess, leg, callUuid).catch((e) => {
          log.error('Post-answer chaining failed', e);
          sess.destroy('post_answer_fail');
        });
      });
    },

    hangup(req, res) {
      if (
        !verifyPlivoHttpSignature(req, env.plivoAuthToken, env.plivoValidateSignatures)
      ) {
        return res.status(403).send('forbidden');
      }
      const sessionId = String(req.query.session || req.body?.SessionUUID || '');
      const sess = registry.get(sessionId);
      if (sess) sess.destroy('plivo_hangup_callback');
      res.sendStatus(200);
    },
  };
}
