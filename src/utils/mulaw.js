/**
 * µ-law transcoding (PCM16 mono @8 kHz) via zero-dependency implementation.
 */
import alawmulaw from 'alawmulaw';

/**
 * @param {Buffer} mulaw
 * @returns {Buffer} int16 LE
 */
export function decodeMuLawToPcm16(mulaw) {
  const dec = alawmulaw.mulaw.decode(new Uint8Array(mulaw));
  return Buffer.from(dec.buffer, dec.byteOffset, dec.byteLength);
}

/**
 * @param {Buffer} pcm16le
 * @returns {Buffer} mulaw raw bytes
 */
export function pcm16LeToMuLaw(pcm16le) {
  const view = new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.length / 2);
  const enc = alawmulaw.mulaw.encode(view);
  return Buffer.from(enc);
}

/** Quick RMS on mulaw bytes (proxy for energy). */
export function mulawEnergy(mulaw) {
  let acc = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const d = mulaw[i] - 127;
    acc += d * d;
  }
  return Math.sqrt(acc / mulaw.length);
}
