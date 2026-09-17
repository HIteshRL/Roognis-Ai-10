/**
 * Minimal generated-text safety check — duplicated (trimmed) from
 * services/ai/safety.js.
 *
 * services/practice has no student-authored-prompt path (generation triggers
 * off lesson identity, not free text) and no image path, so this keeps only
 * what's used: a check over the LLM's own generated summary/flashcard/quiz
 * text before it's persisted. The rule set itself is copied verbatim, not
 * re-derived — weakening it in a new service would be a silent regression.
 * If services/ai/safety.js's rules change, this copy will not follow
 * automatically; that drift risk is recorded in HANDOFF.md.
 */
function validateGeneratedTextSafety(text) {
  return validateSafetyText(text, getChatSafetyRules());
}

function validateSafetyText(text, rules) {
  const normalized = normalizeForSafety(text);
  if (!normalized) {
    return { allowed: false, category: 'empty', reason: 'Empty content is not allowed.' };
  }

  for (const rule of rules) {
    if (rule.patterns.some(pattern => pattern.test(normalized))) {
      return {
        allowed: false,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { allowed: true };
}

function normalizeForSafety(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getChatSafetyRules() {
  return [
    {
      category: 'self_harm',
      reason: 'Self-harm content is not appropriate for generated practice content.',
      patterns: [
        /\b(kill myself|end my life|suicide|self[- ]?harm|cut myself|hurt myself)\b/i,
        /(आत्महत्या|खुदकुशी|मरना चाहता|मरना चाहती|खुद को मार)/,
        /\b(aatmahatya|atmahatya|khudkushi|khudkhushi)\b/i,
        /\b(main|mai|mein|mujhe)\b.{0,24}\bmarna chaht[aiy]/i,
        /\bkhud ko\b.{0,20}\b(maar|marna|nuksan)/i,
      ],
    },
    {
      category: 'grooming',
      reason: 'This content looks unsafe and was blocked from generation.',
      patterns: [
        /\b(do ?n[o']?t|don't|never)\b.{0,25}\btell\b.{0,25}\b(your |ur )?(parents?|mum|mom|mother|dad|father|teacher|anyone)\b/i,
        /\b(our|its? a|keep it a)\b.{0,10}\bsecret\b.{0,25}\b(between us|from your|do ?n[o']?t tell)\b/i,
        /\bsend (me|us)\b.{0,25}\b(a )?(photo|picture|pic|video|selfie)\b.{0,15}\b(of )?(you|yourself|your body)\b/i,
        /\b(what|whats|what's)\b.{0,15}\byour\b.{0,10}\b(home )?address\b/i,
        /\bmeet me\b.{0,25}\b(alone|after school|in person|without)\b/i,
        /\bare you (home )?alone\b/i,
      ],
    },
    {
      category: 'sexual_content',
      reason: 'Sexual or adult content is not appropriate for generated practice content.',
      patterns: [
        /\b(porn|nude|naked|orgasm|masturbat|blowjob|handjob|sexual roleplay|explicit sex)\b/i,
      ],
    },
    {
      category: 'age_inappropriate_language',
      reason: 'Profanity is not appropriate for generated practice content.',
      patterns: [
        /\b(teach|learn|show|tell)\b.{0,30}\b(bad words?|curse words?|swear words?|abusive words?|dirty words?)\b/i,
        /\b(fuck|shit|bitch|asshole|bastard|motherfucker|cunt|dick|pussy)\b/i,
      ],
    },
    {
      category: 'dangerous_instructions',
      reason: 'Dangerous instructions are not allowed in generated practice content.',
      patterns: [
        /\bhow to\b.{0,40}\b(bomb|explosive|gun|poison|weapon|stab)\b/i,
        /\bshoot\b.{0,20}\b(someone|person|people|teacher|student|classmate)\b/i,
        /\b(make|build|create|assemble|hide)\b.{0,40}\b(bomb|explosive|gun|poison|weapon)\b/i,
        /\b(kill someone|murder|torture|behead|gore)\b/i,
      ],
    },
    {
      category: 'drugs',
      reason: 'Drug-use content is not appropriate for generated practice content.',
      patterns: [
        /\b(cocaine|heroin|meth|lsd|ecstasy|drug dealer|get high)\b/i,
      ],
    },
    {
      category: 'hate_or_harassment',
      reason: 'Hate or harassment content is not allowed in generated practice content.',
      patterns: [
        /\b(hate speech|racial superiority|nazi propaganda|genocide)\b/i,
      ],
    },
    {
      category: 'cyber_abuse',
      reason: 'Cyber abuse instructions are not allowed in generated practice content.',
      patterns: [
        /\b(hack|steal password|phishing|bypass security|credit card fraud)\b/i,
      ],
    },
  ];
}

/**
 * Categories that route to a human rather than just a refusal.
 *
 * MASTERCONTEXT §12: "Anything resembling a well-being concern routes to a
 * human teacher via flag — never automated inference, never automated parent
 * notification." Kept for parity with services/ai/safety.js even though this
 * service has no SafetyReviewFlag table of its own yet — a caller that wants
 * to route this to a human review flag can check the category against this
 * set.
 */
const WELFARE_REVIEW_CATEGORIES = ['self_harm', 'grooming'];

const isWelfareConcern = category => WELFARE_REVIEW_CATEGORIES.includes(category);

module.exports = {
  WELFARE_REVIEW_CATEGORIES,
  isWelfareConcern,
  validateGeneratedTextSafety,
};
