import { pcm16LeToMuLaw } from './mulaw.js';

/**
 * Upsample 8 kHz PCM16 LE mono to 24 kHz by sample hold (cheap, stable for VoIP STFT chains).
 */
export function pcm8kTo24k(pcm8k) {
  const nIn = pcm8k.length >>> 1;
  const out = Buffer.allocUnsafe(nIn * 3 * 2);
  let o = 0;
  for (let i = 0; i < nIn; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    out.writeInt16LE(s, o);
    out.writeInt16LE(s, o + 2);
    out.writeInt16LE(s, o + 4);
    o += 6;
  }
  return out;
}

/**
 * Downsample 24 kHz PCM16 LE mono to 8 kHz (pick every third sample).
 */
export function pcm24kTo8k(pcm24k) {
  const nInSamples = pcm24k.length >>> 1;
  const outSampleCount = Math.floor(nInSamples / 3);
  const out = Buffer.allocUnsafe(outSampleCount * 2);
  for (let i = 0; i < outSampleCount; i++) {
    const srcIdx = i * 3;
    out.writeInt16LE(pcm24k.readInt16LE(srcIdx * 2), i * 2);
  }
  return out;
}

/** Convert OpenAI pcm16 mono buffer @24kHz to mulaw bytes @8kHz for Plivo. */
export function openAiPcmToPlivoMuLaw(openAiDeltaBuffer) {
  const pcm8 = pcm24kTo8k(openAiDeltaBuffer);
  return pcm16LeToMuLaw(pcm8);
}
