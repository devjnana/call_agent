/**
 * Sarvam often tags Roman-script Hindi as `en-IN`. Feeding EN→HI mistranslates Hinglish lines
 * (e.g. “ka haal kaise chal raha hai?”). When target is Hindi, treat these as `hi-IN` for translate.
 */

const DEVANAGARI = /[\u0900-\u097F]/;

const RH_WORDS =
  /\b(?:aap|kya|kaise|kese|kahan|kahaa|kab|kaun|nahi|nahin|nhi|mein|main|hum|mera|meri|mere|unka|unke|tha|thi|the|hui|hue|hua|hun|hoon|haal|hai|hain|chal|raha|rahi|rahe|rha|rhi|rhe|dekho|dekha|liyaa|liya|thik|theek|samajh|sabujh|sirf|bas|bilkul|accha|acha|kaam|sab|kabhi|zaroor|zyada|kam|yeh|ye|woh|khud|bahut|kitna|namaste|namaskar|jee|sir|isko|iska|mil|bolo|boli)\b/gi;

/**
 * @param {string} s
 */
function lastClause(s) {
  const trimmed = String(s || '').trim();
  const parts = trimmed.split(/(?:[.?!]\s+)/).filter(Boolean);
  return parts[parts.length - 1]?.trim() || trimmed;
}

/**
 * Latin-only text that is likely Hindi written in Roman letters (Hinglish transcription).
 * @param {string} text — line from STT
 * @returns {boolean}
 */
export function looksRomanizedHindi(text) {
  const t = String(text || '').trim();
  if (!t || DEVANAGARI.test(t)) return false;
  const lower = t.toLowerCase();

  if (/\b(?:ka\s+)?mujhe\b|\bmai(?:n|\s+)\s+h[uü]n\b|\baap\s+ka\b/i.test(lower))
    return true;

  const tail = lastClause(lower);
  if (
    /\bhaal\b/.test(tail) &&
    /\b(?:kaise|kese|chal|rha|rhi|rah|raha)\b/i.test(tail)
  )
    return true;
  if (/\bchal\s*r[ahae]{1,4}\s*(?:hai|hog|hue|hain)?\b/i.test(lower))
    return true;
  if (
    /\byes[,.\s]+\s*(?:samajh|sabujh|samjhe|sab)\b/i.test(lower) ||
    /\b(?:samajh|sabujh)\s+(?:gayi|gayi|gaye|gaya|gya)\b/i.test(lower)
  )
    return true;

  RH_WORDS.lastIndex = 0;
  let hits = 0;
  let m;
  while ((m = RH_WORDS.exec(lower)) !== null) {
    hits += 1;
    if (hits >= 2) return true;
  }

  const hasHindiCue =
    /\b(?:kaise|kya|nahi|nahin|aap\s|mein\b|hum\b|haal\b)\b/i.test(lower);
  if (hits >= 1 && hasHindiCue && lower.length > 8) return true;

  return false;
}
