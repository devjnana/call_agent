import { mulawEnergy } from './mulaw.js';

/** Simple energy gate for barge-in (tune per deployment). */
const THRESH = 18;

/**
 * @param {Buffer} mulawChunk
 * @returns {boolean}
 */
export function isLikelySpeech(mulawChunk) {
  if (!mulawChunk || mulawChunk.length < 8) return false;
  return mulawEnergy(mulawChunk) > THRESH;
}
