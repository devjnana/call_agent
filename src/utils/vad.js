import { mulawEnergy } from './mulaw.js';

/** Simple energy gate for barge-in (tune per deployment). */
const THRESH = 18;

/** RMS of s16le mono PCM (any sample rate). */
export function pcm16MonoRms(pcm16) {
  if (!pcm16 || pcm16.length < 4) return 0;
  const n = pcm16.length >>> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * @param {Buffer} mulawChunk
 * @returns {boolean}
 */
export function isLikelySpeech(mulawChunk) {
  if (!mulawChunk || mulawChunk.length < 8) return false;
  return mulawEnergy(mulawChunk) > THRESH;
}
