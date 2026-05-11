/** In-memory LRU-ish session tracking for horizontally scaled single-pod deployments. */

import { log } from '../utils/logger.js';
import { env } from '../config/index.js';

export class SessionRegistry {
  constructor() {
    /** @type {Map<string, import('../services/translationSession.js').TranslationSession>} */
    this.map = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.cleanupTimer = null;
  }

  startJanitor() {
    if (this.cleanupTimer) return;
    const tick = env.sessionIdleTtlMs;
    this.cleanupTimer = setInterval(() => this.sweep(), Math.min(tick / 4, 15 * 60 * 1000));
  }

  put(session) {
    this.map.set(session.id, session);
  }

  get(id) {
    return this.map.get(id) ?? null;
  }

  delete(id) {
    this.map.delete(id);
  }

  size() {
    return this.map.size;
  }

  snapshotSessions() {
    return [...this.map.values()];
  }

  sweep() {
    for (const s of [...this.map.values()]) {
      if (typeof s.idleMs === 'function' && s.idleMs() > env.sessionIdleTtlMs) {
        log.warn('Evict idle session', s.id);
        s.destroy?.('idle_timeout');
      }
    }
  }
}
