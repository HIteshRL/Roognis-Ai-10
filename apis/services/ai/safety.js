const SAFE_REFUSAL_MESSAGE = 'I can only help with safe school-related learning questions. Try asking me about a topic from your class.';
const GEMINI_STRICT_SAFETY_THRESHOLD = 'BLOCK_LOW_AND_ABOVE';

function validateStudentMessageSafety(message) {
  return validateSafetyText(message, getChatSafetyRules());
}

function validateGeneratedTextSafety(text) {
  return validateSafetyText(text, getChatSafetyRules());
}

function validateImagePromptSafety(prompt) {
  return validateSafetyText(prompt, getImageSafetyRules());
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
      reason: 'Self-harm content is not appropriate for the AI tutor.',
      patterns: [
        /\b(kill myself|end my life|suicide|self[- ]?harm|cut myself|hurt myself)\b/i,
        // The product ships to Indian schools and carries `language`, `board`
        // and `curriculum` fields throughout, but every rule here was
        // English-ASCII — so the same disclosure in Hindi or Hinglish reached
        // an unconstrained model and produced a fluent reply with no block and
        // no flag. These cover the highest-stakes category only; the rest of
        // the rule set is still English-only (see `isLikelyUnassessable`).
        /(आत्महत्या|खुदकुशी|मरना चाहता|मरना चाहती|खुद को मार)/,
        /\b(aatmahatya|atmahatya|khudkushi|khudkhushi)\b/i,
        // First person only: "main marna chahta hoon" is a disclosure, while
        // "usko marna chahta" is a threat toward someone else and belongs to
        // `dangerous_instructions`, not here.
        /\b(main|mai|mein|mujhe)\b.{0,24}\bmarna chaht[aiy]/i,
        /\bkhud ko\b.{0,20}\b(maar|marna|nuksan)/i,
      ],
    },
    {
      // Absent entirely before this. For a product used by children it is the
      // most consequential gap in the rule set: none of the phrases below
      // matched any existing category, so grooming approaches passed straight
      // through to the tutor.
      category: 'grooming',
      reason: 'This looks like an unsafe request. A teacher has been notified so someone can check you are OK.',
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
      reason: 'Sexual or adult content is not appropriate for school tutoring.',
      patterns: [
        /\b(porn|nude|naked|orgasm|masturbat|blowjob|handjob|sexual roleplay|explicit sex)\b/i,
      ],
    },
    {
      category: 'age_inappropriate_language',
      reason: 'Profanity or requests to learn bad words are not appropriate for school tutoring.',
      patterns: [
        /\b(teach|learn|show|tell)\b.{0,30}\b(bad words?|curse words?|swear words?|abusive words?|dirty words?)\b/i,
        /\b(fuck|shit|bitch|asshole|bastard|motherfucker|cunt|dick|pussy)\b/i,
      ],
    },
    {
      category: 'dangerous_instructions',
      reason: 'Dangerous instructions are not allowed.',
      patterns: [
        /\bhow to\b.{0,40}\b(bomb|explosive|gun|poison|weapon|stab)\b/i,
        /\bshoot\b.{0,20}\b(someone|person|people|teacher|student|classmate)\b/i,
        /\b(make|build|create|assemble|hide)\b.{0,40}\b(bomb|explosive|gun|poison|weapon)\b/i,
        /\b(kill someone|murder|torture|behead|gore)\b/i,
      ],
    },
    {
      category: 'drugs',
      reason: 'Drug-use content is not appropriate for school tutoring.',
      patterns: [
        /\b(cocaine|heroin|meth|lsd|ecstasy|drug dealer|get high)\b/i,
      ],
    },
    {
      category: 'hate_or_harassment',
      reason: 'Hate or harassment content is not allowed.',
      patterns: [
        /\b(hate speech|racial superiority|nazi propaganda|genocide)\b/i,
      ],
    },
    {
      category: 'cyber_abuse',
      reason: 'Cyber abuse instructions are not allowed.',
      patterns: [
        /\b(hack|steal password|phishing|bypass security|credit card fraud)\b/i,
      ],
    },
  ];
}

function getImageSafetyRules() {
  return [
    ...getChatSafetyRules(),
    {
      category: 'realistic_people',
      reason: 'Image generation is limited to educational diagrams without realistic people.',
      patterns: [
        /\b(photo|photorealistic|realistic|portrait|selfie|face|person|people|child|kid|boy|girl|man|woman|celebrity|actor|actress)\b/i,
      ],
    },
    {
      category: 'brands_or_logos',
      reason: 'Brand and logo generation is not allowed for MVP educational diagrams.',
      patterns: [
        /\b(logo|brand|trademark)\b/i,
      ],
    },
  ];
}

function getGeminiSafetySettings() {
  return [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ].map(category => ({
    category,
    threshold: GEMINI_STRICT_SAFETY_THRESHOLD,
  }));
}

/**
 * Categories that route to a human rather than just a refusal.
 *
 * MASTERCONTEXT §12: "Anything resembling a well-being concern routes to a
 * human teacher via flag — never automated inference, never automated parent
 * notification." A refusal plus an anonymous +1 in a weekly counter, which is
 * all this used to produce, is not that.
 *
 * Deliberately narrow. Flagging profanity or a question about drugs in a
 * chemistry chapter would bury the two categories where a child may actually
 * be at risk. The flag records only *that a rule fired* — it is not a judgement
 * about the child, and no clinical construct is stored (§12).
 */
const WELFARE_REVIEW_CATEGORIES = ['self_harm', 'grooming'];

const isWelfareConcern = (category) => WELFARE_REVIEW_CATEGORIES.includes(category);

/**
 * True when the rule set almost certainly cannot assess this text.
 *
 * Every rule except the self-harm additions is English ASCII, so text in
 * another script passes unexamined. This does not block — that would break a
 * deliberately multilingual product — it exists so the limitation is
 * expressible in code and has a seam for a real classifier, instead of being
 * an invisible hole.
 */
function isLikelyUnassessable(text) {
  if (typeof text !== 'string') return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 8) return false;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, '').length;
  return latin / letters.length < 0.5;
}

module.exports = {
  SAFE_REFUSAL_MESSAGE,
  WELFARE_REVIEW_CATEGORIES,
  isWelfareConcern,
  isLikelyUnassessable,
  validateStudentMessageSafety,
  validateGeneratedTextSafety,
  validateImagePromptSafety,
  getGeminiSafetySettings,
};
