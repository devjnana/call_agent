import { v4 as uuidv4 } from 'uuid';
import { resolveTranslationTargets } from '../utils/language.js';
import { assertE164like } from '../utils/e164.js';
import { env } from '../config/index.js';
import { originateCall, startBidirectionalMuLawStream, hangupCall } from '../plivo/rest.js';
import { conferenceRoomName } from '../plivo/xml.js';
import {
  assertPlivoStreamWsUrl,
  assertPlivoWebhookBaseUrl,
} from '../utils/plivoPublicUrl.js';
import { log } from '../utils/logger.js';
import { TranslationSession } from './translationSession.js';

/**
 * Outbound chaining: agent first, supervisor bridge, bilingual AI via WebSockets.
 */
export class CallOrchestrator {
  /**
   * @param {import('./sessionRegistry.js').SessionRegistry} registry
   */
  constructor(registry) {
    this.registry = registry;
    /** leg -> timeouts */
    this.setupTimers = new Map();
  }

  /**
   * @param body — CRM payload compatible with README contract.
   */
  async initiateFromCrm(body) {
    assertPlivoWebhookBaseUrl(env.baseUrl);
    assertPlivoStreamWsUrl(env.wsBaseUrl);

    const {
      agent_number: agentRaw,
      customer_number: custRaw,
      agent_language,
      customer_language,
    } = body;

    if (!agentRaw || !custRaw) {
      throw new Error('agent_number and customer_number are required');
    }
    assertE164like('agent_number', agentRaw);
    assertE164like('customer_number', custRaw);
    const { toAgentTag, toCustomerTag } = resolveTranslationTargets(
      agent_language,
      customer_language,
    );

    const id = uuidv4();
    const sess = new TranslationSession({
      id,
      agentE164: agentRaw,
      customerE164: custRaw,
      toAgentTag,
      toCustomerTag,
    });

    sess.onDestroy(async () => {
      this.registry.delete(id);
      const t = this.setupTimers.get(id);
      if (t) clearTimeout(t);
      this.setupTimers.delete(id);
      try {
        if (sess.agentCallUuid) await hangupCall(sess.agentCallUuid);
      } catch (_) {}
      try {
        if (sess.customerCallUuid) await hangupCall(sess.customerCallUuid);
      } catch (_) {}
    });

    this.registry.put(sess);

    await this.dialAgent(sess);
    this.armSetupTimeout(sess);

    return {
      session_id: id,
      conference: conferenceRoomName(id),
      state: 'dialing_agent',
    };
  }

  armSetupTimeout(sess) {
    const t = setTimeout(() => {
      if (!sess.customerDialStarted || !sess.customerCallUuid) {
        log.warn('Call setup timed out — tearing down session', sess.id);
        sess.destroy('setup_timeout');
      }
      this.setupTimers.delete(sess.id);
    }, env.callSetupTimeoutMs);
    this.setupTimers.set(sess.id, t);
  }

  /**
   * @param {InstanceType<import('./translationSession.js').TranslationSession>} sess
   */
  async dialAgent(sess) {
    await originateCall({
      from: env.plivoCallerId,
      to: sess.agentE164,
      answer_method: 'POST',
      answer_url: `${env.baseUrl}/plivo/webhook/answer?session=${encodeURIComponent(
        sess.id,
      )}&leg=agent`,
      hangup_url: `${env.baseUrl}/plivo/webhook/hangup?session=${encodeURIComponent(
        sess.id,
      )}`,
      hangup_method: 'POST',
    });
  }

  /**
   * @param {InstanceType<import('./translationSession.js').TranslationSession>} sess
   */
  async dialCustomer(sess) {
    if (sess.customerDialStarted) return;
    sess.customerDialStarted = true;
    await originateCall({
      from: env.plivoCallerId,
      to: sess.customerE164,
      answer_method: 'POST',
      answer_url: `${env.baseUrl}/plivo/webhook/answer?session=${encodeURIComponent(
        sess.id,
      )}&leg=customer`,
      hangup_url: `${env.baseUrl}/plivo/webhook/hangup?session=${encodeURIComponent(
        sess.id,
      )}`,
      hangup_method: 'POST',
    });
  }

  /**
   * @param {InstanceType<import('./translationSession.js').TranslationSession>} sess
   * @param {"agent"|"customer"} leg
   * @param {string} callUuid
   */
  async legAnswered(sess, leg, callUuid) {
    sess.warmTranslators();
    sess.setCallUuid(leg, callUuid);

    if (leg === 'customer') {
      const t = this.setupTimers.get(sess.id);
      if (t) clearTimeout(t);
      this.setupTimers.delete(sess.id);
    }

    if (leg === 'agent') {
      setTimeout(() => {
        this.dialCustomer(sess).catch((e) => {
          log.error('Customer dial failed', e);
          sess.destroy('customer_dial_failed');
        });
      }, env.customerDialDelayMs);
    }

    const wsUrl = this.buildStreamServiceUrl(sess.id, leg);
    try {
      await startBidirectionalMuLawStream(callUuid, wsUrl);
    } catch (e) {
      log.error('Could not start media stream', e);
      sess.destroy('stream_start_failed');
    }
  }

  buildStreamServiceUrl(sessionId, leg) {
    const base = env.wsBaseUrl.replace(/\/$/, '');
    /** Fixed query order must match the upgrade `req.url` Plivo signs. */
    return `${base}/ws/plivo?session=${encodeURIComponent(sessionId)}&leg=${encodeURIComponent(
      leg,
    )}`;
  }

  /**
   * @param {string} sessionId
   */
  async forceTeardown(sessionId) {
    const s = this.registry.get(sessionId);
    if (s) s.destroy('admin_teardown');
  }
}
