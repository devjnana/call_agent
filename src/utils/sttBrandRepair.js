/**
 * Phone STT often misreads product names (“Saasgold” → “Sanskrit”). Repair only when branding is configured.
 */

/**
 * @param {string} transcript
 * @param {string} brandName — trimmed company / product spelling (e.g. Saasgold)
 * @returns {string}
 */
export function repairSttMisheardBrand(transcript, brandName) {
  const b = String(brandName || '').trim();
  const t = String(transcript || '').trim();
  if (!b || !t) return t;
  /** Sarvam/phone STT variants for Sanskrit vs Saasgold */
  return t.replace(/\bSans[kk]rit\b/g, b);
}
