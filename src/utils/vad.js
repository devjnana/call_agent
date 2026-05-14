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
 * Share of windows (20 ms @ 16 kHz mono = 640 bytes) whose RMS exceeds `rmsThreshold`.
 * Helps reject steady line noise that has moderate mean RMS but few speech-like bursts.
 * @param {Buffer} pcm16
 * @param {number} rmsThreshold — same scale as {@link pcm16MonoRms}
 * @param {number} [frameSamples=320] — 320 = 20 ms @ 16 kHz
 * @returns {number} in [0, 1]
 */
export function pcm16MonoLoudFrameRatio(pcm16, rmsThreshold, frameSamples = 320) {
  if (!pcm16 || pcm16.length < frameSamples * 2 || rmsThreshold <= 0) return 0;
  const frameBytes = frameSamples * 2;
  let loud = 0;
  let total = 0;
  for (let off = 0; off + frameBytes <= pcm16.length; off += frameBytes) {
    total += 1;
    if (pcm16MonoRms(pcm16.subarray(off, off + frameBytes)) > rmsThreshold) loud += 1;
  }
  return total ? loud / total : 0;
}

/**
 * @param {Buffer} mulawChunk
 * @returns {boolean}
 */
export function isLikelySpeech(mulawChunk) {
  if (!mulawChunk || mulawChunk.length < 8) return false;
  return mulawEnergy(mulawChunk) > THRESH;
}
