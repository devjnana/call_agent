/** Human labels for realtime-voice prompts (narrow set). */

const MAP = Object.freeze({
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  bn: 'Bengali',
  kn: 'Kannada',
  ml: 'Malayalam',
  mr: 'Marathi',
  gu: 'Gujarati',
  pa: 'Punjabi',
  ur: 'Urdu',
  or: 'Odia',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
});

export function isoToPromptLabel(tag) {
  if (!tag) return 'their language';
  const k = String(tag).toLowerCase().slice(0, 2);
  return MAP[k] || tag;
}
