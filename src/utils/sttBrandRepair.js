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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace phone-STT aliases of an agent name (e.g. Kani, Kanil) with canonical spelling before translate/TTS.
 * @param {string} transcript
 * @param {string} canonical — e.g. Kali
 * @param {string} aliasesCsv — comma/semicolon/pipe-separated STT drift spellings
 * @returns {string}
 */
export function repairAgentSpokenName(transcript, canonical, aliasesCsv) {
  const c = String(canonical || '').trim();
  const t = String(transcript || '').trim();
  if (!c || !t) return t;
  const parts = String(aliasesCsv || '')
    .split(/[,|;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((a) => a.toLowerCase() !== c.toLowerCase());
  if (!parts.length) return t;
  let out = t;
  for (const alt of parts) {
    if (alt.length < 2) continue;
    try {
      out = out.replace(new RegExp(`\\b${escapeRe(alt)}\\b`, 'gi'), c);
    } catch (_) {
      /* regex escape edge */
    }
  }
  return out;
}
