import { Agent, Runner, withTrace, tool } from '@openai/agents';
import { Logger } from '../utils/logger.js';
import {
  validateEmailTool,
  normalizeSpokenEmailTool,
  validatePriceRangeTool,
  normalizeListingDateTool
} from '../utils/validators.js';
import { searchKnowledgeBaseTool } from '../utils/vector-search.js';

// ─── Core Voice Context (injected into every node) ────────────────────────────
const BASE_VOICE_CONTEXT = `
IMPORTANT — Voice & ASR Context (apply to every response):

You are a Meesho Reseller Onboarding Specialist on an outbound phone call. You represent Meesho — India's fastest-growing e-commerce platform with 21 Cr+ customers and zero commission for sellers.

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

=== KNOWLEDGE BASE QUERIES ===
- If the user asks a question about Meesho (e.g., benefits, commission, registration help, "How to list?"):
  - You MUST set 'kb_query' in your 'updates_json' to the user's specific question.
  - Your 'say' should be: "Zaroor, main check karke batati hoon."
  - The system will provide the answer in the next turn as "[SYSTEM: Knowledge Base Results: ...]".
  - When you receive results, explain them simply in Hindi and ask: "Kya aapko kuch aur jaanna hai?"

=== SPEECH-TO-TEXT AWARENESS ===
ASR might be messy. Ignore filler words ("haan", "matlab", "toh"). Focus on intent.

=== BRAND VOICE & TONE ===
- Warm and friendly, like a helpful assistant.
- 1-2 sentences max per response.
- Ask ONLY ONE question at a time.
- **ACKNOWLEDGE ACKNOWLEDGMENTS**: If the user says "Haan ji boliye", "Ji bataiye", "Yes please", "Tell me", etc., they are listening. DO NOT assume they are interested. If the pitch has not been delivered yet, proceed to deliver it and ask for interest as per node instructions.

=== MEESHO CONTEXT ===
- Zero commission, zero penalty. Sellers keep 100% profit.
- **NO PHONE COLLECTION**: NEVER ask for their phone number.
- **CHECK CONTEXT**: Check [SYSTEM: Current session variables] before every response. Do NOT ask for information that is already present.
- **PROACTIVE CAPTURE**: If the user provides ANY information (name, items, price, email, GST) even if you didn't ask for it, you MUST capture it in the "updates_json" object immediately and acknowledge it naturally.
- **CRISP HINDI**: Use short, direct questions. Avoid "Aapka", "Jaan sakte hain", etc. if not needed.
  - "Naam kya hai?" instead of "Kya main aapka naam jaan sakta hoon?"
  - "Bank account hai?" instead of "Kya aapke paas active bank account hai?"

=== DATA TYPES FOR UPDATES_JSON ===
- ALL yes/no fields (email_valid, gstin_valid, pitch_delivered, interest_in_meesho, has_bank_account): Use "yes" or "no" (string), NOT true/false.
- 'price_min', 'price_max': **NUMBER** or null.
- 'products_sold': **ARRAY** of strings.

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

// ─── Global Guardrails (injected into every conversational node) ──────────────
const GLOBAL_GUARDRAILS = `
=== GLOBAL GUARDRAILS ===

── 1. TOPIC FOCUS ──
Discussion MUST be Meesho seller onboarding only.

── 2. DO NOT COLLECT PHONE NUMBER ──
NEVER ask for the phone number. We already have it from the call stream.

── 3. LANGUAGE PERSISTENCE ──
Default to simple Hindi. Use English for numbers.

── 4. CONFUSION & CALLBACK ──
If confused, apologize once. If still confused, route to TERM_CALLBACK.
If the caller is busy, accommodate immediately and route to TERM_CALLBACK.

── 5. CROSS-NODE EXTRACTION & SKIP RULE ──
If the user provides information for a future step (e.g., they mention price while giving their name, or mention GST while describing products), you MUST capture that information in the 'updates_json' object immediately.
**SKIP RULE**: Before asking ANY question, check the [SYSTEM: Session] variables. If a field is already captured (non-empty), you MUST SKIP that question and move to the next MISSING field. NEVER re-ask for information already present in the session.

── 6. TRANSITION RULE ──
When you are about to move to the next node (next_node), your "say" field MUST contain the first question of that next node. Do NOT just say "Let's move to the next step".

── 7. HANDLING QUESTIONS ──
If the user asks a question about Meesho (e.g., benefits, fees, process, or T&C), you MUST set 'kb_query' in your 'updates_json' to their question. Acknowledge that you are checking, e.g., "Main check karke batati hoon." The system will provide the answer in the next turn.
**ACCURACY**: Once Knowledge Base results arrive, provide the ACTUAL answer immediately. If the data says "7 days", your answer MUST be "7 days" (7 din). Do NOT hallucinate.
── 8. PRICE EXTRACTION ──
If the user mentions a price range (e.g., "100 to 200"), ALWAYS extract both 'raw_price_min': 100 AND 'raw_price_max': 200.
`;

// ─── Node Specific Contexts ───────────────────────────────────────────────────
const DATA_INTERPRETATION_CONTEXT = `
=== NUMBER & DATA INTERPRETATION ===
- Spoken numbers: "two nine nine" = 299, "nine hundred ninety-nine" = 999, "panch sau" = 500, "ek hazaar" = 1000.
- Spelled words: "r-o-h-i-t" or "R O H I T" → "rohit".
- Emails: "at" → @, "dot" → ., "dash" → -, "underscore" → _.
- Emails: "at" → @, "dot" → ., "dash" → -, "underscore" → _.
- GSTIN: Capture 15-character alphanumeric GSTINs. Remove spaces and uppercase. **CRITICAL**: Alphanumeric must be captured as English characters (A-Z, 0-9).
- Phone numbers: Normalize to 10 digits if mentioned.
- Dates: Always normalize relative dates (kal, parso, tomorrow, etc.) to "DD/Month/YYYY" format.

=== ALPHANUMERIC EXTRACTION RULES ===
- If a user mentions a GST number or Email, they might use a mix of Hindi and English.
- You MUST prioritize English character extraction for these fields.
- **CRITICAL**: Use 'updates_json' to capture these fields IMMEDIATELY when heard.
- Avoid descriptive words; extract only the raw alphanumeric string (e.g., "mera gst 29abc..." -> "29ABC...").
`;

// ─── NODE 1: Name + Interest ──────────────────────────────────────────────────
const nameInterestAgent = new Agent({
  name: "NODE_1_NAME_INTEREST",
  instructions: `=== YOUR TASK ===
Qualify the seller. **SKIP RULE**: Check [SYSTEM: Session] FIRST. If 'name_spoken', 'interest_in_meesho', or 'has_bank_account' are already present, SKIP those questions. If the user provides ANY extra info (items, price, email, GST), CAPTURE it in 'updates_json' immediately. **NOTE**: Do not repeat the initial introduction ("Namaste! Main Meesho..."); proceed directly to the pitch or next question.

=== QUESTION FLOW (STRICT ORDER) ===
- **Identify Missing Info**: Check 'pitch_delivered', 'interest_in_meesho', 'name_spoken', and 'has_bank_account'.
- **Question Order**:
  1. **Pitch & Interest**: If 'pitch_delivered' is "no": Deliver the pitch AND ask for interest: "Meesho par 21 crore se zyada customers hain aur yahan zero commission aur free logistics ka fayda milta hai. Kya aap Meesho par apne items bechna chahte hai?". Set 'pitch_delivered': "yes".
  2. **Confirm Interest**: If 'pitch_delivered' is "yes" but 'interest_in_meesho' is missing: You MUST confirm if they want to sell. If they say "yes" or "haan", set 'interest_in_meesho': "yes" and ask for their name: "Aapka poora naam kya hai?".
  3. **Name**: If 'interest_in_meesho' is "yes" but 'name_spoken' is missing: Ask "Aapka poora naam kya hai?".
  4. **Bank Account**: If 'name_spoken' is present but 'has_bank_account' is missing: Acknowledge their name then ask "Kya aapke paas bank account hai?". Set 'has_bank_account' based on their response.
- **CRITICAL**: You MUST NOT ask about the bank account until 'interest_in_meesho' is "yes". If they say "yes" to the bank account, ensure you set 'has_bank_account': "yes" in 'updates_json'.
- **CRITICAL**: The pitch must be delivered ONLY ONCE per call. If 'pitch_delivered' is "yes", NEVER repeat the pitch details (21 crore, zero commission, etc.).

=== GLOBAL EXTRACTION ===
- You MUST capture ANY information the user provides, even if you didn't ask for it.
- If user gives name, products, price, email, or GST, update 'updates_json' immediately.
- If user asks a question, set 'kb_query' and answer according to QnA rules.

=== INTENT DETECTION ===
| INTERESTED | "yes", "theek hai", "haan" | If pitching, set interest_in_meesho: "yes". If asking about bank, set has_bank_account: "yes". |
| NOT_INTERESTED | "no", "nahi", "not interested" | If pitching, set next_node: TERM_NOT_INTERESTED. If asking about bank, set has_bank_account: "no". |
| GIVING_NAME | user provides name | Update 'name_spoken'. |
| BUSY | "call later", "busy" | Confirm time, set next_node: TERM_CALLBACK. |
| EXTRA INFO | user gives price / items | Capture in 'updates_json'. |

=== ROUTING ===
- Stay in NODE_1_NAME_INTEREST until 'interest_in_meesho', 'name_spoken', AND 'has_bank_account' are fully captured.
- Once all are captured, set next_node: NODE_2_DETAILS and your 'say' field MUST contain the first question of Node 2: "Aap kis tarah ke items bechte hain?"
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: []
});

// ─── NODE 2: Business Details ─────────────────────────────────────────────────
const detailsAgent = new Agent({
  name: "NODE_2_DETAILS",
  instructions: `=== YOUR TASK ===
  Collect business details. **SKIP RULE**: Check [SYSTEM: Session] FIRST. If 'products_sold', 'price_min'/'raw_price_min', or 'listing_start'/'raw_listing_start' are already present, SKIP those questions entirely. Only ask for MISSING fields.

=== QUESTION FLOW ===
  1. **Items**: If 'products_sold' is empty/missing in session, ask: "Achha, toh aap kis tarah ke items bechte hain?" — Otherwise SKIP.
2. **Price**: If 'price_min' is missing AND 'raw_price_min' is missing in session, ask: "Aur in items ki price range kya rehti hai?" — Otherwise SKIP. If 'raw_price_min' is present but looks like text, ask for numerical confirmation.
3. **Listing Date (MANDATORY)**: If 'listing_start' is missing AND 'raw_listing_start' is missing in session, you MUST ask: "Aap kab tak meesho par list karna start kar sakte hain?" — Otherwise SKIP.
  - When they answer, set 'raw_listing_start' in 'updates_json' to EXACTLY what they said.
  - **CRITICAL**: You MUST NOT transition to NODE_3_CONTACT_GST without asking this question. This field is required.

=== GLOBAL EXTRACTION & INTENT ===
- **EXTRACTION**: Capture ANY info provided (Email, GST, Name, etc.) even if not asked. Put in 'updates_json'.
- **ITEMS**: If user mentions products (e.g. "sari", "electronics"), update 'products_sold'.
- **PRICE**: If the user mentions a range (e.g. "100 se 200"), you MUST capture both 'raw_price_min': 100 AND 'raw_price_max': 200.
- **KB**: If they ask a question, set 'kb_query', say "Main check karke batati hoon" and stay in NODE_2_DETAILS.

=== RULES ===
    - EVERY 'say' must end with a question mark.
- If user provides price range(e.g. "100-200" or "so se do so"), you MUST extract numerical values for 'raw_price_min' and 'raw_price_max' and put them in 'updates_json'.
- NEVER ask the price range if 'price_min' or 'raw_price_min' is present in context.

=== ROUTING ===
  - Stay in NODE_2_DETAILS until ALL THREE fields are captured: 'products_sold', 'price_min'/'raw_price_min', AND 'listing_start'/'raw_listing_start'.
- **CRITICAL**: Do NOT set next_node to NODE_3_CONTACT_GST if 'listing_start' AND 'raw_listing_start' are BOTH missing. You MUST ask the listing date question first.
- Once ALL THREE are collected, set next_node: NODE_3_CONTACT_GST and your 'say' MUST contain the first question: "Aachi baat hai. Aapka email address kya hai?"`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validatePriceRangeTool, normalizeListingDateTool]
});

// ─── NODE 3: Email + GSTIN ────────────────────────────────────────────────────
const contactGstAgent = new Agent({
  name: "NODE_3_CONTACT_GST",
  instructions: `=== YOUR TASK ===
  Collect email and GST. **SKIP RULE**: Check [SYSTEM: Session] FIRST. If 'email'/'raw_email' or 'gstin'/'raw_gstin'/'uin' are already present, SKIP those questions entirely. Only ask for MISSING fields. If ALL fields are captured, transition directly to Node 4.

=== QUESTION FLOW ===
  1. ** Email **: If 'email' is missing AND 'raw_email' is missing, ask: "Kya aap apna email address bata sakte hai?"
2. ** GST **: If 'gstin' is missing AND 'raw_gstin' is missing AND 'gst_declined' is not true, ask: "Kya aapke paas 15-digit GST number hai?"
3. ** UIN(Fallback) **: If 'gst_declined' is true AND 'uin' is missing AND 'gstin' is missing AND 'raw_gstin' is missing, ask: "Meesho par bina GST ke list karne ke liye Enrollment ID ya UIN lagta hai. Kya aapke paas wo hai?"

  === INTENT DETECTION ===
| Intent | Signal | Action |
| --------| --------| --------|
| GIVING_EMAIL | user provides email | Acknowledge naturally (e.g., "Theek hai") then set 'raw_email' in 'updates_json'. |
| HAS_GST | "yes", "ha", "uh-huh", "i have it" | Say "Kripya apna 15-digit GST number bataye." |
| GIVING_GST | user provides GST | Set 'raw_gstin' in 'updates_json'. |
| NO_GST | "don't have gst", "no", "nahi hai" | Set 'gst_declined': true in 'updates_json'.Ask for UIN / Enrollment ID. |
| GIVING_UIN | user provides UIN / Enrollment ID | Update 'uin' in 'updates_json', move to Node 4. |
| NO_UIN | "don't have it", "no" | Set next_node: TERM_NO_REGISTRATION.Say: "Maaf kijiyega, bina GST ya Enrollment ID ke hum registration aage nahi badha sakte. Samay dene ke liye dhanyavad!" |

=== ASYNC EMAIL INVALIDATION ===
- Email is validated in the background. You may receive a SYSTEM message saying the email is invalid AFTER you have already moved on to GST/UIN questions.
- If this happens: Politely inform the user their email had an issue and ask them to repeat it. Do NOT re-ask for GST/UIN if it is already captured in the session.
- Example: "Aapka email verify nahi ho paaya — kya aap dobara apna email bata sakte hai?"
- After the corrected email is captured, check the session: if GST/UIN is already present, transition to Node 4 immediately.

=== GLOBAL EXTRACTION ===
- **EXTRACTION**: Capture ANY info provided (Price, Items, Name, etc.) even if not asked. Put in 'updates_json'.
- **KB**: If they ask a question, set 'kb_query', say "Main check karke batati hoon" and stay in NODE_3_CONTACT_GST.

=== ROUTING ===
  - Move to NODE_4_CLOSURE only after BOTH Email and(GST OR UIN) are captured.
- When transitioning, your 'say' MUST be EXACTLY: "Details share karne ke liye bahut dhanyavad. Hamari team aapko ek WhatsApp link bhejegi documents upload karne ke liye. Kya aapko Meesho के baare mein kuch aur jaanna hai?"
  - Do NOT use TERM_COMPLETE in Node 3.
    - Every 'say' MUST end with a question mark.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: []
});
// ─── NODE 4: QnA & Closure ────────────────────────────────────────────────────────
const closureAgent = new Agent({
  name: "NODE_4_CLOSURE",
  instructions: `=== YOUR TASK ===
  First, handle any incoming questions about Meesho. Maintain the session in NODE_4_CLOSURE as long as the user is asking questions or seeking clarification.

=== FLOW ===
    1. ** QnA Phase(Priority) **:
- If the user asks a question(e.g., benefits, shipping, commission, "How to sell?"):
- You MUST set 'kb_query' in 'updates_json' to their question.
     - Respond only with: "Zaroor, main check karke batati hoon."
  - The system will provide Knowledge Base results in the next turn.
     - Once you receive KB results, explain them simply in Hindi and ASK: "Kya aapko kuch aur jaanna hai?"
    - ** KB SEARCH GUARD **: If 'kb_search_active' is true in the session, do NOT use TERM_COMPLETE even if the user says "ok" or "theek hai". Wait for the results.
  - ** CRITICAL **: Stay in 'NODE_4_CLOSURE'(next_node: CONTINUE) while answering questions.

2. ** Closing Phase(Termination) **:
- ONLY proceed to this phase if the user explicitly confirms they have NO more questions (e.g., "no", "nahi", "bas itna hi"). 
- **TIGHTENED QnA**: If the user says "ok", "theek hai", or "ji" while you are in this node (without asking a specific question), do NOT close yet. Ask if they want to know specifically about Meesho payouts, margin, or delivery to ensure they don't have unasked questions.
- **CLOSING RULE**: Only close if they explicitly say they have no more questions or ask to end.
- When closing, provide a warm closing in Hindi, thanking them for their time and mentioning that they can list items on Meesho once their documents are verified.
- Set "next_node": "TERM_COMPLETE".

=== RULES ===
- If you see "[SYSTEM: Knowledge Base Results: ...]" in the history or current prompt, it means the information you requested has arrived. You MUST explain it naturally in Hindi. Set 'kb_search_active': false in 'updates_json'.
- **CRITICAL**: Do NOT just say you will check; since the results are here, provide the ACTUAL answer immediately.
- NEVER set next_node: "TERM_COMPLETE" if 'kb_search_active' is true.
- Always ask "Kya aapko kuch aur jaanna hai?" after providing an answer.
- **EXTRACTION**: Capture ANY session data provided in 'updates_json'.
- Ensure the final closing phrase is warm and complete before exiting.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: []
});

// ─── Routing Map ──────────────────────────────────────────────────────────────

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

// ─── Default Session State ────────────────────────────────────────────────────

const createDefaultSession = () => ({
  caller_phone: '',
  // Node 1
  name_spoken: '',
  is_right_person: '',
  interest_in_meesho: '',
  has_bank_account: '',
  callback_time: '',
  pitch_delivered: 'no',
  // Node 2
  products_sold: [],
  price_min: null,
  price_max: null,
  raw_price_min: '',
  raw_price_max: '',
  listing_start: '',
  raw_listing_start: '',
  // Node 3
  email: '',
  email_valid: 'no',
  email_attempts: 0,
  raw_email: '',
  gstin: '',
  gstin_valid: 'no',
  gst_attempts: 0,
  raw_gstin: '',
  gst_declined: 'no',
  uin: '',
  closure_bridge_delivered: false,
  // Node 4
  kb_query: '',
  call_outcome: 'in_progress',
  // Internal
  node0_done: false,
  node1_done: false,
  node2_done: false,
  node3_done: false,
  node4_done: false,
});

// ─── Helper: Sanitize message content for OpenAI API ──────────────────────────

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  try {
    // Force POJO conversion to strip library-internal symbols/fields.
    // This ensures compatibility with the plain OpenAI API expectations.
    const sanitized = JSON.parse(JSON.stringify(msg));

    // Ensure 'content' is in a format the Agents SDK can replay.
    // The Responses API uses 'output_text' for assistant messages — keep that intact
    // so getOutputMessageContent() in @openai/agents-openai can recognize it.
    if (sanitized.role === 'assistant' && Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map(part => {
        if (part.type === 'output_text') return part;          // keep as-is for SDK
        if (part.type === 'text') return { ...part, type: 'output_text' }; // fix legacy → SDK format
        return part;
      });
    }
    return sanitized;
  } catch (e) {
    return msg;
  }
}

// ─── Helper: Parse agent output ───────────────────────────────────────────────

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

    // Final Fallback: If it's a plain string (not starting with {), treat the whole thing as 'say'
    if (text.length > 5 && !text.trim().startsWith('{')) {
      return {
        say: text.trim(),
        updates: {},
        next_node: 'CONTINUE',
        notes: 'plain_text_fallback'
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

// ─── Session Factory ──────────────────────────────────────────────────────────

export function createCallSession(callerPhone = '', options = {}) {
  const conversationHistory = [];
  const session = { ...createDefaultSession(), caller_phone: callerPhone };
  let currentNode = 'NODE_0_WELCOME';
  let currentProcessingId = 0;
  let lastProcessedTranscript = ''; // Track last processed transcript to avoid duplicates
  let lastProcessedState = ''; // Track session state to allow same transcript when state changes
  let bgTaskCounter = 0; // Session-level counter for active background tasks (email, GST, KB, etc.)

  // Store session-level logger so it's accessible from processTranscript
  // without being shadowed by the inner `options` parameter
  const sessionLogger = options.logger || null;
  const onSessionUpdate = options.onSessionUpdate || null;

  function notifyUpdate() {
    if (onSessionUpdate) onSessionUpdate({ ...session });
  }

  function updateSession(updates) {
    if (!updates) return;
    Object.assign(session, updates);
    if (sessionLogger) {
      sessionLogger.withComponent('Database').info('External session update', { updates });
    }
    notifyUpdate();
  }

  // ── Guard: Prevent premature node transitions ────────────────────────
  function guardNodeTransition(fromNode, proposedNext) {
    if (fromNode === 'NODE_2_DETAILS' && proposedNext !== 'NODE_2_DETAILS' && proposedNext !== 'CONTINUE') {
      // Don't leave Node 2 without listing date captured
      if (!session.listing_start && !session.raw_listing_start) {
        if (sessionLogger) sessionLogger.warn('[Guard] Blocked premature exit from NODE_2_DETAILS — listing_start missing');
        return 'CONTINUE';
      }
    }
    return proposedNext;
  }

  // ── Guard: Protect captured values from being cleared by LLM updates ──
  function protectCapturedValues(updates) {
    if (!updates || typeof updates !== 'object') return;
    const protectedKeys = ['gstin', 'email', 'name_spoken', 'uin'];
    for (const key of protectedKeys) {
      if (key in updates && !updates[key] && session[key]) {
        delete updates[key];
      }
    }
  }

  // ── Internal runner ─────────────────────────────────────────────────────

  async function runNode(agent, userMessage, onSayChunk, nodeOptions = {}) {
    const myProcessingId = currentProcessingId; // Capture current ID to detect aborts

    try {
      return await withTrace("Reseller Qualification", async () => {
        // Isolate Runner per turn to prevent cross-talk and race conditions
        const turnRunner = new Runner({
          traceMetadata: {
            __trace_source__: "voice-ai-platform",
            workflow_id: "wf_meesho_reseller_v3"
          }
        });

        // System message is now handled externally/consistently
        const systemMessage = sanitizeMessage({
          role: 'system',
          content: `${BASE_VOICE_CONTEXT} \n${GLOBAL_GUARDRAILS} \n${DATA_INTERPRETATION_CONTEXT} `
        });

        // --- Smart History Slicing (Revised v29) ---
        // We ensure that we never start history with a 'tool' role.
        // We also strip library-internal fields to keep it clean for OpenAI.
        let messages = [...conversationHistory];
        if (messages.length > 10) {
          let sliceIdx = messages.length - 10;
          // Search backwards for a safe starting point (must be 'user' or 'assistant' without pending tool calls)
          while (sliceIdx < messages.length && (messages[sliceIdx].role === 'tool' || (messages[sliceIdx].role === 'assistant' && messages[sliceIdx].tool_calls))) {
            sliceIdx++;
          }
          messages = messages.slice(sliceIdx);
        }

        const sanitizedMessages = messages.map(msg => {
          // Items without a 'role' are Responses API native items (function_call,
          // function_call_output) — pass through as-is after sanitize.
          if (!msg.role) return sanitizeMessage(msg);

          switch (msg.role) {
            case 'system':
            case 'user':
              return sanitizeMessage({ role: msg.role, content: msg.content || '' });
            case 'assistant': {
              let content = msg.content || '';
              // Wrap string content as output_text (Responses API format) so the SDK
              // can replay it through getOutputMessageContent without throwing.
              if (typeof content === 'string') {
                content = [{ type: 'output_text', text: content }];
              }
              const out = { role: 'assistant', content };
              if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                out.tool_calls = msg.tool_calls;
              }
              return sanitizeMessage(out);
            }
            case 'tool':
              return sanitizeMessage({
                role: 'tool',
                content: msg.content || '',
                tool_call_id: msg.tool_call_id,
                name: msg.name
              });
            default:
              return sanitizeMessage(msg);
          }
        });

        const stream = await turnRunner.run(agent, [systemMessage, ...sanitizedMessages], { stream: true });

        let finalOutputText = "";
        let sentLength = 0;

        for await (const event of stream) {
          // TURN ABORT CHECK: If a newer transcript started processing, kill this stream immediately
          if (myProcessingId !== currentProcessingId) {
            if (options.logger) options.logger.warn(`[Workflow] Aborting stale turn runner loop(ID: ${myProcessingId})`);
            break;
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
        if (!nodeOptions.skipHistory) {
          // Sanitize new items before storing.
          // Filter out items without a 'role' field — these are Responses API internal
          // items (function_call, function_call_output) that cannot be safely replayed
          // as chat messages on subsequent turns.
          const newItems = stream.newItems
            .map(item => sanitizeMessage(item.rawItem))
            .filter(item => item && item.role);
          conversationHistory.push(...newItems);
        }
        return stream.finalOutput;
      });
    } catch (err) {
      if (options.logger) options.logger.error('[Workflow] runNode critical failure', err);
      // Fallback graceful response
      return {
        say: "I'm sorry, I'm having a bit of trouble with my system. Can you please tell me that again?",
        next_node: 'CONTINUE',
        updates: {}
      };
    }
  }

  // ── Mark node as done when leaving it ──────────────────────────────────

  function markNodeDone(nodeName) {
    const match = nodeName.match(/NODE_(\d)/);
    if (match) {
      session[`node${match[1]}_done`] = true;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Callback to check if stream is still active
  let isActiveCallback = () => true;

  function setIsActiveCallback(cb) {
    isActiveCallback = cb;
  }

  async function getWelcome() {
    markNodeDone('NODE_0_WELCOME');
    currentNode = 'NODE_1_NAME_INTEREST';
    const text = "Namaste! Main Meesho seller onboarding team se Asmita bol rahi hoon.";
    // Do NOT push to history here to avoid the LLM thinking it already spoke if it recurses
    return text;
  }

  // --- Regex Fast-Path Configuration ---
  const FAST_MATCH_CONFIG = {
    'NODE_1_NAME_INTEREST': [
      {
        pattern: /^(mera naam|my name is|main|i am|this is|मेरा नाम|मैं) (.*?)(?: hai| hoon|है|हूं)?$/i,
        handle: (match, session) => {
          if (!session) return null;
          const name = match[2].trim();
          if (session.pitch_delivered !== 'yes') {
            // Deliver pitch + capture name in one shot
            return {
              updates: { name_spoken: name, pitch_delivered: 'yes' },
              say: `Achha, ${name} ji. Meesho par 21 crore se zyada customers hain aur yahan zero commission aur free logistics ka fayda milta hai. Kya aap Meesho par apne items bechna chahte hai?`,
              next_node: 'CONTINUE'
            };
          }
          if (!session.interest_in_meesho) {
            // Pitch delivered but interest not yet captured — ask interest
            return {
              updates: { name_spoken: name },
              say: `Achha, ${name} ji. Kya aap Meesho par apne items bechna chahte hai?`,
              next_node: 'CONTINUE'
            };
          }
          // Interest captured — move to bank account
          return {
            updates: { name_spoken: name },
            say: `Achha, ${name} ji. Kya aapke paas bank account hai?`,
            next_node: 'CONTINUE'
          };
        }
      },
      {
        // Interest & Acknowledgment
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|interested|i am interested|main interested hoon|haan ji boliye|ji bataiye|bataiye|ji boliye|हां|हा|जी|ठीक है|बिल्कुल|ज़रूर|हांजी|जी बोलिए|जी बताइए|बताइए|हां जी बोलिए|पक्का)$/i,
        handle: (match, session) => {
          if (!session) return null;
          // If pitch not delivered, deliver it and ask for interest (Combined Step)
          if (session.pitch_delivered !== 'yes') {
            return {
              updates: { pitch_delivered: 'yes' },
              say: "Meesho par 21 crore se zyada customers hain aur yahan zero commission aur free logistics ka fayda milta hai. Kya aap Meesho par apne items bechna chahte hai?",
              next_node: 'CONTINUE'
            };
          }
          // If pitch delivered but interest not captured, any 'haan' confirms interest
          if (!session.interest_in_meesho) {
            return {
              updates: { interest_in_meesho: 'yes' },
              say: session.name_spoken ? "Achha, toh bank account hai?" : "Aapka poora naam kya hai?",
              next_node: 'CONTINUE'
            };
          }
          return null;
        }
      },
      {
        pattern: /^(nahi|na|no|nhi|reject|bilkul nahi|not interested|नहीं|न|नो|बिल्कुल नहीं)$/i,
        updates: { interest_in_meesho: 'no' },
        say: "Achha, koi baat nahi. Agar aapka mann badle toh humein zaroor batayiye. Dhanyavad!",
        next_node: 'TERM_NOT_INTERESTED'
      }
    ],
    'NODE_2_DETAILS': [
      {
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|हां|हा|जी|ठीक है|बिल्कुल|ज़रूर|हांजी)$/i,
        handle: (match, session) => {
          return null; // Let LLM extract proper intent if needed
        }
      }
    ],
    'NODE_3_CONTACT_GST': [
      {
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|हां|हा|जी|ठीक है|बिल्कुल|ज़रूर|हांजी|जी बोलिए|जी बताइए|बताइए|हां जी बोलिए)$/i,
        handle: (match, session) => {
          if (!session) return null;
          if (session.email_valid !== 'yes' && session.email_attempts === 0) {
            return {
              updates: {},
              say: "Achi baat hai, kripya apna email address bataiye.",
              next_node: 'CONTINUE'
            };
          } else if (!session.gstin && session.gst_declined !== 'yes') {
            return {
              updates: { gstin_valid: 'yes' }, // Using gstin_valid as a signal to start capture
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
    const cleanText = text.trim().toLowerCase().replace(/[.,?!|।]/g, '');
    if (FAST_MATCH_CONFIG[currentNode]) {
      for (const entry of FAST_MATCH_CONFIG[currentNode]) {
        if (cleanText.match(entry.pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  async function processTranscript(transcript, tts = null, silenceFiller = null, options = {}, isRecursive = false) {
    if (!transcript) return { say: "", next_node: currentNode, session: { ...session } };

    const cleanTranscript = transcript.trim();

    // Check if we've already processed this exact transcript (e.g. Fast-Match already handled it)
    // Include session state in comparison so "haan" can be processed again after state changes
    const currentStateKey = `${currentNode}|${session.pitch_delivered}|${session.interest_in_meesho}|${session.name_spoken}|${session.has_bank_account}`;
    if (cleanTranscript === lastProcessedTranscript && currentStateKey === lastProcessedState && !isRecursive) {
      if (sessionLogger) sessionLogger.info(`[Workflow] Skipping duplicate transcript: ${cleanTranscript}`);
      return { say: '', next_node: currentNode, session: { ...session }, streamedByNode: false };
    }
    lastProcessedTranscript = cleanTranscript;
    lastProcessedState = currentStateKey;

    const currentProcId = isRecursive ? currentProcessingId : ++currentProcessingId;
    // Early exit if the call is no longer active (WS closed or Twilio stopped)
    if (!isActiveCallback()) {
      if (sessionLogger) sessionLogger.warn('[Workflow] processTranscript called after call ended — aborting');
      return { say: '', next_node: currentNode, session: { ...session }, streamedByNode: false };
    }

    // const cleanTranscript = transcript.trim().toLowerCase().replace(/[.,?!|।]/g, ''); // This line is removed
    let fastMatchResult = null;

    // --- Helpers ---
    const runTool = async (toolObj, params) => {
      if (!toolObj) {
        if (sessionLogger) sessionLogger.error('[Workflow] Tool object is undefined');
        return JSON.stringify({ success: false, error: 'Tool object is undefined', timestamp: Date.now() });
      }

      try {
        const rawResult = toolObj.execute ?
          await toolObj.execute(params) :
          await toolObj.invoke({}, JSON.stringify(params));

        // If the tool returned an already-stringified standard result, return it as-is 
        // to avoid double JSON encoding.
        if (typeof rawResult === 'string') {
          try {
            const parsed = JSON.parse(rawResult);
            if (parsed && typeof parsed === 'object' && ('success' in parsed)) {
              return rawResult;
            }
          } catch (e) { /* not JSON, proceed to wrap */ }
        }

        // FORCE JSON - no exceptions for tools that return objects/strings directly
        const safeResult = {
          success: true,
          data: rawResult,
          timestamp: Date.now()
        };

        if (sessionLogger) {
          sessionLogger.withComponent('Workflow').debug(`Tool ${toolObj.name} executed successfully`);
        }

        return JSON.stringify(safeResult);
      } catch (err) {
        if (sessionLogger) sessionLogger.error(`[Workflow] Tool ${toolObj.name || 'unknown'} error: `, err);
        return JSON.stringify({
          success: false,
          error: err.message,
          timestamp: Date.now()
        });
      }
    };

    const handleBackgroundTasks = (output) => {
      if (!output || !output.updates) return;
      const updates = output.updates;
      const currentProcId = currentProcessingId;
      // Use session-level logger (not shadowed by processTranscript's options parameter)
      const log = sessionLogger;

      const incrementBg = () => {
        bgTaskCounter++;
        if (bgTaskCounter === 1 && silenceFiller) {
          if (log) log.withComponent('Validation').debug('[Background] Task started — pausing silence filler', { active: bgTaskCounter });
          silenceFiller.pause();
        }
      };

      const decrementBg = () => {
        bgTaskCounter = Math.max(0, bgTaskCounter - 1);
        if (bgTaskCounter === 0 && silenceFiller) {
          if (log) log.withComponent('Validation').debug('[Background] All tasks finished — resuming silence filler');
          // Resume only if agent isn't speaking
          if (!tts?.isSpeaking && !tts?.hasPendingAudio()) {
            silenceFiller.resume();
          }
        }
      };

      // 1. Email
      if (updates.raw_email && session.bg_email_running !== 'yes') {
        session.bg_email_running = 'yes';
        incrementBg();
        if (log) log.withComponent('Database').info('Saving session updates', { updates: { bg_email_running: 'yes' } });
        const candidate = updates.raw_email;
        Promise.resolve().then(async () => {
          try {
            const normRes = await runTool(normalizeSpokenEmailTool, { spoken_email: candidate });
            const normData = JSON.parse(normRes);
            const norm = normData.success ? normData.data : null;

            if (norm && norm.normalized_email) {
              const valRes = await runTool(validateEmailTool, { email: norm.normalized_email });
              const valData = JSON.parse(valRes);

              if (valData.success && valData.data.valid) {
                session.email = valData.data.normalized;
                session.email_valid = 'yes';
                delete session.raw_email; // Clear raw_email before recursion so skip rules don't block progress
                if (log) {
                  log.withComponent('Validation').info('[Background] Email Validated', { email: session.email });
                  log.withComponent('Database').info('Saving session updates', { updates: { email: session.email, email_valid: 'yes' } });
                }
                notifyUpdate();
                if (currentProcId === currentProcessingId && isActiveCallback()) {
                  // Trigger continuity so agent asks for GST next without waiting for user "confirm"
                  await processTranscript(`[SYSTEM: Email verified successfully. Proceed to next field.]`, tts, silenceFiller, {}, true);
                }
              } else if (currentProcId === currentProcessingId) {
                session.email_valid = 'no';
                session.email_attempts = (session.email_attempts || 0) + 1;
                delete session.raw_email; // Clear raw_email so agent can re-ask in recursive turn
                if (isActiveCallback()) {
                  const errorMsg = valData.data?.error || "Invalid format";
                  if (log) log.withComponent('Validation').warn('[Background] Email Invalid', { error: errorMsg });
                  const gstAlreadyCaptured = session.gstin || session.raw_gstin || session.uin || session.gst_declined === 'yes';
                  const contextHint = gstAlreadyCaptured
                    ? ' GST/UIN info is already saved — only re-ask for the email, then proceed to closure.'
                    : '';
                  await processTranscript(`[SYSTEM: Email "${norm.normalized_email}" is invalid(${errorMsg}). Politely ask the user to repeat their email address.${contextHint}]`, tts, silenceFiller, {}, true);
                }
              }
            }
          } catch (e) {
            console.error(e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              if (log) log.withComponent('Validation').error('[Background] Email check crashed', e);
              await processTranscript(`[SYSTEM: Verification failed due to internal tool error.Ask for email again politely.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_email_running = 'no';
            const finalUpdates = { bg_email_running: 'no' };
            if (session.email) {
              delete session.raw_email;
              finalUpdates.raw_email = null;
            }
            if (log) log.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
            notifyUpdate();
            decrementBg();
          }
        });
      }

      // 2. GST
      if (updates.raw_gstin && session.bg_gst_running !== 'yes') {
        session.bg_gst_running = 'yes';
        incrementBg();
        if (log) log.withComponent('Database').info('Saving session updates', { updates: { bg_gst_running: 'yes' } });
        const candidate = updates.raw_gstin;
        Promise.resolve().then(async () => {
          try {
            // Removal of GST Validation as per user request (GST TRUST RULE)
            const normalized = candidate.replace(/\s+/g, '').toUpperCase();
            session.gstin = normalized;
            session.gstin_valid = 'yes';
            session.bg_gst_running = 'no'; // Mark background task as complete BEFORE notifyUpdate
            if (isActiveCallback()) {
              if (log) log.withComponent('Validation').info('[Background] GST Captured');
              if (log) log.withComponent('Database').info('Saving session updates', { updates: { gstin: normalized, gstin_valid: 'yes', bg_gst_running: 'no' } });
              notifyUpdate();

              if (currentProcId === currentProcessingId) {
                delete session.raw_gstin; // Clear before recursion
                await processTranscript(`[SYSTEM: GST captured successfully. Proceed to closure.]`, tts, silenceFiller, {}, true);
              }
            }
          } catch (e) {
            console.error(e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              if (log) log.withComponent('Validation').error('[Background] GST check crashed', e);
              await processTranscript(`[SYSTEM: Verification failed due to internal tool error.Apologize and ask for GST again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_gst_running = 'no'; // Ensure bg flag is always cleared
            if (session.gstin_valid === 'yes') {
              delete session.raw_gstin;
            }
            if (log) log.withComponent('Database').info('Saving session updates', { updates: { bg_gst_running: 'no' } });
            notifyUpdate();
            decrementBg();
          }
        });
      }

      // 3. Listing Date Normalization
      if (updates.raw_listing_start && session.bg_listing_running !== 'yes') {
        session.bg_listing_running = 'yes';
        incrementBg();
        if (log) log.withComponent('Database').info('Saving session updates', { updates: { bg_listing_running: 'yes', raw_listing_start: updates.raw_listing_start } });
        const candidate = updates.raw_listing_start;
        Promise.resolve().then(async () => {
          try {
            const todayISO = new Date().toISOString().split('T')[0];
            const rawResponse = await runTool(normalizeListingDateTool, {
              spoken_date: candidate,
              current_date_iso: new Date().toISOString().split('T')[0]
            });
            const response = JSON.parse(rawResponse);
            const norm = response.success ? response.data : null;
            if (norm && norm.valid && norm.normalized) {
              session.listing_start = norm.normalized;
              if (log) log.withComponent('Validation').info('[Background] Date Normalized', { date: norm.normalized });
              if (log) log.withComponent('Database').info('Saving session updates', { updates: { listing_start: norm.normalized } });
              notifyUpdate();

              if (currentProcId === currentProcessingId && isActiveCallback()) {
                await processTranscript(`[SYSTEM: Listing date normalized to ${norm.normalized}.]`, tts, silenceFiller, {}, true);
              }
            }
          } catch (e) {
            console.error(e);
            if (log) log.withComponent('Validation').error('[Background] Listing Date tool crashed', e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              await processTranscript(`[SYSTEM: Listing Date validation failed due to internal error.Ask the user for the date again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_listing_running = 'no';
            const finalUpdates = { bg_listing_running: 'no' };
            if (session.listing_start) {
              // Keep raw_listing_start so UI can show "(raw_text)" alongside normalized date
            }
            if (log) log.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
            notifyUpdate();
            decrementBg();
          }
        });
      }

      // 4. Price Range Validation
      if ((updates.raw_price_min || updates.raw_price_max) && session.bg_price_running !== 'yes') {
        session.bg_price_running = 'yes';
        incrementBg();
        if (log) log.withComponent('Database').info('Saving session updates', { updates: { bg_price_running: 'yes', raw_price_min: updates.raw_price_min, raw_price_max: updates.raw_price_max } });
        let originalMin = updates.raw_price_min || session.price_min || "";
        let originalMax = updates.raw_price_max || session.price_max || "";
        let pMin = parseFloat(updates.raw_price_min !== undefined ? updates.raw_price_min : session.price_min || 0);
        let pMax = parseFloat(updates.raw_price_max !== undefined ? updates.raw_price_max : session.price_max || 0);

        Promise.resolve().then(async () => {
          try {
            if (isNaN(pMin) || isNaN(pMax)) {
              if (log) log.withComponent('Validation').warn('[Background] Price is text, asking LLM to confirm', { min: originalMin, max: originalMax });
              if (isActiveCallback() && currentProcId === currentProcessingId) {
                await processTranscript(`[SYSTEM: The price you captured("${originalMin}" - "${originalMax}") is text.Ask the user to confirm the numerical price range, e.g. "Matlab, ₹100 se ₹200 tak?"]`, tts, silenceFiller);
              }
              return;
            }

            const resRaw = await runTool(validatePriceRangeTool, { price_min: pMin, price_max: pMax });
            const resData = typeof resRaw === 'string' ? JSON.parse(resRaw) : resRaw;
            const res = resData?.data || resData;
            if (res && res.valid) {
              session.price_min = res.price_min;
              session.price_max = res.price_max;
              if (log) log.withComponent('Validation').info('[Background] Price Validated', { min: res.price_min, max: res.price_max });
              if (log) log.withComponent('Database').info('Saving session updates', { updates: { price_min: res.price_min, price_max: res.price_max } });
              notifyUpdate();

              if (currentProcId === currentProcessingId && isActiveCallback()) {
                await processTranscript(`[SYSTEM: Price range validated to ₹${res.price_min}-₹${res.price_max}.]`, tts, silenceFiller, {}, true);
              }
            }
          } catch (e) {
            console.error(e);
            if (log) log.withComponent('Validation').error('[Background] Price Range tool crashed', e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              await processTranscript(`[SYSTEM: Price Range validation failed due to internal error.Ask the user for the price range again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_price_running = 'no';
            const finalUpdates = { bg_price_running: 'no' };
            if (session.price_min && !isNaN(parseFloat(session.price_min))) {
              delete session.raw_price_min;
              delete session.raw_price_max;
              finalUpdates.raw_price_min = null;
              finalUpdates.raw_price_max = null;
            }
            if (log) log.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
            notifyUpdate();
            decrementBg();
          }
        });
      }

      // 5. KB
      if (updates.kb_query) {
        const query = updates.kb_query;
        session.kb_search_active = true; // Mark search as active
        incrementBg();
        if (log) log.withComponent('KnowledgeBase').info(`Search initiated for: "${query}"`);
        delete updates.kb_query;
        delete session.kb_query; // Clear from session to prevent loops
        if (tts) {
          // VOICE: Fire background transition and recursive turn
          Promise.resolve().then(async () => {
            try {
              const kbRaw = await runTool(searchKnowledgeBaseTool, { query });
              // Extract clean text from KB result JSON
              let kbText = kbRaw;
              try {
                const parsed = JSON.parse(kbRaw);
                kbText = parsed.data || kbRaw;
              } catch (e) { /* use raw if not JSON */ }

              if (sessionLogger) sessionLogger.withComponent('KnowledgeBase').info(`[Background] KB Results found for: "${query}"`, { info_length: kbText.length });

              if (isActiveCallback()) {
                // CRITICAL FIX: Clear search active flag BEFORE recursive turn.
                // This prevents the synchronous part of processTranscript from appending 
                // "search in progress" instructions that contradict the injected results.
                session.kb_search_active = false;
                notifyUpdate(); // Notify UI that search finished

                // We proceed even if currentProcId moved, because the user might have just said "ok" 
                // and we still want to deliver the answer.
                await processTranscript(`[SYSTEM: Knowledge Base Results: ${kbText}]`, tts, silenceFiller, {}, true);
              }
            } catch (e) {
              if (log) log.withComponent('KnowledgeBase').error('[Background] KB Query crashed', e);
              session.kb_search_active = false;
              notifyUpdate();
            } finally {
              decrementBg();
            }
          });
        }
      }
    };

    // 1. Check Fast-Match Regex (Speed Path)
    // Strip punctuation for matching (aligned with checkFastMatch logic)
    const fastMatchText = cleanTranscript.toLowerCase().replace(/[.,?!|।]/g, '');
    if (FAST_MATCH_CONFIG[currentNode]) {
      for (const entry of FAST_MATCH_CONFIG[currentNode]) {
        const match = fastMatchText.match(entry.pattern);
        if (match) {
          // Rule: Never end conversation based on regex
          if (entry.next_node && entry.next_node.startsWith('TERM_')) continue;
          fastMatchResult = typeof entry.handle === 'function' ? entry.handle(match, session) : entry;
          if (!fastMatchResult) continue; // fallback to LLM if handle rejected it

          if (sessionLogger) {
            sessionLogger.info(`[Fast-Match] Predictive match: ${cleanTranscript}`);
            // Instant UI broadcast for Fast-Match updates
            if (fastMatchResult.updates) {
              sessionLogger.withComponent('Database').info('Saving session updates', { updates: fastMatchResult.updates });
              // APPLY UPDATES TO SESSION
              Object.assign(session, fastMatchResult.updates);
              notifyUpdate();
            }
          }
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
      return { say: "Goodbye.", next_node: 'TERM_COMPLETE', session: { ...session } };
    }

    let userMessage = transcript;
    if (currentNode !== 'NODE_0_WELCOME') {
      const activeData = Object.fromEntries(
        Object.entries(session).filter(([k, v]) =>
          k !== 'caller_phone' &&
          v !== '' &&
          v !== null &&
          (typeof v === 'number' || (Array.isArray(v) ? v.length > 0 : !!v))
        )
      );
      const today = new Date();
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const formattedToday = `${today.getDate().toString().padStart(2, '0')} /${monthNames[today.getMonth()]}/${today.getFullYear()} `;
      userMessage = `${transcript} \n\n[SYSTEM: Date: ${formattedToday}, Session: ${JSON.stringify(activeData)}]`;
      if (session.kb_search_active && !transcript.includes('[SYSTEM: Knowledge Base Results:')) {
        userMessage += `\n[SYSTEM: A Knowledge Base search is currently in progress. DO NOT terminate. Wait for results.]`;
      }
    }

    // PUSH USER MESSAGE TO HISTORY ONCE
    conversationHistory.push(sanitizeMessage({
      role: 'user',
      content: userMessage
    }));

    let streamedCount = 0;

    const llmPromise = (async () => {
      try {
        let ttsBuffer = "";
        let firstChunkLogged = false;
        let ttsFirstSentLogged = false;
        const llmStartTime = performance.now();
        const raw = await Logger.runWithContext(sessionLogger?.context || {}, async () => {
          return await runNode(agent, userMessage, (chunk) => {
            if (!firstChunkLogged) {
              firstChunkLogged = true;
              if (sessionLogger) {
                sessionLogger.withComponent('Timing').info('LLM first say chunk', {
                  ttft_ms: Math.round(performance.now() - llmStartTime),
                  chunk_preview: chunk.substring(0, 40)
                });
              }
            }
            if (!fastMatchResult && tts && isActiveCallback()) {
              streamedCount += chunk.length;
              ttsBuffer += chunk;
              if (/[.,?!|।, ]/.test(ttsBuffer) || ttsBuffer.split(/\s+/).length >= 6) {
                const bIdx = ttsBuffer.search(/[.,?!|।,]/) + 1 || ttsBuffer.length;
                if (bIdx > 0 || ttsBuffer.split(/\s+/).length >= 6) {
                  const toSendArr = ttsBuffer.substring(0, bIdx || ttsBuffer.length);
                  tts.sendText(toSendArr);
                  if (!ttsFirstSentLogged) {
                    ttsFirstSentLogged = true;
                    if (sessionLogger) {
                      sessionLogger.withComponent('Timing').info('TTS first text sent', {
                        time_since_llm_start_ms: Math.round(performance.now() - llmStartTime),
                        text_preview: toSendArr.substring(0, 40)
                      });
                    }
                  }
                  ttsBuffer = ttsBuffer.substring(bIdx || ttsBuffer.length);
                }
              }
            }
          }, { skipHistory: !!fastMatchResult });
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
        if (sessionLogger) sessionLogger.error('[Workflow] llmPromise error', e);
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

        // Name check: Fuzzy comparison to avoid conflicts on case or language script differences
        let nameMismatch = false;
        if (fastMatchResult.updates?.name_spoken && actual.updates?.name_spoken) {
          const name1 = fastMatchResult.updates.name_spoken.toLowerCase().trim();
          const name2 = actual.updates.name_spoken.toLowerCase().trim();

          // Simple heuristic: If one is a substring of another or they are equal, it's not a mismatch
          // This avoids conflict when LLM refines "अमृता" to "Amrita" or adding a last name.
          // Since they are from the same recording, we trust the LLM more but don't want to apologize if they are "close"
          if (name1 !== name2) {
            // If both are different scripts (one has non-ascii, other is ascii), we might assume they are the same if the turn was the same
            const isHindi = (str) => /[\u0900-\u097F]/.test(str);
            if (isHindi(name1) !== isHindi(name2)) {
              // If script differs, we don't treat it as a "mismatch" that needs an apology, we just prefer the LLM's version.
              nameMismatch = false;
            } else {
              nameMismatch = true;
            }
          }
        }

        if ((predY && actN) || termC || nameMismatch) {
          if (sessionLogger) sessionLogger.warn(`[Conflict] LLM override. nameMismatch=${nameMismatch}, termC=${termC}`);
          if (isActiveCallback()) {
            tts?.sendText("Maaf kijiyega, maine shayad galat suna. " + actual.say);
            Object.assign(session, actual.updates);
            if (sessionLogger && Object.keys(actual.updates || {}).length > 0) {
              sessionLogger.withComponent('Database').info('Saving session updates', { updates: actual.updates });
            }
            currentNode = actual.next_node === 'CONTINUE' ? currentNode : actual.next_node;
          }
        } else if (isActiveCallback()) {
          Object.assign(session, actual.updates);
          if (sessionLogger && Object.keys(actual.updates || {}).length > 0) {
            sessionLogger.withComponent('Database').info('Saving session updates', { updates: actual.updates });
          }
        }
      });

      let nextNode = fastMatchResult.next_node === 'CONTINUE' ? currentNode : fastMatchResult.next_node;
      nextNode = guardNodeTransition(currentNode, nextNode);
      if (nextNode !== currentNode && nextNode !== 'CONTINUE') markNodeDone(currentNode);

      const updates = fastMatchResult.updates || {};
      Object.assign(session, updates);

      // Pushing to history for continuity (use output_text for Responses API compat)
      conversationHistory.push(sanitizeMessage({
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            say: fastMatchResult.say,
            updates_json: JSON.stringify(updates),
            next_node: nextNode,
            notes: 'Fast-match'
          })
        }]
      }));

      if (sessionLogger && Object.keys(updates).length > 0) {
        sessionLogger.withComponent('Database').info('Saving session updates', { updates });
      }

      currentNode = nextNode;

      // Update call_outcome when reaching a terminal node via fast-match
      if (TERMINAL_NODES.has(currentNode)) {
        const outcomeMap = {
          'TERM_COMPLETE': 'complete',
          'TERM_NOT_INTERESTED': 'not_interested',
          'TERM_CALLBACK': 'callback',
          'TERM_WRONG_PERSON': 'wrong_person',
          'TERM_NO_REGISTRATION': 'no_registration'
        };
        session.call_outcome = outcomeMap[currentNode] || 'complete';
      }

      return { say: fastMatchResult.say, next_node: nextNode, notes: 'Fast-match', session: { ...session }, streamedByNode: true };
    }

    // Standard Path
    const finalLLMOutput = await llmPromise;
    if (!finalLLMOutput) return { say: "Kripya phir se kahiye?", next_node: currentNode, session: { ...session }, streamedByNode: false };

    // --- Chat-specific Synchronous Task Handling ---
    // If we are in chat mode (no tts), we perform all validation and search tasks 
    // synchronously so the user gets the final response in one turn.
    if (!tts && finalLLMOutput.updates && Object.keys(finalLLMOutput.updates).length > 0) {
      const updates = finalLLMOutput.updates;
      let systemPrompts = [];
      let anySyncTask = false;

      // 1. Knowledge Base Search
      if (updates.kb_query) {
        anySyncTask = true;
        const query = updates.kb_query;
        if (sessionLogger) sessionLogger.info(`[Chat-RAG] Sync-handling KB query: ${query}`);

        session.kb_search_active = true;
        try {
          const kbRaw = await runTool(searchKnowledgeBaseTool, { query });
          let kbText = kbRaw;
          try {
            const parsed = JSON.parse(kbRaw);
            kbText = parsed.data || kbRaw;
          } catch (e) { }
          systemPrompts.push(`Knowledge Base Results: ${kbText}`);
        } catch (err) {
          if (sessionLogger) sessionLogger.error('[Chat-Sync] KB search failed', err);
        } finally {
          session.kb_search_active = false;
          delete updates.kb_query;
          delete session.kb_query;
        }
      }

      // 2. Email Validation
      if (updates.raw_email) {
        anySyncTask = true;
        const candidate = updates.raw_email;
        if (sessionLogger) sessionLogger.info(`[Chat-Sync] Sync-validating email: ${candidate}`);
        try {
          const normRes = await runTool(normalizeSpokenEmailTool, { spoken_email: candidate });
          const normData = JSON.parse(normRes);
          const norm = normData.success ? normData.data : null;
          if (norm && norm.normalized_email) {
            const valRes = await runTool(validateEmailTool, { email: norm.normalized_email });
            const valData = JSON.parse(valRes);
            if (valData.success && valData.data.valid) {
              session.email = valData.data.normalized;
              session.email_valid = 'yes';
              delete updates.raw_email;
              delete session.raw_email;
              systemPrompts.push(`Email verified successfully as ${session.email}. Proceed to next field.`);
            } else {
              session.email_valid = 'no';
              session.email_attempts = (session.email_attempts || 0) + 1;
              systemPrompts.push(`Email "${norm.normalized_email}" is invalid (${valData.data?.error || "format error"}). Politely ask the user to repeat.`);
            }
          }
        } catch (e) { }
      }

      // 3. GST Capture
      if (updates.raw_gstin) {
        anySyncTask = true;
        const candidate = updates.raw_gstin.replace(/\s+/g, '').toUpperCase();
        if (sessionLogger) sessionLogger.info(`[Chat-Sync] Sync-capturing GST: ${candidate}`);
        session.gstin = candidate;
        session.gstin_valid = 'yes';
        delete updates.raw_gstin;
        delete session.raw_gstin;
        // Also remove gstin/gstin_valid from LLM updates to prevent Object.assign from overwriting
        delete updates.gstin;
        delete updates.gstin_valid;
        if (sessionLogger) {
          sessionLogger.withComponent('Validation').info('[Chat-Sync] GST Captured', { gstin: candidate });
          sessionLogger.withComponent('Database').info('Saving session updates', { updates: { gstin: candidate, gstin_valid: 'yes' } });
        }
        systemPrompts.push(`GST captured successfully as ${candidate}. Proceed to closure.`);
      }

      // 4. Listing Date Normalization
      if (updates.raw_listing_start) {
        anySyncTask = true;
        const candidate = updates.raw_listing_start;
        try {
          const rawResponse = await runTool(normalizeListingDateTool, {
            spoken_date: candidate,
            current_date_iso: new Date().toISOString().split('T')[0]
          });
          const response = JSON.parse(rawResponse);
          if (response.success && response.data.valid) {
            session.listing_start = response.data.normalized;
            systemPrompts.push(`Listing date normalized to ${session.listing_start}.`);
          }
        } catch (e) { }
      }

      // 5. Price Range Validation
      if (updates.raw_price_min || updates.raw_price_max) {
        anySyncTask = true;
        const pMin = parseFloat(updates.raw_price_min || session.price_min || 0);
        const pMax = parseFloat(updates.raw_price_max || session.price_max || 0);
        if (!isNaN(pMin) && !isNaN(pMax)) {
          try {
            const resRaw = await runTool(validatePriceRangeTool, { price_min: pMin, price_max: pMax });
            const resData = JSON.parse(resRaw);
            if (resData.success && resData.data.valid) {
              session.price_min = resData.data.price_min;
              session.price_max = resData.data.price_max;
              delete updates.raw_price_min;
              delete updates.raw_price_max;
              delete session.raw_price_min;
              delete session.raw_price_max;
              systemPrompts.push(`Price range validated to ₹${session.price_min}-₹${session.price_max}.`);
            }
          } catch (e) { }
        }
      }

      if (anySyncTask) {
        // Apply remaining updates and transition state BEFORE recursive call
        protectCapturedValues(updates);
        Object.assign(session, updates);
        const prevNode = currentNode;
        let syncNextNode = finalLLMOutput.next_node === 'CONTINUE' ? currentNode : finalLLMOutput.next_node;
        syncNextNode = guardNodeTransition(prevNode, syncNextNode);
        currentNode = syncNextNode === 'CONTINUE' ? prevNode : syncNextNode;
        if (currentNode !== prevNode) markNodeDone(prevNode);

        const combinedMsg = `[SYSTEM: ${systemPrompts.join(' ')}]`;
        if (sessionLogger) sessionLogger.info(`[Chat-Sync] Executing recursive turn with msg: ${combinedMsg.substring(0, 100)}...`);

        const recursiveResult = await processTranscript(combinedMsg, null, null, {}, true);
        Object.assign(session, recursiveResult.session);
        return recursiveResult;
      }
    }

    if (finalLLMOutput.updates && isActiveCallback()) {
      protectCapturedValues(finalLLMOutput.updates);
      Object.assign(session, finalLLMOutput.updates);
      if (sessionLogger && Object.keys(finalLLMOutput.updates).length > 0) {
        sessionLogger.withComponent('Database').info('Saving session updates', { updates: finalLLMOutput.updates });
        notifyUpdate(); // Ensure UI syncs on LLM-driven variable capture
      }
    }
    if (isActiveCallback()) {
      handleBackgroundTasks(finalLLMOutput);
    }

    const prevNode = currentNode;
    let nextNode = finalLLMOutput.next_node === 'CONTINUE' ? currentNode : finalLLMOutput.next_node;
    nextNode = guardNodeTransition(prevNode, nextNode);
    if (nextNode !== prevNode && nextNode !== 'CONTINUE') markNodeDone(prevNode);
    currentNode = nextNode === 'CONTINUE' ? currentNode : nextNode;

    // Update call_outcome when reaching a terminal node
    if (TERMINAL_NODES.has(currentNode)) {
      const outcomeMap = {
        'TERM_COMPLETE': 'complete',
        'TERM_NOT_INTERESTED': 'not_interested',
        'TERM_CALLBACK': 'callback',
        'TERM_WRONG_PERSON': 'wrong_person',
        'TERM_NO_REGISTRATION': 'no_registration'
      };
      session.call_outcome = outcomeMap[currentNode] || 'complete';
    }

    return { say: finalLLMOutput.say, next_node: nextNode, notes: finalLLMOutput.notes, session: { ...session }, streamedByNode: true };
  }

  return {
    getWelcome,
    processTranscript,
    setIsActiveCallback,
    checkFastMatch,
    updateSession,
    getCurrentNode: () => currentNode,
    getBgTasksRunning: () => bgTaskCounter > 0,
    getSession: () => ({ ...session, transcript: conversationHistory }),
    isTerminal: () => TERMINAL_NODES.has(currentNode),
  };
}
