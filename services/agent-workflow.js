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

You are a Meesho Reseller Onboarding Specialist on an outbound phone call. You represent Meesho — India's fastest-growing e-commerce platform with 14 Cr+ customers and zero commission for sellers.

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
- **ACKNOWLEDGE ACKNOWLEDGMENTS**: If the user says "Haan ji boliye", "Ji bataiye", "Yes please", "Tell me", "Haanji", etc. at the start of the call, they are just acknowledging they are listening. DO NOT assume they are interested. You MUST still deliver the full pitch ("Meesho par fourteen crore...") before asking if they want to sell.

=== MEESHO CONTEXT ===
- Zero commission, zero penalty. Sellers keep 100% profit.
- **NO PHONE COLLECTION**: NEVER ask for their phone number.
- **CHECK CONTEXT**: Check [SYSTEM: Current session variables] before every response. Do NOT ask for information that is already present.
- **PROACTIVE CAPTURE**: If the user provides ANY information (name, items, price, email, GST) even if you didn't ask for it, you MUST capture it in the "updates_json" object immediately and acknowledge it naturally.
- **CRISP HINDI**: Use short, direct questions. Avoid "Aapka", "Jaan sakte hain", etc. if not needed.
  - "Aapka poora naam kya hai?" instead of "Kya main aapka naam jaan sakta hoon?"
  - "Bank account hai?" instead of "Kya aapke paas active bank account hai?"

=== TOOL CALLING RULE ===
If you need to use a tool (like searchKnowledgeBaseTool), you MUST do so by returning a structured tool call. OpenAI requires that the assistant turn requesting the tool is followed by the tool result. DO NOT output plain text when a tool is required.

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

── 5. CROSS-NODE EXTRACTION ──
If the user provides information for a future step (e.g., they mention price while giving their name, or mention GST while describing products), you MUST capture that information in the 'updates_json' object immediately. 
Refer to the current session data provided to see what is already captured.

── 6. TRANSITION RULE ──
When you are about to move to the next node (next_node), your "say" field MUST contain the first question of that next node. Do NOT just say "Let's move to the next step".

── 7. HANDLING QUESTIONS ──
If the caller/user asks a question about Meesho (benefits, commission, shipping, T&C, etc.), you MUST follow this protocol:
- If you DON'T see [SYSTEM: Knowledge Base Results] in the history: Set 'kb_query' in your 'updates_json' to the question and say exactly "Zaroor, main check karke batati hoon."
- If you DO see [SYSTEM: Knowledge Base Results] in the latest user message: Synthesize a friendly, crisp answer in simple Hindi/Hinglish using ONLY that provided context. 
- PROMPT PRIORITY: Answering the user's question from KB results is higher priority than asking for their name/items.
- ALWAYS end every answer with the bridge: "Kya aap Meesho ke baare mein aur kuch jaanna chahte hain?"
- NEVER use your own training data for facts about Meesho if they contradict the KB results.
`;

// ─── Node Specific Contexts ───────────────────────────────────────────────────
const DATA_INTERPRETATION_CONTEXT = `
=== NUMBER & DATA INTERPRETATION ===
- Spoken numbers: "two nine nine" = 299, "nine hundred ninety-nine" = 999, "panch sau" = 500, "ek hazaar" = 1000.
- Spelled words: "r-o-h-i-t" or "R O H I T" → "rohit".
- Emails: "at" → @, "dot" → ., "dash" → -, "underscore" → _.
- GSTIN: Capture 15-character alphanumeric GSTINs. Remove spaces and uppercase.
- Phone numbers: Normalize to 10 digits if mentioned.
- Dates: Always normalize relative dates (kal, parso, tomorrow, etc.) to "DD/Month/YYYY" format.
`;

// ─── NODE 1: Name + Interest ──────────────────────────────────────────────────
const nameInterestAgent = new Agent({
  name: "NODE_1_NAME_INTEREST",
  instructions: `=== YOUR TASK ===
Qualify the seller. **PRIORITY**: If the user already provided their name, items, or price, CAPTURE them in 'updates_json' and move to the next MISSING question.

=== QUESTION FLOW ===
- **Identify Missing Info**: Check 'interest_in_meesho', 'name_spoken', and 'has_bank_account'.
- **Ask the next missing field**:
  1. If 'interest_in_meesho' is not "yes": You MUST deliver the pitch: "Meesho par fourteen crore se zyada customers hain, aur yahan zero commission aur free delivery ka fayda milta hai." THEN ask "Kya aap Meesho par apne products bechna chahte hain?".
     - **CRITICAL**: Deliver this FULL pitch even if the user just says "Hi", "Hello", or "Haanji" in their first response. Do NOT set interest_in_meesho until they confirm after hearing the pitch.
  2. If interested but Name is missing: Ask "Aapka poora naam kya hai?".
  3. If interested and Name is known, but Bank Account is missing: Acknowledge their name (e.g. "Achha [Name] ji,") then ask "Kya aapke paas bank account hai?".

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_NAME | user provides name | Update 'name_spoken'. |
| INTERESTED | "yes", "theek hai", "haan", "sure", "bechna chahta hoon" | Set interest_in_meesho: "yes". |
| ACKNOWLEDGEMENT | "haanji", "ji", "bataiye" (before pitch) | Treat as "Hi". Do NOT set interest_in_meesho. Deliver Pitch. |
| NOT INTERESTED | "no", "nahi", "not interested" | Set interest_in_meesho: "no", next_node: TERM_NOT_INTERESTED. Say: "Koi baat nahi, Meesho se judne ke liye dhanyavad. Have a great day!" |
| BUSY | "call later", "busy" | Confirm time, set next_node: TERM_CALLBACK. |
| EXTRA INFO | user gives price/items | Capture in 'updates_json'. |

=== ROUTING ===
- Stay in NODE_1_NAME_INTEREST until 'interest_in_meesho', 'name_spoken', AND 'has_bank_account' are fully captured.
- Once all are captured, set next_node: NODE_2_DETAILS and your 'say' field MUST contain the first question of Node 2: "Aap kis tarah ke items bechte hain?"
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validateEmailTool, normalizeSpokenEmailTool, validatePriceRangeTool, normalizeListingDateTool, searchKnowledgeBaseTool]
});

// ─── NODE 2: Business Details ─────────────────────────────────────────────────
const detailsAgent = new Agent({
  name: "NODE_2_DETAILS",
  instructions: `=== YOUR TASK ===
Collect business details. **CHECK SYSTEM CONTEXT**: If the user already mentioned items or price range, do NOT ask for them. Capture any remaining info.

=== QUESTION FLOW ===
1. **Items**: If 'products_sold' is empty, ask: "Achha, toh aap kis tarah ke items bechte hain?"
2. **Price**: If 'price_min' is missing AND 'raw_price_min' is missing, ask: "Aur in items ki price range kya rehti hai?". If 'raw_price_min' is present but looks like text, ask for numerical confirmation.
3. **Speed**: If 'listing_start' is missing AND 'raw_listing_start' is missing, ask: "Aap kabse meesho pey list karna start karna chahte hai?"
   - When they answer, set 'raw_listing_start' in 'updates_json' to EXACTLY what they said. NEVER attempt to guess or set 'listing_start' directly; the system will normalize it from 'raw_listing_start'.

=== RULES ===
- EVERY 'say' must end with a question mark.
- If user provides price range (e.g. "100-200" or "so se do so"), you MUST extract numerical values for 'raw_price_min' and 'raw_price_max' and put them in 'updates_json'.
- NEVER ask the price range if 'price_min' or 'raw_price_min' is present in context.

=== ROUTING ===
- Stay in NODE_2_DETAILS until all questions are answered ('products_sold', 'price_min'/'raw_price_min', and 'listing_start'/'raw_listing_start' are collected).
- Once done, set next_node: NODE_3_CONTACT_GST and your 'say' MUST contain the first question: "Aapka email address kya hai?"`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validateEmailTool, normalizeSpokenEmailTool, validatePriceRangeTool, normalizeListingDateTool, searchKnowledgeBaseTool]
});

// ─── NODE 3: Email + GSTIN ────────────────────────────────────────────────────
const contactGstAgent = new Agent({
  name: "NODE_3_CONTACT_GST",
  instructions: `=== YOUR TASK ===
Collect email and GST/Enrollment ID. **CHECK SYSTEM CONTEXT**: If they already gave it, skip.

=== QUESTION FLOW ===
1. **Email**: If 'email' is missing AND 'raw_email' is missing, ask: "Aapka email address kya hai?"
2. **GST/UIN**: If 'gstin' is missing AND 'raw_gstin' is missing AND 'uin' is missing AND 'gst_declined' is not true:
   - Ask: "Kya aapke paas GST number hai? Agar nahi hai toh aap Enrollment ID or UIN bhi de sakte hain."

=== GST TRUST RULE ===
- NEVER reject or validate the GST number format yourself. 
- If the user provides any alphanumeric string for GST, capture it as 'raw_gstin' in your 'updates_json' immediately.
- Do NOT ask the user to repeat the GST or tell them it looks "invalid". Trust whatever they say.

3. **TRANSITION PROTOCOL**: Once Email and (GST OR UIN) are captured, you MUST move to NODE_4_CLOSURE. 

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_EMAIL | User provides email | Set 'raw_email'. |
| GIVING_GST | User provides 15-char GST | Set 'raw_gstin', move to NODE_4_CLOSURE. |
| HAS_GST | "Yes", "I have it" | Ask "Aapka GST number bataye?". |
| NO_GST | "No", "Don't have it" | Set 'gst_declined': true, ask for Enrollment ID. |
| GIVING_UIN | User provides Enrollment ID/UIN | Set 'uin', move to NODE_4_CLOSURE. |

=== RULES ===
- If the user gives their GST number directly when you ask "Do you have it?", capture it immediately and move to Node 4.
- Do NOT repeat questions if data is in system context.
- Stay in NODE_3 until Email and (GST OR UIN) are captured.
- **NEVER use terminal nodes** (TERM_*) from this node. Always route to NODE_4_CLOSURE for the final wrap-up.
- Move to NODE_4_CLOSURE naturally. Your 'say' MUST start with the bridge: "Hamari team aapko ek WhatsApp link bhejegi documents verify karne ke liye. Details share karne ke liye bahut dhanyavad. Kya aapko Meesho ke baare mein kuch aur jaanna hai?". Set 'closure_bridge_delivered': true in updates_json.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validateEmailTool, normalizeSpokenEmailTool, validatePriceRangeTool, normalizeListingDateTool, searchKnowledgeBaseTool]
});

// ─── NODE 4: QnA & Closure ────────────────────────────────────────────────────────
const closureAgent = new Agent({
  name: "NODE_4_CLOSURE",
  instructions: `=== YOUR TASK ===
Thank the user for their time and details, then proactively ask if they have any questions about Meesho (benefits, commission, shipping, etc.).

=== FLOW ===
1. **Initial Closing**: If 'closure_bridge_delivered' is not true, inform the user about the WhatsApp link FIRST.
   Say: "Hamari team aapko ek WhatsApp link bhejegi documents verify karne ke liye. Details share karne ke liye bahut dhanyavad. Kya aapko Meesho ke baare mein kuch aur jaanna hai?"
   Set 'closure_bridge_delivered': true in 'updates_json'.
2. **Handle Questions**:
   - **Case A: New Question**: If the user asks a question and you haven't checked the KB yet, set 'kb_query' in 'updates_json' to their question and say: "Main check karke batati hoon."
   - **Case B: Answer Available**: If you see '[SYSTEM: Knowledge Base Results]' in the message history, synthesize the answer from that context. Speak in simple Hinglish. 
   - **ALWAYS** end the answer with the bridge: "Kya aap Meesho ke baare mein aur kuch jaanna chahte hain?"
3. **Handle No Questions / Post-Answer**: ONLY if the user explicitly says they have no MORE questions or wants to end the call (e.g. "no more", "nahi chahiye", "goodbye", "bas itna hi", "bas"):
   - Final Say: "Zaroor. Documents verify hone ke baad aap Meesho par listing shuru kar sakenge. Aapka samay dene ke liye bahut dhanyavad! Have a nice day!"
   - Set "next_node": "TERM_COMPLETE".

=== CRITICAL TERMINATION GUARDS ===
- **DO NOT** use TERM_COMPLETE if the user says "theek hai", "okay", "ji", or "hmm". These are continuations. Instead, ask: "Kya aap Meesho ke baare mein aur kuch jaanna chahte hain?"
- **DO NOT** use TERM_COMPLETE until you have explicitly asked "Kya aap Meesho ke baare mein kuch aur jaanna hai?" and received a clear negative response.
- NEVER ask if the user is interested in Meesho again.
- DO NOT repeat the onboarding pitch.
- Ensure every 'say' ends with a question, except for the final goodbye.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: RESPONSE_SCHEMA },
  tools: [validateEmailTool, normalizeSpokenEmailTool, validatePriceRangeTool, normalizeListingDateTool, searchKnowledgeBaseTool]
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
  uin: '',
  closure_bridge_delivered: false,
  // Node 1
  name_spoken: '',
  is_right_person: '',
  interest_in_meesho: '',
  has_bank_account: '',
  callback_time: '',
  pitch_delivered: false,
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
  email_valid: false,
  email_attempts: 0,
  raw_email: '',
  gstin: '',
  gstin_valid: false,
  gst_attempts: 0,
  raw_gstin: '',
  gst_declined: false,
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
    // Force POJO conversion to strip library-internal symbols/fields
    // This ensures compatibility with the plain OpenAI API expectations.
    return JSON.parse(JSON.stringify(msg));
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
          content: `${BASE_VOICE_CONTEXT}\n${GLOBAL_GUARDRAILS}\n${DATA_INTERPRETATION_CONTEXT}`
        });

        // --- Smart History Slicing (Revised v29) ---
        // We ensure that we never start history with a 'tool' role.
        // We also strip library-internal fields to keep it clean for OpenAI.
        let messages = [...conversationHistory];
        if (messages.length > 20) {
          let sliceIdx = messages.length - 20;
          // Search backwards for a safe starting point (must be 'user' or 'assistant' without pending tool calls)
          while (sliceIdx < messages.length && (messages[sliceIdx].role === 'tool' || (messages[sliceIdx].role === 'assistant' && messages[sliceIdx].tool_calls))) {
            sliceIdx++;
          }
          messages = messages.slice(sliceIdx);
        }

        const sanitizedMessages = messages.map(msg => ({
          role: msg.role,
          content: msg.content || null,
          tool_calls: msg.tool_calls || null,
          tool_call_id: msg.tool_call_id || null,
          name: msg.name || null
        })).map(sanitizeMessage);

        const stream = await turnRunner.run(agent, [systemMessage, ...sanitizedMessages], { stream: true });

        let finalOutputText = "";
        let sentLength = 0;

        for await (const event of stream) {
          // TURN ABORT CHECK: If a newer transcript started processing, kill this stream immediately
          if (myProcessingId !== currentProcessingId) {
            if (options.logger) options.logger.warn(`[Workflow] Aborting stale turn runner loop (ID: ${myProcessingId})`);
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
          // Sanitize new items before storing
          const newItems = stream.newItems.map(item => sanitizeMessage(item.rawItem));
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
    return "Namaste! Main Meesho seller onboarding team se Asmita bol rahi hoon.";
  }

  // --- Regex Fast-Path Configuration ---
  const FAST_MATCH_CONFIG = {
    'NODE_1_NAME_INTEREST': [
      {
        pattern: /^(mera naam|my name is|main|i am|this is|मेरा नाम|मैं) (.*?)(?: hai| hoon|है|हूं)?$/i,
        handle: (match, session) => {
          if (!session) return null;
          const name = match[2].trim();
          if (!session.interest_in_meesho) {
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
        pattern: /^(haan|ha|ji|yes|affirmative|theek hai|bilkul|zaroor|sure|haanji|interested|i am interested|main interested hoon|haan ji boliye|ji bataiye|bataiye|ji boliye|हां|हा|जी|ठीक है|बिल्कुल|ज़रूर|हांजी|जी बोलिए|जी बताइए|बताइए|हां जी बोलिए)$/i,
        handle: (match, session) => {
          if (!session) return null;
          if (!session.interest_in_meesho) {
            // Let the LLM handle "haanji" etc. at node start to ensure pitch is delivered
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

  async function processTranscript(transcript, tts = null, silenceFiller = null) {
    currentProcessingId++;
    const currentProcId = currentProcessingId;
    const cleanTranscript = transcript.trim().toLowerCase().replace(/[.,?!|।]/g, '');
    let fastMatchResult = null;

    // --- Helpers ---
    const runTool = async (toolObj, params) => {
      if (!toolObj) {
        if (options.logger) options.logger.error('[Workflow] Tool object is undefined');
        return JSON.stringify({ success: false, error: 'Tool object is undefined', timestamp: Date.now() });
      }

      try {
        const rawResult = toolObj.execute ?
          await toolObj.execute(params) :
          await toolObj.invoke(params);

        // FORCE JSON - no exceptions
        const safeResult = {
          success: true,
          data: rawResult,
          timestamp: Date.now()
        };

        if (options.logger) {
          options.logger.withComponent('Workflow').debug(`Tool ${toolObj.name} executed successfully`);
        }

        return JSON.stringify(safeResult);
      } catch (err) {
        if (options.logger) options.logger.error(`[Workflow] Tool ${toolObj.name || 'unknown'} error:`, err);
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

      // Silent background scan for tasks (removed debug log per user request)

      // 1. Email
      if (updates.raw_email && !session.bg_email_running) {
        session.bg_email_running = true;
        if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { bg_email_running: true } });
        const candidate = updates.raw_email;
        Promise.resolve().then(async () => {
          try {
            if (silenceFiller) silenceFiller.pause();
            const rawResponse = await runTool(normalizeSpokenEmailTool, { spoken_email: candidate });
            const response = JSON.parse(rawResponse);
            const norm = response.success ? response.data : null;
            // Simple validation: check for @ and .
            if (norm && typeof norm === 'object' && norm.normalized_email && norm.normalized_email.includes('@') && norm.normalized_email.includes('.')) {
              session.email = norm.normalized_email;
              session.email_valid = true;
              if (options.logger) {
                options.logger.withComponent('Validation').info('[Background] Email Simplified Validation Passed');
                options.logger.withComponent('Database').info('Saving session updates', { updates: { email: norm.normalized_email, email_valid: true } });
              }
            } else if (currentProcId === currentProcessingId) {
              session.email_valid = false;
              session.email_attempts = (session.email_attempts || 0) + 1;
              if (isActiveCallback()) {
                if (options.logger) options.logger.withComponent('Validation').warn('[Background] Email Invalid (Simplified)');
                await processTranscript(`[SYSTEM: Email "${candidate}" is invalid. Politely ask the user to repeat the email address.]`, tts, silenceFiller);
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
            const finalUpdates = { bg_email_running: false };
            if (session.email) {
              delete session.raw_email;
              finalUpdates.raw_email = null;
            }
            if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
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
            // Removal of GST Validation as per user request (GST TRUST RULE)
            const normalized = candidate.replace(/\s+/g, '').toUpperCase();
            session.gstin = normalized;
            session.gstin_valid = true;
            if (isActiveCallback()) {
              if (options.logger) options.logger.withComponent('Validation').info('[Background] GST Captured (Trust Mode)');
              if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { gstin: normalized, gstin_valid: true, bg_gst_running: false } });
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
        if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { bg_listing_running: true } });
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
              if (options.logger) options.logger.withComponent('Validation').info('[Background] Date Normalized', { date: norm.normalized });
              if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { listing_start: norm.normalized } });
            }
          } catch (e) {
            console.error(e);
            if (options.logger) options.logger.withComponent('Validation').error('[Background] Listing Date tool crashed', e);
            if (isActiveCallback() && currentProcId === currentProcessingId) {
              await processTranscript(`[SYSTEM: Listing Date validation failed due to internal error. Ask the user for the date again.]`, tts, silenceFiller);
            }
          } finally {
            session.bg_listing_running = false;
            const finalUpdates = { bg_listing_running: false };
            if (session.listing_start) {
              delete session.raw_listing_start;
              finalUpdates.raw_listing_start = null;
            }
            if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
          }
        });
      }

      // 4. Price Range Validation
      if ((updates.raw_price_min || updates.raw_price_max) && !session.bg_price_running) {
        session.bg_price_running = true;
        if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: { bg_price_running: true } });
        let originalMin = updates.raw_price_min || session.price_min || "";
        let originalMax = updates.raw_price_max || session.price_max || "";
        let pMin = parseFloat(updates.raw_price_min !== undefined ? updates.raw_price_min : session.price_min || 0);
        let pMax = parseFloat(updates.raw_price_max !== undefined ? updates.raw_price_max : session.price_max || 0);

        Promise.resolve().then(async () => {
          try {
            if (isNaN(pMin) || isNaN(pMax)) {
              if (options.logger) options.logger.withComponent('Validation').warn('[Background] Price is text, asking LLM to confirm', { min: originalMin, max: originalMax });
              if (isActiveCallback() && currentProcId === currentProcessingId) {
                await processTranscript(`[SYSTEM: The price you captured ("${originalMin}" - "${originalMax}") is text. Ask the user to confirm the numerical price range, e.g. "Matlab, ₹100 se ₹200 tak?"]`, tts, silenceFiller);
              }
              return;
            }

            const res = await runTool(validatePriceRangeTool, { price_min: pMin, price_max: pMax });
            if (res && typeof res === 'object' && res.valid) {
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
            const finalUpdates = { bg_price_running: false };
            if (session.price_min && !isNaN(parseFloat(session.price_min))) {
              delete session.raw_price_min;
              delete session.raw_price_max;
              finalUpdates.raw_price_min = null;
              finalUpdates.raw_price_max = null;
            }
            if (options.logger) options.logger.withComponent('Database').info('Saving session updates', { updates: finalUpdates });
          }
        });
      }

      // 5. KB
      if (updates.kb_query) {
        const query = updates.kb_query;
        delete updates.kb_query;
        delete session.kb_query; // Clear from session to prevent loops
        if (tts) {
          // VOICE: Fire background transition and recursive turn
          Promise.resolve().then(async () => {
            try {
              const kbResult = await runTool(searchKnowledgeBaseTool, { query });
              if (isActiveCallback() && currentProcId === currentProcessingId) {
                if (options.logger) options.logger.info(`[KnowledgeBase] Answer Found for: ${query}`);
                await processTranscript(`[SYSTEM: Knowledge Base Results: ${kbResult}]`, tts, silenceFiller);
              }
            } catch (e) {
              if (options.logger) options.logger.withComponent('KnowledgeBase').error('[Background] KB Query crashed', e);
            }
          });
        }
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
      const today = new Date();
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const formattedToday = `${today.getDate().toString().padStart(2, '0')}/${monthNames[today.getMonth()]}/${today.getFullYear()}`;
      userMessage = `${transcript}\n\n[SYSTEM: Date: ${formattedToday}, Session: ${JSON.stringify(activeData)}]`;
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
        const raw = await Logger.runWithContext(options.logger?.context || {}, async () => {
          return await runNode(agent, userMessage, (chunk) => {
            if (!fastMatchResult && tts && isActiveCallback()) {
              streamedCount += chunk.length;
              ttsBuffer += chunk;
              if (/[.,?!|।, ]/.test(ttsBuffer) || ttsBuffer.split(/\s+/).length >= 6) {
                const bIdx = ttsBuffer.search(/[.,?!|।,]/) + 1 || ttsBuffer.length;
                if (bIdx > 0 || ttsBuffer.split(/\s+/).length >= 6) {
                  const toSendArr = ttsBuffer.substring(0, bIdx || ttsBuffer.length);
                  tts.sendText(toSendArr);
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
          if (options.logger) options.logger.warn(`[Conflict] LLM override. nameMismatch=${nameMismatch}, termC=${termC}`);
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

      const updates = fastMatchResult.updates || {};
      Object.assign(session, updates);

      // Pushing to history for continuity
      conversationHistory.push(sanitizeMessage({
        role: 'assistant',
        content: JSON.stringify({
          say: fastMatchResult.say,
          updates_json: JSON.stringify(updates),
          next_node: nextNode,
          notes: 'Fast-match'
        })
      }));

      if (options.logger && Object.keys(updates).length > 0) {
        options.logger.withComponent('Database').info('Saving session updates', { updates });
      }

      currentNode = nextNode;
      return { say: fastMatchResult.say, next_node: nextNode, notes: 'Fast-match', session: { ...session }, streamedByNode: true };
    }

    // Standard Path
    const finalLLMOutput = await llmPromise;
    if (!finalLLMOutput) return { say: "Kripya phir se kahiye?", next_node: currentNode, session: { ...session }, streamedByNode: false };

    // Chat-specific RAG Handling: If KB query is requested and we are in chat mode (no tts),
    // wait for the result and perform the recursive turn synchronously so the user gets the final answer.
    if (!tts && finalLLMOutput.updates?.kb_query) {
      const query = finalLLMOutput.updates.kb_query;
      if (options.logger) options.logger.info(`[Chat-RAG] Sync-handling query: ${query}`);

      // CRITICAL: Save current turn updates BEFORE recursing, otherwise they are lost
      Object.assign(session, finalLLMOutput.updates);
      const prevNode = currentNode;
      currentNode = finalLLMOutput.next_node === 'CONTINUE' ? currentNode : finalLLMOutput.next_node;
      if (currentNode !== prevNode) markNodeDone(prevNode);

      try {
        const kbResult = await runTool(searchKnowledgeBaseTool, { query });
        // Perform recursive turn synchronously
        const recursiveResult = await processTranscript(`[SYSTEM: Knowledge Base Results: ${kbResult}]`, null, null);
        // Important: merge recursive results back to session if they aren't already
        Object.assign(session, recursiveResult.session);
        return recursiveResult;
      } catch (err) {
        if (options.logger) options.logger.error('[Chat-RAG] Sync KB query failed', err);
        // Fallback to the acknowledgment "Main check karke batati hoon"
      }
    }

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
    getSession: () => ({ ...session, transcript: conversationHistory }),
    isTerminal: () => TERMINAL_NODES.has(currentNode),
  };
}
