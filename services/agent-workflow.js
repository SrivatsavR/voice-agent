import { Agent, Runner, withTrace, tool } from '@openai/agents';
import { Logger } from '../utils/logger.js';
import {
  validateEmailTool,
  normalizeSpokenEmailTool,
  validateGSTINTool,
  validatePhoneTool,
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
- **NUMBERS RULE**: Speak ALL numbers, prices, and IDs in **ENGLISH digits**.
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

=== MEESHO CONTEXT ===
- Zero commission, zero penalty. Sellers keep 100% profit.
- **NO PHONE COLLECTION**: NEVER ask for their phone number.
- **CHECK CONTEXT**: Check [SYSTEM: Current session variables] before every response. Do NOT ask for information that is already present.
- **PROACTIVE CAPTURE**: If the user provides ANY information (name, items, price, email, GST) even if you didn't ask for it, you MUST capture it in the "updates" object immediately and acknowledge it naturally.
- **CRISP HINDI**: Use short, direct questions. Avoid "Aapka", "Jaan sakte hain", etc. if not needed.
  - "Naam kya hai?" instead of "Kya main aapka naam jaan sakta hoon?"
  - "Bank account hai?" instead of "Kya aapke paas active bank account hai?"

=== RESPONSE FORMAT ===
Strictly return JSON. "say" must be the FIRST key.
{
  "say": "Short crisp Hindi/Hinglish question?",
  "updates": { "key": "value" },
  "next_node": "TARGET_NODE_NAME",
  "notes": "Internal reasoning"
}
`;

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
If the user provides information for a future step (e.g., they mention price while giving their name, or mention GST while describing products), you MUST capture that information in the 'updates' object immediately. 
Refer to the current session data provided to see what is already captured.

── 6. TRANSITION RULE ──
When you are about to move to the next node (next_node), your "say" field MUST contain the first question of that next node. Do NOT just say "Let's move to the next step".
`;

// ─── Node Specific Contexts ───────────────────────────────────────────────────
const DATA_INTERPRETATION_CONTEXT = `
=== NUMBER & DATA INTERPRETATION ===
- Spoken numbers: "two nine nine" = 299, "nine hundred ninety-nine" = 999, "panch sau" = 500, "ek hazaar" = 1000.
- Spelled words: "r-o-h-i-t" or "R O H I T" → "rohit".
- Emails: "at" → @, "dot" → ., "dash" → -, "underscore" → _.
- GSTIN: Remove spaces and uppercase before validating.
- Phone numbers: Normalize to 10 digits if mentioned.
`;

// ─── NODE 0: Welcome ──────────────────────────────────────────────────────────
const welcomeAgent = new Agent({
  name: "NODE_0_WELCOME",
  instructions: `${BASE_VOICE_CONTEXT}

=== YOUR TASK ===
  Deliver the welcome greeting exactly as scripted.Do NOT ask any questions.Do NOT engage in conversation.

Say verbatim:
"Namaste! Main Meesho seller onboarding team se Asmita bol rahi hoon."

Set next_node to "NODE_1_NAME_INTEREST".Leave updates as empty object { }.

=== IMPORTANT ===
  - Do NOT modify the welcome line.Speak it exactly.
- Do NOT add extra questions or information.`,
  model: "gpt-4o-mini",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 256, store: true, response_format: { type: "json_object" } }
});

// ─── NODE 1: Name + Interest ──────────────────────────────────────────────────
const nameInterestAgent = new Agent({
  name: "NODE_1_NAME_INTEREST",
  instructions: `${BASE_VOICE_CONTEXT}
${GLOBAL_GUARDRAILS}

=== YOUR TASK ===
Qualify the seller. **PRIORITY**: If the user already provided their name, items, or price, CAPTURE them in 'updates' and move to the next MISSING question.

=== QUESTION FLOW ===
1. **Name**: If 'name_spoken' is missing, ask: "Namaste! Aapka naam kya hai?"
2. **Interest**: Once name is known, ask: "Ji [name] ji, Meesho par aap zero commission par apne items bech sakte hain. Kya aap humare saath judna chahenge?"
3. **Bank Account**: If interested, ask: "Zaroor! Kya aapke paas active bank account hai? Payment ke liye ye zaroori hai."

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_NAME | user provides name | Update 'name_spoken', stay in NODE_1_NAME_INTEREST and ask about Interest. |
| INTERESTED | "yes", "theek hai", "haan" | Set interest_in_meesho: "yes", stay in NODE_1_NAME_INTEREST and ask about Bank Account. |
| NOT INTERESTED | "no", "nahi", "not interested" | Set next_node: TERM_NOT_INTERESTED. Say: "Koi baat nahi [name] ji, Meesho se judne ke liye dhanyavad. Have a great day!" |
| BUSY | "call later", "busy" | Confirm time, set next_node: TERM_CALLBACK. |
| EXTRA INFO | user gives price/items | Capture in 'updates', move to next MISSING question. |

=== ROUTING ===
- Stay in NODE_1_NAME_INTEREST until 'interest_in_meesho' AND 'has_bank_account' are both captured.
- Once both are captured, set next_node: NODE_2_DETAILS and your 'say' field MUST contain the first question of Node 2: "Aap kis tarah ke items bechte hain?"
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o",
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: { type: "json_object" } }
});

// ─── NODE 2: Business Details ─────────────────────────────────────────────────
const detailsAgent = new Agent({
  name: "NODE_2_DETAILS",
  instructions: `${BASE_VOICE_CONTEXT}
${GLOBAL_GUARDRAILS}
${DATA_INTERPRETATION_CONTEXT}

=== YOUR TASK ===
Collect business details. **CHECK SYSTEM CONTEXT**: If the user already mentioned items or price range, do NOT ask for them. Capture any remaining info.

=== QUESTION FLOW ===
1. **Items**: If 'products_sold' is empty, ask: "Aap kis tarah ke items bechte hain?"
2. **Price**: If 'price_min' is missing, ask: "Aapke items ki price range kya hai?"
3. **Speed**: If 'listing_start' is missing, ask: "Aap kabse meesho pey list karna start karna chahte hai?"
   - When they answer, use **normalize_listing_date** tool to convert their spoken timing into YYYY-MM-DD.
   - Use the current date from the system context as reference.
   - Store the 'normalized' YYYY-MM-DD in 'listing_start'.

=== RULES ===
- EVERY 'say' must end with a question mark.
- Use 'validate_price_range' tool when both prices are mentioned.

=== ROUTING ===
- Stay in NODE_2_DETAILS until Items, Price, and listing_start are captured.
- Once done, set next_node: NODE_3_CONTACT_GST and your 'say' MUST contain the first question: "Aapka email address kya hai?"`,
  model: "gpt-4o",
  tools: [validatePriceRangeTool, normalizeListingDateTool],
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: { type: "json_object" } }
});

// ─── NODE 3: Email + GSTIN ────────────────────────────────────────────────────
const contactGstAgent = new Agent({
  name: "NODE_3_CONTACT_GST",
  instructions: `${BASE_VOICE_CONTEXT}
${GLOBAL_GUARDRAILS}
${DATA_INTERPRETATION_CONTEXT}

=== YOUR TASK ===
Collect email and GST. **CHECK SYSTEM CONTEXT**: If the email or GST was already provided in earlier nodes, do NOT ask for them. Skip to the next missing field or finish.

=== QUESTION FLOW ===
1. **Email**: If 'email' is missing, ask: "Aapka email address kya hai?"
2. **GST**: If 'gstin' is missing, ask: "Kya aapke paas GST number hai?"

=== INTENT DETECTION ===
| Intent | Signal | Action |
|--------|--------|--------|
| GIVING_EMAIL | user provides email | 1. Call normalize_spoken_email. 2. Call validate_email. 3. Update 'email' and 'email_valid' in 'updates'. |
| GIVING_GST | user provides GST/UIN | 1. Call validate_gstin. 2. Update 'gstin' and 'gstin_valid' in 'updates'. If invalid, increment 'gst_attempts'. |
| SKIP_GST | "don't have it", "skip" | Set 'gst_skipped': true, move to Node 4. |

=== ROUTING ===
- Stay in NODE_3 until Email and GST (or skipped) are fully captured and validated.
- Note: If user fails GST 2 times, move to NODE_4 anyway and note it in 'notes'.
- Move to NODE_4_CLOSURE naturally once done. Your 'say' MUST be the first question of Node 4.
- Every 'say' MUST end with a question mark.`,
  model: "gpt-4o",
  tools: [validateEmailTool, normalizeSpokenEmailTool, validateGSTINTool],
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: { type: "json_object" } }
});

// ─── NODE 4: QnA & Closure ────────────────────────────────────────────────────────
const closureAgent = new Agent({
  name: "NODE_4_CLOSURE",
  instructions: `${BASE_VOICE_CONTEXT}
${GLOBAL_GUARDRAILS}

=== YOUR TASK ===
Conclude the call. Inform them about the WhatsApp link. Answer any questions using the tool.

=== FLOW ===
1. **Closing**: "Maine saari details note kar li hain. Hamari team aapko ek WhatsApp link bhejegi documents upload karne ke liye. Onboarding tabhi complete hogi jab aap documents verify kar lenge, uske baad hi aap Meesho par selling shuru kar sakte hain. Kya aapko Meesho ke baare mein kuch aur jaanna hai?"
2. **QnA**: If they ask anything, use 'search_knowledge_base' and ALWAYS end with: "Kya koi aur sawaal hai aapka?"

=== RULES ===
- EVERY response must end with a question mark until they are ready to hang up.
- Use the tool for all Meesho info.`,
  model: "gpt-4o",
  tools: [searchKnowledgeBaseTool],
  modelSettings: { temperature: 0.1, topP: 1, maxTokens: 512, store: true, response_format: { type: "json_object" } }
});

// ─── Routing Map ──────────────────────────────────────────────────────────────

const NODE_AGENTS = {
  NODE_0_WELCOME: welcomeAgent,
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
]);

// ─── Default Session State ────────────────────────────────────────────────────

const DEFAULT_SESSION = {
  caller_phone: '',
  // Node 1
  name_spoken: '',
  is_right_person: 'unknown',
  interest_in_meesho: 'unknown',
  has_bank_account: '',
  callback_time: '',
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
  gst_skipped: false,
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
    return {
      say: parsed.say || '',
      updates: (parsed.updates && typeof parsed.updates === 'object') ? parsed.updates : {},
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
  const session = { ...DEFAULT_SESSION, caller_phone: callerPhone };
  let currentNode = 'NODE_0_WELCOME';

  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "voice-ai-platform",
      workflow_id: "wf_meesho_reseller_v3"
    }
  });

  // ── Internal runner ─────────────────────────────────────────────────────

  async function runNode(agent, userMessage, onSayChunk) {
    return await withTrace("Reseller Qualification", async () => {
      if (userMessage) {
        conversationHistory.push({
          role: 'user',
          content: [{ type: 'input_text', text: userMessage }]
        });
      }

      const stream = await runner.run(agent, [...conversationHistory], { stream: true });

      let finalOutputText = "";
      let sentLength = 0;

      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'text_stream') {
          finalOutputText += event.data.text;

          if (onSayChunk) {
            // Match the "say" key up to the first unescaped quote
            const match = finalOutputText.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
            if (match) {
              const currentSay = match[1];
              const unescaped = currentSay.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

              if (unescaped.length > sentLength) {
                const chunk = unescaped.substring(sentLength);
                sentLength = unescaped.length;
                onSayChunk(chunk);
              }
            }
          }
        }
      }

      await stream.completed;
      conversationHistory.push(...stream.newItems.map(item => item.rawItem));
      return stream.finalOutput;
    });
  }

  // ── Mark node as done when leaving it ──────────────────────────────────

  function markNodeDone(nodeName) {
    const match = nodeName.match(/NODE_(\d)/);
    if (match) {
      session[`node${match[1]} _done`] = true;
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

  async function processTranscript(transcript, tts = null) {
    if (TERMINAL_NODES.has(currentNode)) {
      return {
        say: '',
        next_node: currentNode,
        notes: 'Already at terminal node.',
        session: { ...session }
      };
    }

    const agent = NODE_AGENTS[currentNode];
    if (!agent) {
      console.error(`[Workflow] No agent found for node: ${currentNode} `);
      return {
        say: "Thank you for your time. Have a wonderful day!",
        next_node: 'TERM_COMPLETE',
        notes: `Unknown node: ${currentNode} `,
        session: { ...session }
      };
    }

    // Inject session state for all conversational nodes
    let userMessage = transcript;
    if (currentNode !== 'NODE_0_WELCOME') {
      const sessionSummary = { ...session };
      delete sessionSummary.caller_phone;

      // Filter out empty/null values to keep context concise
      const activeData = Object.fromEntries(
        Object.entries(sessionSummary).filter(([_, v]) =>
          v !== '' && v !== null && v !== 0 && v !== false &&
          (Array.isArray(v) ? v.length > 0 : true)
        )
      );

      const today = new Date().toISOString().split('T')[0];
      userMessage = `${transcript}\n\n[SYSTEM: Date: ${today}, Session: ${JSON.stringify(activeData)}]`;
    }

    let hasStreamed = false;
    const raw = await Logger.runWithContext(options.logger?.context || {}, async () => {
      return await runNode(agent, userMessage, (chunk) => {
        if (tts && isActiveCallback && isActiveCallback()) {
          hasStreamed = true;
          tts.sendText(chunk);
        }
      });
    });

    const output = parseAgentOutput(raw);

    // Merge updates into session
    if (output.updates && typeof output.updates === 'object') {
      Object.assign(session, output.updates);
    }

    // Fire-and-forget DB save
    Promise.resolve().then(() => {
      const hasUpdates = output.updates && Object.keys(output.updates).length > 0;
      const hasNotes = output.notes && output.notes !== '' && output.notes !== 'parse_error';

      if (hasUpdates || hasNotes) {
        if (options.logger) {
          options.logger.withComponent('Database').info('Saving session updates', {
            updates: output.updates,
            notes: output.notes
          });
        }
      }
    }).catch(err => {
      if (options.logger) options.logger.withComponent('Database').error('Error saving to DB', err);
    });

    const prevNode = currentNode;
    const nextNode = output.next_node === 'CONTINUE' ? currentNode : output.next_node;

    if (nextNode !== prevNode) {
      markNodeDone(prevNode);
    }

    currentNode = nextNode;

    return {
      say: output.say,
      next_node: nextNode,
      notes: output.notes,
      session: { ...session },
      streamedByNode: hasStreamed
    };
  }

  return {
    getWelcome,
    processTranscript,
    setIsActiveCallback,
    getCurrentNode: () => currentNode,
    getSession: () => ({ ...session }),
    isTerminal: () => TERMINAL_NODES.has(currentNode),
  };
}
