import { Agent, Runner, withTrace, tool } from '@openai/agents';
import { Logger } from '../utils/logger.js';
import {
  validateEmailTool,
  normalizeSpokenEmailTool,
  validateGSTINTool,
  validatePhoneTool,
  validatePriceRangeTool,
  normalizeListingDateTool,
  validateEmailTool as validateEmail,
  normalizeSpokenEmailTool as normalizeSpokenEmail,
  validateGSTINTool as validateGSTIN,
  validatePriceRangeTool as validatePriceRange,
  normalizeListingDateTool as normalizeListingDate
} from '../utils/validators.js';
import { searchKnowledgeBaseTool } from '../utils/vector-search.js';

// ΓöÇΓöÇΓöÇ Core Voice Context (injected into every node) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const BASE_VOICE_CONTEXT = `
IMPORTANT ΓÇö Voice & ASR Context (apply to every response):

You are a Meesho Reseller Onboarding Specialist on an outbound phone call. You represent Meesho ΓÇö India's fastest-growing e-commerce platform with 14 Cr+ customers and zero commission for sellers.

=== LANGUAGE & SPEECH QUALITY ===
- **DEFAULT LANGUAGE**: Speak in conversational **HINDI** by default.
- **PRONUNCIATION & VOCABULARY**: Use daily life words. NEVER use formal Hindi (Shuddh Hindi).
  - Use "items" or "saaman" instead of "utpaad".
  - Use "check" or "confirm" instead of "satyaapan".
  - Use "start" or "shuru" instead of "aarambh".
  - Use "profit" or "fayda" instead of "laabh".
  - Use "link" instead of "strot".
- **NUMBERS RULE**: You MUST write ALL numbers using English words (e.g., "fourteen", "two hundred", "10") so the text-to-speech engine pronounces them correctly in English. NEVER use Hindi words for numbers (e.g., avoid "chaudah", "sau", "hazaar").
- **SENTENCE STRUCTURE**: Keep Hindi sentences short. Use "Hinglish".
- **CRISP QUESTIONS**: Do NOT explain why you are asking. Just ask the question directly. No preamble like "To register you, I need..." or "For payments...".
- **ENDING RULE**: EVERY response ("say" field) MUST end with exactly ONE clear question. NEVER leave a response open-ended.
- **LANGUAGE SWITCHING**: Match the user. If they use English, you use English. If they use simple Hindi, you do the same.

=== SPEECH-TO-TEXT AWARENESS ===
ASR might be messy. Ignore filler words ("haan", "matlab", "toh"). Focus on intent.

=== BRAND VOICE & TONE ===
- Warm and friendly, like a helpful assistant.
- 1-2 sentences max per response.
- Ask ONLY ONE question at a time.
- **ACKNOWLEDGE ACKNOWLEDGMENTS**: If the user says "Haan ji boliye", "Ji bataiye", "Yes please", "Tell me", etc., they are listening. DO NOT assume they are interested. Deliver the pitch and ask "Kya aap Meesho par products bechna chahte hain?".

=== MEESHO CONTEXT ===
- Zero commission, zero penalty. Sellers keep 100% profit.
- **NO PHONE COLLECTION**: NEVER ask for their phone number.
- **CHECK CONTEXT**: Check [SYSTEM: Current session variables] before every response. Do NOT ask for information that is already present.
- **PROACTIVE CAPTURE**: If the user provides ANY information (name, items, price, email, GST) even if you didn't ask for it, you MUST capture it in the "updates_json" object immediately and acknowledge it naturally.
- **CRISP HINDI**: Use short, direct questions. Avoid "Aapka", "Jaan sakte hain", etc. if not needed.
  - "Naam kya hai?" instead of "Kya main aapka naam jaan sakta hoon?"
  - "Bank account hai?" instead of "Kya aapke paas active bank account hai?"

=== DATA TYPES FOR UPDATES_JSON ===
- 'email_valid', 'gstin_valid', 'pitch_delivered', 'summary_confirmed': **BOOLEAN** (true/false), NOT strings.
- 'price_min', 'price_max': **NUMBER** or null.
- 'products_sold': **ARRAY** of strings.
- 'interest_in_meesho': "yes" or "no".

=== RESPONSE FORMAT ===
Strictly return JSON.
{
  "say": "Short crisp Hindi/Hinglish question?",
  "updates_json": "{\"key\": \"value\"}",
  "next_node": "TARGET_NODE_NAME",
  "notes": "1-word status"
}
- "say" field MUST be the first key.
- Keep "notes" to exactly one word.
- Capture updates only for MISSING data.
`;

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "agent_response",
    strict: true,
    schema: {
      type: "object",
      properties: {
        say: { type: "string" },
        updates_json: { type: "string" },
        next_node: { type: "string" },
        notes: { type: "string" }
      },
      required: ["say", "updates_json", "next_node", "notes"],
      additionalProperties: false
    }
  }
};

// ΓöÇΓöÇΓöÇ Global Guardrails (injected into every conversational node) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const GLOBAL_GUARDRAILS = `
=== GLOBAL GUARDRAILS ===

ΓöÇΓöÇ 1. TOPIC FOCUS ΓöÇΓöÇ
Discussion MUST be Meesho seller onboarding only.

ΓöÇΓöÇ 2. DO NOT COLLECT PHONE NUMBER ΓöÇΓöÇ
NEVER ask for the phone number. We already have it from the call stream.

ΓöÇΓöÇ 3. LANGUAGE PERSISTENCE ΓöÇΓöÇ
Default to simple Hindi. Use English for numbers.

ΓöÇΓöÇ 4. CONFUSION & CALLBACK ΓöÇΓöÇ
If confused, apologize once. If still confused, route to TERM_CALLBACK.
If the caller is busy, accommodate immediately and route to TERM_CALLBACK.

ΓöÇΓöÇ 5. CROSS-NODE EXTRACTION ΓöÇΓöÇ
If the user provides information for a future step (e.g., they mention price while giving their name, or mention GST while describing products), you MUST capture that information in the 'updates_json' object immediately. 
Refer to the current session data provided to see what is already captured.

ΓöÇΓöÇ 6. TRANSITION RULE ΓöÇΓöÇ
When you are about to move to the next node (next_node), your "say" field MUST contain the first question of that next node. Do NOT just say "Let's move to the next step".

ΓöÇΓöÇ 7. HANDLING QUESTIONS ΓöÇΓöÇ
If the user asks a question about Meesho (e.g., benefits, fees, process, or T&C), you MUST set 'kb_query' in your 'updates_json' to their question. Acknowledge that you are checking, e.g., "Main check karke batati hoon." The system will provide the answer in the next turn.
`;

// ΓöÇΓöÇΓöÇ Node Specific Contexts ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const DATA_INTERPRETATION_CONTEXT = `
=== NUMBER & DATA INTERPRETATION ===
- Spoken numbers: "two nine nine" = 299, "nine hundred ninety-nine" = 999, "panch sau" = 500, "ek hazaar" = 1000.
- Spelled words: "r-o-h-i-t" or "R O H I T" ΓåÆ "rohit".
- Emails: "at" ΓåÆ @, "dot" ΓåÆ ., "dash" ΓåÆ -, "underscore" ΓåÆ _.
- GSTIN: Capture 15-character alphanumeric GSTINs. Remove spaces and uppercase.
- Phone numbers: Normalize to 10 digits if mentioned.
`;

// ΓöÇΓöÇΓöÇ NODE 1: Name + Interest ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const nameInterestAgent = new Agent({
  name: "NODE_1_NAME_INTEREST",
  instructions: `=== YOUR TASK ===
Qualify the seller. **PRIORITY**: If the user already provided their name, items, or price, CAPTURE them in 'updates_json' and move to the next MISSING question.

=== QUESTION FLOW ===
- **Identify Missing Info**: Check 'interest_in_meesho', 'name_spoken', and 'has_bank_account'.
- **Ask the next missing field**:
  1. If 'interest_in_meesho' is missing: Give the pitch ("Meesho par fourteen crore customers hain, aur yahan zero commission aur free logistics ka fayda milta hai.") then ask "Kya aap Meesho par apne products bechna chahte hain?".
  2. If interested but Name is missing: Ask "Aapka poora naam kya hai?".
  3. If interested and Name is known, but Bank Account is missing: Acknowledge their name (e.g. "Achha [Name] ji,") then ask "Kya aapke paas bank account hai?".

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_NAME | user provides name | Update 'name_spoken'. |
| INTERESTED | "yes", "theek hai", "haan", "interested", "sure" | Set interest_in_meesho: "yes". |
| NOT INTERESTED | "no", "nahi", "not interested" | Set next_node: TERM_NOT_INTERESTED. Say: "Koi baat nahi, Meesho se judne ke liye dhanyavad. Have a great day!" |
| BUSY | "call later", "busy" | Confirm time, set next_node: TERM_CALLBACK. |
| EXTRA INFO | user gives price/items | Capture in 'updates_json'. |

=== ROUTING ===
- Stay in NODE_1_NAME_INTEREST until 'interest_in_meesho', 'name_spoken', AND 'has_bank_account' are fully captured.
- Once all are captured, set next_node: NODE_2_DETAILS and your 'say' field MUST contain the first question of Node 2: "Aap kis tarah ke items bechte hain?"
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [searchKnowledgeBaseTool]
});

// ΓöÇΓöÇΓöÇ NODE 2: Business Details ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const detailsAgent = new Agent({
  name: "NODE_2_DETAILS",
  instructions: `=== YOUR TASK ===
Collect business details. **CHECK SYSTEM CONTEXT**: If the user already mentioned items or price range, do NOT ask for them. Capture any remaining info.

=== QUESTION FLOW ===
1. **Items**: If 'products_sold' is empty, ask: "Achha, toh aap kis tarah ke items bechte hain?"
2. **Price**: If 'price_min' is missing AND 'raw_price_min' is missing, ask: "Aur in items ki price range kya rehti hai?". If 'raw_price_min' is present but looks like text, ask for numerical confirmation.
3. **Speed**: If 'listing_start' is missing AND 'raw_listing_start' is missing, ask: "Aap kabse meesho pey list karna start karna chahte hai?"
   - When they answer, set 'raw_listing_start' in 'updates_json' to EXACTLY what they said.

=== RULES ===
- EVERY 'say' must end with a question mark.
- If user provides price range (e.g. "100-200" or "so se do so"), you MUST extract numerical values for 'raw_price_min' and 'raw_price_max' and put them in 'updates_json'.
- NEVER ask the price range if 'price_min' or 'raw_price_min' is present in context.

=== ROUTING ===
- Stay in NODE_2_DETAILS until all questions are answered ('products_sold', 'price_min'/'raw_price_min', and 'listing_start'/'raw_listing_start' are collected).
- Once done, set next_node: NODE_3_CONTACT_GST and your 'say' MUST contain the first question: "Aapka email address kya hai?"`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validatePriceRangeTool, normalizeListingDateTool, searchKnowledgeBaseTool]
});

// ΓöÇΓöÇΓöÇ NODE 3: Email + GSTIN ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const contactGstAgent = new Agent({
  name: "NODE_3_CONTACT_GST",
  instructions: `=== YOUR TASK ===
Collect email and GST. **CHECK SYSTEM CONTEXT**: If the email or GST was already provided in earlier nodes, do NOT ask for them. Skip to the next missing field or finish.

=== QUESTION FLOW ===
1. **Email**: If 'email' is missing AND 'raw_email' is missing, ask: "Kya aap apna email address bata sakte hai?"
2. **GST**: If 'gstin' is missing AND 'raw_gstin' is missing AND 'gst_declined' is not true, ask: "Kya aapke paas 15-digit GST number hai?"
3. **UIN (Fallback)**: If 'gst_declined' is true AND 'uin' is missing, ask: "Meesho par bina GST ke list karne ke liye Enrollment ID ya UIN lagta hai. Kya aapke paas wo hai?"

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_EMAIL | user provides email | Say "Ek minute." Set 'raw_email' in 'updates_json'. |
| HAS_GST | "yes", "ha", "uh-huh", "i have it" | Say "Kripya apna 15-digit GST number bataye." |
| GIVING_GST | user provides GST | Set 'raw_gstin' in 'updates_json'. |
| NO_GST | "don't have gst", "no", "nahi hai" | Set 'gst_declined': true in 'updates_json'. Ask for UIN/Enrollment ID. |
| GIVING_UIN | user provides UIN/Enrollment ID | Update 'uin' in 'updates_json', move to Node 4. |
| NO_UIN | "don't have it", "no" | Set next_node: TERM_NO_REGISTRATION. Say: "Maaf kijiyega, bina GST ya Enrollment ID ke hum registration aage nahi badha sakte. Samay dene ke liye dhanyavad!" |

=== ROUTING ===
- Stay in NODE_3 until Email and (GST OR UIN) are captured.
- Move to NODE_4_CLOSURE naturally once done. Your 'say' MUST be the first question of Node 4.
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [searchKnowledgeBaseTool]
});

// ΓöÇΓöÇΓöÇ NODE 4: QnA & Closure ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const closureAgent = new Agent({
  name: "NODE_4_CLOSURE",
  instructions: `=== YOUR TASK ===
Thank the user for their time and details, then proactively ask if they have any questions about Meesho (benefits, commission, shipping, etc.).

=== FLOW ===
1. **Initial Closing**: Thank the user for sharing their details. Inform them about the WhatsApp link for verification. 
   Say: "Details share karne ke liye bahut dhanyavad. Hamari team aapko ek WhatsApp link bhejegi documents upload karne ke liye. Kya aapko Meesho ke baare mein kuch aur jaanna hai?"
2. **Handle Questions**: If the user asks a question, you MUST set 'kb_query' in 'updates_json' to their question.
   - Reply with: "Zaroor, main check karke batati hoon." 
   - Wait for the system to provide the Knowledge Base info in the next turn.
3. **Handle No Questions / Post-Answer**: If the user says they have no questions (e.g. "no", "nahi", "nothing", "that's it", "theek hai"), or if you have just answered their questions and they are satisfied:
   - Final Say: "Zaroor. Documents verify hone ke baad aap Meesho par listing shuru kar sakenge. Aapka samay dene ke liye bahut dhanyavad! Have a nice day!"
   - Set "next_node": "TERM_COMPLETE".

=== RULES ===
- NEVER end the call immediately after taking details. Always ask "Kya aapko kuch aur jaanna hai?".
- Only use "TERM_COMPLETE" when the user confirms they are done or have no more questions.
- If they ask multiple questions, repeat the process: set 'kb_query', acknowledge, and then answer in the next turn.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [searchKnowledgeBaseTool]
});

// ΓöÇΓöÇΓöÇ Routing Map ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const NODE_AGENTS = {
  // NODE_0_WELCOME: Bypassed directly in getWelcome() to avoid framework overhead
  NODE_1_NAME_INTEREST: nameInterestAgent,
  NODE_2_DETAILS: detailsAgent,
  NODE_3_CONTACT_GST: contactGstAgent,
  NODE_4_CLOSURE: closureAgent,
};

export const TERMINAL_NODES = new Set([
  'TERM_NOT_INTERESTED',
  'TERM_CALLBACK',
  'TERM_WRONG_PERSON',
  'TERM_COMPLETE',
  'TERM_NO_REGISTRATION'
]);

// ΓöÇΓöÇΓöÇ Default Session State ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const DEFAULT_SESSION = {
  caller_phone: '',
  // Node 1
  name_spoken: '',
  is_right_person: 'unknown',
  interest_in_meesho: 'unknown',
  has_bank_account: '',
  callback_time: '',
  pitch_delivered: false,
  // Node 2
  products_sold: [],
  price_min: null,
  price_max: null,
  switch_speed_days: null,
  switch_speed_bucket: '',
  listing_start: '',
  // Node 3
  email: '',
  email_valid: false,
  email_attempts: 0,
  gstin: '',
  gstin_valid: false,
  gst_declined: false,
  uin: '',
  gst_attempts: 0,
  pan_number: '',
  pan_skipped: false,
  // Node 4
  questions_asked: 0,
  summary_confirmed: false,
  call_outcome: '',
  correction_requested: '',
  // Progress flags
  node0_done: false,
  node1_done: false,
  node2_done: false,
  node3_done: false,
  node4_done: false,
};

// ΓöÇΓöÇΓöÇ Helper: Sanitize message content for OpenAI API ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function sanitizeMessage(msg) {
  if (!msg.content) return msg;

  const role = msg.role;
  let newContent = msg.content;

  if (typeof newContent === 'string') {
    // Top-level strings are fine, the SDK converts them
    return msg;
  }

  if (Array.isArray(newContent)) {
    newContent = newContent.map(item => {
      if (typeof item === 'string') return item;
      if (item.type === 'text') {
        const type = (role === 'assistant') ? 'output_text' : 'input_text';
        return { ...item, type };
      }
      return item;
    });
  }

  return { ...msg, content: newContent };
}

// ΓöÇΓöÇΓöÇ Helper: Parse agent output ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function parseAgentOutput(rawOutput) {
  if (!rawOutput) return { say: '', updates: {}, next_node: 'CONTINUE', notes: '' };

  let text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);

  // Clean up potential markdown or preambles
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  // Strip markdown code fences if they survived
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const parsed = JSON.parse(text);
    let updatesObj = {};
    if (parsed.updates_json && parsed.updates_json !== '{}') {
      try { updatesObj = JSON.parse(parsed.updates_json); } catch (e) { }
    } else if (parsed.updates && typeof parsed.updates === 'object') {
      updatesObj = parsed.updates;
    }
    return {
      say: parsed.say || '',
      updates: updatesObj,
      next_node: parsed.next_node || 'CONTINUE',
      notes: parsed.notes || ''
    };
  } catch (err) {
    console.error('[Workflow] JSON Parse Error:', err.message);
    console.error('[Workflow] Problematic String:', text.substring(0, 1000));

    // Fallback: If it's not valid JSON, but maybe has a "say" field we can regex out?
    const sayMatch = text.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (sayMatch) {
      const extractedSay = sayMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      return {
        say: extractedSay,
        updates: {},
        next_node: 'CONTINUE',
        notes: 'partial_parse_success'
      };
    }

    return {
      say: "I'm sorry, my system is having a bit of trouble. Could you please repeat that?",
      updates: {},
      next_node: 'CONTINUE',
      notes: 'parse_error'
    };
  }
}

// ΓöÇΓöÇΓöÇ Session Factory ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export function createCallSession(callerPhone = '', options = {}) {
  const conversationHistory = [];
  const session = { ...DEFAULT_SESSION, caller_phone: callerPhone };
  let currentNode = 'NODE_0_WELCOME';
  let currentProcessingId = 0;

  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "voice-ai-platform",
      workflow_id: "wf_meesho_reseller_v3"
    }
  });

  // ΓöÇΓöÇ Internal runner ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

  async function runNode(agent, userMessage, onSayChunk) {
    return await withTrace("Reseller Qualification", async () => {
      // Create a static System Message to reduce input tokens in instructions
      const systemMessage = sanitizeMessage({
        role: 'system',
        content: `${BASE_VOICE_CONTEXT}\n${GLOBAL_GUARDRAILS}\n${DATA_INTERPRETATION_CONTEXT}`
      });

      if (userMessage) {
        conversationHistory.push(sanitizeMessage({
          role: 'user',
          content: userMessage
        }));
      }

      // Limit conversation history to last 10 turns and sanitize
      const trimmedHistory = conversationHistory.slice(-10).map(sanitizeMessage);

      const stream = await runner.run(agent, [systemMessage, ...trimmedHistory], { stream: true });

      let finalOutputText = "";
      let sentLength = 0;

      for await (const event of stream) {
        if (!event.type.includes('raw_model')) {
          console.log(`[Stream Event]`, event.type);
        }

        // Handle raw string events (non-tool calls)
        if (event.type === 'raw_model_stream_event' && event.data?.type === 'text_stream') {
          finalOutputText += event.data.text;
        }
        // Handle @openai/agents v0.0.5 structured json streaming object deltas
        else if (event.type === 'run_item_stream_event' && event.event === 'item.update') {
          const contentObj = event.item?.content?.find(c => c.type === 'text' || c.type === 'json');
          if (contentObj && contentObj.text) {
            finalOutputText = contentObj.text; // the framework accumulates the full string here
          }
        }
        else if (event.type === 'model_text_delta') {
          finalOutputText += event.data.textDelta || event.data.delta || '';
        }

        // Try to parse 'say' from whatever we've accumulated so far
        if (onSayChunk && finalOutputText) {
          // Look for "say": "..." pattern. Handle opening quote through current end.
          const sayMatch = finalOutputText.match(/"say"\s*:\s*"([^"]*)/);
          if (sayMatch) {
            const currentSay = sayMatch[1];
            // Unescape common JSON characters
            const unescaped = currentSay.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

            if (unescaped.length > sentLength) {
              const chunk = unescaped.substring(sentLength);
              sentLength = unescaped.length;
              onSayChunk(chunk);
            }
          }
        }
      }

      await stream.completed;
      // Sanitize new items before storing
      const newItems = stream.newItems.map(item => sanitizeMessage(item.rawItem));
      conversationHistory.push(...newItems);
      return stream.finalOutput;
    });
  }

  // ΓöÇΓöÇ Mark node as done when leaving it ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

  function markNodeDone(nodeName) {
    const match = nodeName.match(/NODE_(\d)/);
    if (match) {
      session[`node${match[1]}_done`] = true;
    }
  }

  // ΓöÇΓöÇ Public API ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

  // Callback to check if stream is still active
  let isActiveCallback = () => true;

  function setIsActiveCallback(cb) {
    isActiveCallback = cb;
  }

  async function getWelcome() {
    markNodeDone('NODE_0_WELCOME');
    currentNode = 'NODE_1_NAME_INTEREST';
    return "Namaste! Main Meesho seller onboarding team se Asmita bol rahi hoon.";
  }

  // --- Regex Fast-Path Configuration ---
  const FAST_MATCH_CONFIG = {
    'NODE_1_NAME_INTEREST': [
      {
        pattern: /^(mera naam|my name is|main|i am|this is|αñ«αÑçαñ░αñ╛ αñ¿αñ╛αñ«|αñ«αÑêαñé) (.*?)(?: hai| hoon|αñ╣αÑê|αñ╣αÑéαñé)?$/i,
        handle: (match, session) => {
          const name = match[2].trim();
          if (!session.interest_in_meesho || session.interest_in_meesho === 'unknown') {
            if (session.pitch_delivered) {
              return {
                updates: { name_spoken: name },
                say: `Achha, ${name} ji. Toh kya aap Meesho par apne products bechna chahte hain?`,
                next_node: 'CONTINUE'
              };
            }
            return {
              updates: { name_spoken: name, pitch_delivered: true },
              say: `Achha, ${name} ji. Meesho par fourteen crore se zyada customers hain, aur yahan zero commission aur zero logistics charges ka fayda milta hai. Kya aap Meesho par apne products bechna chahte hain?`,
              next_node: 'CONTINUE'
            };
          }
          return {
            updates: { name_spoken: name },
            say: `Achha, ${name} ji. Kya aapke paas bank account hai?`,
            next_node: 'CONTINUE'
          };
        }
      },
      {
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|interested|i am interested|main interested hoon|haan ji boliye|ji bataiye|bataiye|ji boliye|αñ╣αñ╛αñé|αñ╣αñ╛|αñ£αÑÇ|αñáαÑÇαñò αñ╣αÑê|αñ¼αñ┐αñ▓αÑìαñòαÑüαñ▓|αñ£αñ╝αñ░αÑéαñ░|αñ╣αñ╛αñéαñ£αÑÇ|αñ£αÑÇ αñ¼αÑïαñ▓αñ┐αñÅ|αñ£αÑÇ αñ¼αññαñ╛αñçαñÅ|αñ¼αññαñ╛αñçαñÅ|αñ╣αñ╛αñé αñ£αÑÇ αñ¼αÑïαñ▓αñ┐αñÅ)$/i,
        handle: (match, session) => {
          if (!session.interest_in_meesho || session.interest_in_meesho === 'unknown') {
            // Let the LLM definitively handle "haan" if the pitch was just delivered
            return null;
          } else if (session.name_spoken && !session.has_bank_account) {
            return {
              updates: { has_bank_account: 'yes' },
              say: "Achha, toh bank account hai. Aap kis tarah ke items bechte hain?",
              next_node: 'NODE_2_DETAILS'
            };
          }
          return null;
        }
      },
      {
        pattern: /^(nahi|na|no|nhi|reject|bilkul nahi|not interested|αñ¿αñ╣αÑÇαñé|αñ¿|αñ¿αÑï|αñ¼αñ┐αñ▓αÑìαñòαÑüαñ▓ αñ¿αñ╣αÑÇαñé)$/i,
        updates: { interest_in_meesho: 'no' },
        say: "Achha, koi baat nahi. Agar aapka mann badle toh humein zaroor batayiye. Dhanyavad!",
        next_node: 'TERM_NOT_INTERESTED'
      }
    ],
    'NODE_2_DETAILS': [
      {
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|αñ╣αñ╛αñé|αñ╣αñ╛|αñ£αÑÇ|αñáαÑÇαñò αñ╣αÑê|αñ¼αñ┐αñ▓αÑìαñòαÑüαñ▓|αñ£αñ╝αñ░αÑéαñ░|αñ╣αñ╛αñéαñ£αÑÇ)$/i,
        handle: (match, session) => {
          return null; // Let LLM extract proper intent if needed
        }
      }
    ],
    'NODE_3_CONTACT_GST': [
      {
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|αñ╣αñ╛αñé|αñ╣αñ╛|αñ£αÑÇ|αñáαÑÇαñò αñ╣αÑê|αñ¼αñ┐αñ▓αÑìαñòαÑüαñ▓|αñ£αñ╝αñ░αÑéαñ░|αñ╣αñ╛αñéαñ£αÑÇ|αñ£αÑÇ αñ¼αÑïαñ▓αñ┐αñÅ|αñ£αÑÇ αñ¼αññαñ╛αñçαñÅ|αñ¼αññαñ╛αñçαñÅ|αñ╣αñ╛αñé αñ£αÑÇ αñ¼αÑïαñ▓αñ┐αñÅ)$/i,
        handle: (match, session) => {
          if (!session.email_valid && session.email_attempts === 0) {
            return {
              updates: {},
              say: "Achi baat hai, kripya apna email address bataiye.",
              next_node: 'CONTINUE'
            };
          } else if (!session.gstin && !session.gst_declined) {
            return {
              updates: { has_gst_number: 'yes' },
              say: "Sunke khushi hui! Aapka 15-digit ka GST number kya hai?",
              next_node: 'CONTINUE'
            };
          }
          return null;
        }
      }
    ]
  };

  function checkFastMatch(text) {
    if (!text) return false;
    const cleanText = text.trim().toLowerCase().replace(/[.,?!|αÑñ]/g, '');
    if (FAST_MATCH_CONFIG[currentNode]) {
      for (const entry of FAST_MATCH_CONFIG[currentNode]) {
        if (cleanText.match(entry.pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  async function processTranscript(transcript, tts = null, silenceFiller = null) {
    currentProcessingId++;
    const currentProcId = currentProcessingId;
    const cleanTranscript = transcript.trim().toLowerCase().replace(/[.,?!|αÑñ]/g, '');
    let fastMatchResult = null;

    // --- Helpers ---
    const runTool = async (toolObj, params) => {
      if (toolObj.execute) return await toolObj.execute(params);
      if (typeof toolObj === 'function') return await toolObj(params);
      throw new Error('Tool object is not executable');
    };

    const handleBackgroundTasks = (output) => {
      if (!output || !output.updates) return;
      const updates = output.updates;

      // 1. Email
      if (updates.raw_email && !session.bg_email_running) {
        session.bg_email_running = true;
        const candidate = updates.raw_email;
        Promise.resolve().then(async () => {
          try {
            if (silenceFiller) silenceFiller.pause();
            const normStr = await runTool(normalizeSpokenEmailTool, { spoken_email: candidate });
            const norm = typeof normStr === 'string' ? JSON.parse(normStr) : normStr;
            const valStr = await runTool(validateEmailTool, { email: norm.normalized_email });
            const val = typeof valStr === 'string' ? JSON.parse(valStr) : valStr;

            if (val?.valid) {
              session.email = val.normalized;
              session.email_valid = true;
              if (options.logger) {
                options.logger.withComponent('Validation').info('[Background] Email Validated');
                options.logger.withComponent('Database').info('Saving session updates', { updates: { email: val.normalized, email_valid: true } });
              }
            } else if (!val?.valid && currentProcId === currentProcessingId) {
              session.email_valid = false;
              session.email_attempts = (session.email_attempts || 0) + 1;
              if (isActiveCallback()) {
                if (options.logger) options.logger.withComponent('Validation').warn('[Background] Email Invalid', val);
                await processTranscript(`[SYSTEM: Email "${candidate}" is invalid: ${val ? val.error : 'format error'}. Politely ask the user to correct it.]`, tts, silenceFiller);
              }
            }
          } catch (e) {
            console.error(e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              if (options.logger) options.logger.withComponent('Validation').error('[Background] Email check crashed', e);
              await processTranscript(`[SYSTEM: Verification failed due to internal tool error. Ask for email again politely.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_email_running = false;
            if (session.email_valid) {
              delete session.raw_email;
            }
            if (silenceFiller && !tts?.isSpeaking) silenceFiller.resume();
          }
        });
      }

      // 2. GST
      if (updates.raw_gstin && !session.bg_gst_running) {
        session.bg_gst_running = true;
        const candidate = updates.raw_gstin;
        Promise.resolve().then(async () => {
          try {
            if (silenceFiller) silenceFiller.pause();
            const valStr = await runTool(validateGSTINTool, { gstin: candidate });
            const val = typeof valStr === 'string' ? JSON.parse(valStr) : valStr;

            if (val?.valid && currentProcId === currentProcessingId) {
              session.gstin = val.normalized;
              session.gstin_valid = true;
              if (isActiveCallback()) {
                if (options.logger) options.logger.withComponent('Validation').info('[Background] GST Validated');
                if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { gstin: val.normalized, gstin_valid: true } });
              }
            } else if (!val?.valid && currentProcId === currentProcessingId) {
              session.gstin_valid = false;
              session.gst_attempts = (session.gst_attempts || 0) + 1;
              if (isActiveCallback()) {
                if (options.logger) options.logger.withComponent('Validation').warn('[Background] GST Invalid', val);
                await processTranscript(`[SYSTEM: GST "${candidate}" is invalid: ${val ? val.error : 'format error'}. Ask the user for the correct 15-digit GST number.]`, tts, silenceFiller);
              }
            }
          } catch (e) {
            console.error(e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              if (options.logger) options.logger.withComponent('Validation').error('[Background] GST check crashed', e);
              await processTranscript(`[SYSTEM: Verification failed due to internal tool error. Apologize and ask for GST again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_gst_running = false;
            if (session.gstin_valid) {
              delete session.raw_gstin;
            }
            if (silenceFiller && !tts?.isSpeaking) silenceFiller.resume();
          }
        });
      }

      // 3. Listing Date Normalization
      if (updates.raw_listing_start && !session.bg_listing_running) {
        session.bg_listing_running = true;
        const candidate = updates.raw_listing_start;
        Promise.resolve().then(async () => {
          try {
            const todayISO = new Date().toISOString().split('T')[0];
            const resStr = await runTool(normalizeListingDateTool, { spoken_date: candidate, current_date_iso: todayISO });
            const res = typeof resStr === 'string' ? JSON.parse(resStr) : resStr;
            if (res?.valid) {
              session.listing_start = res.normalized;
              if (options.logger) options.logger.withComponent('Validation').info('[Background] Date Normalized', { date: res.normalized });
              if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { listing_start: res.normalized } });
            }
          } catch (e) {
            console.error(e);
            if (options.logger) options.logger.withComponent('Validation').error('[Background] Listing Date tool crashed', e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              await processTranscript(`[SYSTEM: Listing Date validation failed due to internal error. Ask the user for the date again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_listing_running = false;
            if (session.listing_start) {
              delete session.raw_listing_start;
            }
          }
        });
      }

      // 4. Price Range Validation
      if ((updates.raw_price_min || updates.raw_price_max) && !session.bg_price_running) {
        session.bg_price_running = true;
        let originalMin = updates.raw_price_min || session.price_min || "";
        let originalMax = updates.raw_price_max || session.price_max || "";
        let pMin = parseFloat(updates.raw_price_min !== undefined ? updates.raw_price_min : session.price_min || 0);
        let pMax = parseFloat(updates.raw_price_max !== undefined ? updates.raw_price_max : session.price_max || 0);

        Promise.resolve().then(async () => {
          try {
            if (isNaN(pMin) || isNaN(pMax)) {
              if (options.logger) options.logger.withComponent('Validation').warn('[Background] Price is text, asking LLM to confirm', { min: originalMin, max: originalMax });
              if (isActiveCallback() && currentProcId === currentProcessingId) {
                await processTranscript(`[SYSTEM: The price you captured ("${originalMin}" - "${originalMax}") is text. Ask the user to confirm the numerical price range, e.g. "Matlab, Γé╣100 se Γé╣200 tak?"]`, tts, silenceFiller);
              }
              return;
            }

            const resStr = await runTool(validatePriceRangeTool, { price_min: pMin, price_max: pMax });
            const res = typeof resStr === 'string' ? JSON.parse(resStr) : resStr;
            if (res?.valid) {
              session.price_min = res.price_min;
              session.price_max = res.price_max;
              if (options.logger) options.logger.withComponent('Validation').info('[Background] Price Validated', { min: res.price_min, max: res.price_max });
              if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { price_min: res.price_min, price_max: res.price_max } });
            }
          } catch (e) {
            console.error(e);
            if (options.logger) options.logger.withComponent('Validation').error('[Background] Price Range tool crashed', e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              await processTranscript(`[SYSTEM: Price Range validation failed due to internal error. Ask the user for the price range again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_price_running = false;
            if (session.price_min && !isNaN(parseFloat(session.price_min))) {
              delete session.raw_price_min;
              delete session.raw_price_max;
            }
          }
        });
      }

      // 5. KB
      if (updates.kb_query) {
        const query = updates.kb_query;
        delete updates.kb_query;
        Promise.resolve().then(async () => {
          try {
            const kbResult = await runTool(searchKnowledgeBaseTool, { query });
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              if (options.logger) options.logger.info(`[KnowledgeBase] Answer Found for: ${query}`);
              await processTranscript(`[SYSTEM: Knowledge Base Results: ${kbResult}]`, tts, silenceFiller);
            }
          } catch (e) {
            console.error(e);
            if (options.logger) options.logger.withComponent('KnowledgeBase').error('[Background] KB Query crashed', e);
          }
        });
      }
    };

    // 1. Check Fast-Match Regex (Speed Path)
    if (FAST_MATCH_CONFIG[currentNode]) {
      for (const entry of FAST_MATCH_CONFIG[currentNode]) {
        const match = cleanTranscript.match(entry.pattern);
        if (match) {
          // Rule: Never end conversation based on regex
          if (entry.next_node && entry.next_node.startsWith('TERM_')) continue;

          fastMatchResult = typeof entry.handle === 'function' ? entry.handle(match, session) : entry;
          if (!fastMatchResult) continue; // fallback to LLM if handle rejected it

          if (options.logger) options.logger.info(`[Fast-Match] Predictive match: ${cleanTranscript}`);
          if (tts && isActiveCallback()) {
            tts.sendText(fastMatchResult.say);
            tts.flush();
          }
          break;
        }
      }
    }

    // 2. Start LLM (Ground Truth Path) in Parallel
    const agent = NODE_AGENTS[currentNode];
    if (!agent) {
      if (TERMINAL_NODES.has(currentNode)) {
        return { say: "", next_node: currentNode, session: { ...session } };
      }
      return { say: "Samay dene ke liye dhanyavad. Alvida!", next_node: 'TERM_COMPLETE', session: { ...session } };
    }

    let userMessage = transcript;
    if (currentNode !== 'NODE_0_WELCOME') {
      const activeData = Object.fromEntries(Object.entries(session).filter(([k, v]) => k !== 'caller_phone' && v !== '' && v !== null && v !== 0 && (Array.isArray(v) ? v.length > 0 : true)));
      userMessage = `${transcript}\n\n[SYSTEM: Date: ${new Date().toISOString().split('T')[0]}, Session: ${JSON.stringify(activeData)}]`;
    }

    let streamedCount = 0;

    const llmPromise = (async () => {
      try {
        let ttsBuffer = "";
        const raw = await Logger.runWithContext(options.logger?.context || {}, async () => {
          return await runNode(agent, userMessage, (chunk) => {
            if (!fastMatchResult && tts && isActiveCallback()) {
              streamedCount += chunk.length;
              ttsBuffer += chunk;
              if (/[.,?!|αÑñ, ]/.test(ttsBuffer) || ttsBuffer.split(/\s+/).length >= 6) {
                const bIdx = ttsBuffer.search(/[.,?!|αÑñ,]/) + 1 || ttsBuffer.length;
                if (bIdx > 0 || ttsBuffer.split(/\s+/).length >= 6) {
                  const toSendArr = ttsBuffer.substring(0, bIdx || ttsBuffer.length);
                  tts.sendText(toSendArr);
                  ttsBuffer = ttsBuffer.substring(bIdx || ttsBuffer.length);
                }
              }
            }
          });
        });
        if (ttsBuffer.trim() && !fastMatchResult && tts && isActiveCallback()) {
          tts.sendText(ttsBuffer);
          streamedCount += ttsBuffer.length;
        }

        const parsed = parseAgentOutput(raw);
        // Fallback: If for some reason streaming didn't send anything (but logic says it should have), send it now.
        if (streamedCount === 0 && parsed.say && !fastMatchResult && tts && isActiveCallback()) {
          tts.sendText(parsed.say);
        }
        return parsed;
      } catch (e) {
        if (options.logger) options.logger.error('[Workflow] llmPromise error', e);
        return null;
      }
    })();

    // 3. Race Resolution
    if (fastMatchResult) {
      llmPromise.then(async (actual) => {
        if (!actual) return;
        handleBackgroundTasks(actual);

        // Verification: Regex positive vs LLM negative/terminal
        const predY = (fastMatchResult.updates?.interest_in_meesho === 'yes' || fastMatchResult.updates?.has_bank_account === 'yes');
        const actN = (actual.updates?.interest_in_meesho === 'no' || actual.updates?.has_bank_account === 'no');
        const termC = (actual.next_node && actual.next_node.startsWith('TERM_'));

        // Name check
        const nameMismatch = fastMatchResult.updates?.name_spoken && actual.updates?.name_spoken && fastMatchResult.updates.name_spoken !== actual.updates.name_spoken;

        if ((predY && actN) || termC || nameMismatch) {
          if (options.logger) options.logger.warn(`[Conflict] LLM override. nameMismatch=${nameMismatch}`);
          if (isActiveCallback()) {
            tts?.sendText("Maaf kijiyega, maine shayad galat suna. " + actual.say);
            Object.assign(session, actual.updates);
            if (options.logger && Object.keys(actual.updates || {}).length > 0) {
              options.logger.withComponent('Database').info('Saving session updates', { updates: actual.updates });
            }
            currentNode = actual.next_node === 'CONTINUE' ? currentNode : actual.next_node;
          }
        } else {
          Object.assign(session, actual.updates);
          if (options.logger && Object.keys(actual.updates || {}).length > 0) {
            options.logger.withComponent('Database').info('Saving session updates', { updates: actual.updates });
          }
        }
      });

      const nextNode = fastMatchResult.next_node === 'CONTINUE' ? currentNode : fastMatchResult.next_node;
      if (nextNode !== currentNode) markNodeDone(currentNode);
      currentNode = nextNode;
      Object.assign(session, fastMatchResult.updates);
      if (options.logger && Object.keys(fastMatchResult.updates || {}).length > 0) {
        options.logger.withComponent('Database').info('Saving session updates', { updates: fastMatchResult.updates });
      }

      return { say: fastMatchResult.say, next_node: nextNode, notes: 'Fast-match', session: { ...session }, streamedByNode: true };
    }

    // Standard Path
    const finalLLMOutput = await llmPromise;
    if (!finalLLMOutput) return { say: "Kripya phir se kahiye?", next_node: currentNode, session: { ...session }, streamedByNode: false };

    if (finalLLMOutput.updates) {
      Object.assign(session, finalLLMOutput.updates);
      if (options.logger && Object.keys(finalLLMOutput.updates).length > 0) {
        options.logger.withComponent('Database').info('Saving session updates', { updates: finalLLMOutput.updates });
      }
    }
    handleBackgroundTasks(finalLLMOutput);

    const prevNode = currentNode;
    const nextNode = finalLLMOutput.next_node === 'CONTINUE' ? currentNode : finalLLMOutput.next_node;
    if (nextNode !== prevNode) markNodeDone(prevNode);
    currentNode = nextNode;

    return { say: finalLLMOutput.say, next_node: nextNode, notes: finalLLMOutput.notes, session: { ...session }, streamedByNode: true };
  }

  return {
    getWelcome,
    processTranscript,
    setIsActiveCallback,
    checkFastMatch,
    getCurrentNode: () => currentNode,
    getSession: () => ({ ...session }),
    isTerminal: () => TERMINAL_NODES.has(currentNode),
  };
}
