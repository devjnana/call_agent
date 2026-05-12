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
 * Downsample 24 kHz PCM16 LE mono to 8 kHz for Plivo 8 kHz playout.
 * Uses a 3-sample boxcar (moving average) before 3:1 decimation to reduce aliasing vs naive pick-every-3rd-sample.
 */
export function pcm24kTo8k(pcm24k) {
  if (!pcm24k || pcm24k.length < 6) return Buffer.alloc(0);
  const nInSamples = pcm24k.length >>> 1;
  const outSampleCount = Math.floor(nInSamples / 3);
  const out = Buffer.allocUnsafe(outSampleCount * 2);
  for (let i = 0; i < outSampleCount; i++) {
    const b = i * 6;
    const s0 = pcm24k.readInt16LE(b);
    const s1 = pcm24k.readInt16LE(b + 2);
    const s2 = pcm24k.readInt16LE(b + 4);
    const v = Math.round((s0 + s1 + s2) / 3);
    const clamped = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    out.writeInt16LE(clamped, i * 2);
  }
  return out;
}

/** Convert OpenAI pcm16 mono buffer @24kHz to mulaw bytes @8kHz for Plivo. */
export function openAiPcmToPlivoMuLaw(openAiDeltaBuffer) {
  const pcm8 = pcm24kTo8k(openAiDeltaBuffer);
  return pcm16LeToMuLaw(pcm8);
}

/**
 * 24 kHz → 16 kHz (Sarvam STT expects 16 kHz PCM / WAV).
 */
export function pcm24kTo16k(pcm24k) {
  const nIn = pcm24k.length >>> 1;
  const outN = Math.floor((nIn * 16000) / 24000);
  if (outN <= 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(outN * 2);
  for (let j = 0; j < outN; j++) {
    const srcPos = (j * 24000) / 16000;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, nIn - 1);
    const frac = srcPos - i0;
    const s0 = pcm24k.readInt16LE(i0 * 2);
    const s1 = pcm24k.readInt16LE(i1 * 2);
    const s = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(s, j * 2);
  }
  return out;
}

/** Wrap mono s16le PCM in a minimal WAV (for multipart STT uploads). */
export function pcm16leMonoToWav(pcm, sampleRate) {
  const dataLen = pcm.length;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  pcm.copy(buf, 44);
  return buf;
}
