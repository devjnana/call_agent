/**
 * Maps CRM-friendly labels to ISO-639-1 tags used by OpenAI Realtime Translation.
 */

const TABLE = Object.freeze({
  english: 'en',
  hindi: 'hi',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
});

/**
 * @param {string} label
 * @returns {string | null}
 */
export function normalizeLanguage(label) {
  if (!label || typeof label !== 'string') return null;
  const k = label.trim().toLowerCase();
  if (k === 'auto') return 'auto';
  if (TABLE[k]) return TABLE[k];
  if (/^[a-z]{2}$/i.test(k)) return k.toLowerCase();
  return null;
}

/**
 * Derive per-direction **translation output** languages from CRM fields.
 *
 * Meaning of the CRM fields (keep these exact names in your JSON):
 * - **`agent_language`** — language the **agent should hear** on their phone (and the language we treat the agent as speaking when not using `auto`).
 * - **`customer_language`** — language the **customer should hear** (and the language we treat the customer as speaking when not using `auto`).
 *
 * Example: `"agent_language": "english"`, `"customer_language": "hindi"`
 * - Customer’s mic (Hindi) → translated **into English** → played to the **agent**.
 * - Agent’s mic (English) → translated **into Hindi** → played to the **customer**.
 *
 * Supports `auto` for one side paired with an explicit opposite language.
 */
export function resolveTranslationTargets(agent_language, customer_language) {
  let agentTag = normalizeLanguage(agent_language);
  let custTag = normalizeLanguage(customer_language);

  if (!agent_language || !customer_language) {
    throw new Error('agent_language and customer_language are required');
  }
  if (agentTag === null || custTag === null) {
    throw new Error('Unsupported language label; use english, hindi, ISO-639-1 code, or auto');
  }

  if (agentTag === 'auto' && custTag === 'auto') {
    throw new Error('At least one language must be explicit when using auto');
  }

  let toAgentTag;
  if (agentTag === 'auto') {
    toAgentTag = custTag === 'hi' ? 'en' : custTag === 'en' ? 'hi' : 'en';
  } else {
    toAgentTag = agentTag;
  }

  let toCustomerTag;
  if (custTag === 'auto') {
    toCustomerTag = agentTag === 'en' ? 'hi' : agentTag === 'hi' ? 'en' : 'hi';
  } else {
    toCustomerTag = custTag;
  }

  const agentSpeak =
    agentTag !== 'auto'
      ? agentTag
      : custTag === 'hi'
        ? 'en'
        : custTag === 'en'
          ? 'hi'
          : 'en';

  const custSpeak =
    custTag !== 'auto'
      ? custTag
      : agentTag === 'en'
        ? 'hi'
        : agentTag === 'hi'
          ? 'en'
          : 'hi';

  return {
    toAgentTag,
    toCustomerTag,
    agentSpokenApprox: agentSpeak,
    customerSpokenApprox: custSpeak,
  };
}
