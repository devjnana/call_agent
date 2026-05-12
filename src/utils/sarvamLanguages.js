/**
 * Map ISO-639-1 tags (CRM / internal) → Sarvam BCP-47 codes used by Translate + STT.
 * Sarvam text translation covers Indian languages + English (en-IN); not European/Asian ISO codes beyond this set.
 */

const ISO2_TO_SARVAM = {
  en: 'en-IN',
  hi: 'hi-IN',
  bn: 'bn-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  gu: 'gu-IN',
  pa: 'pa-IN',
  ur: 'ur-IN',
  or: 'od-IN',
};

/**
 * @param {string | undefined} iso639 — two-letter or longer tag
 * @returns {string | null} Sarvam translate/STT code, or null if unsupported
 */
export function iso639ToSarvam(iso639) {
  if (!iso639) return null;
  const k = String(iso639).toLowerCase().slice(0, 2);
  return ISO2_TO_SARVAM[k] ?? null;
}

/**
 * STT language hint: use a concrete code when we know the leg, else `unknown`.
 * @param {string | undefined} iso639
 */
export function iso639ToSarvamSttHint(iso639) {
  return iso639ToSarvam(iso639) ?? 'unknown';
}
