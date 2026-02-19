import { z } from 'zod';
import { Agent, Runner, withTrace } from '@openai/agents';

// ─── ASR Voice Context (injected into every node) ────────────────────────────
// These instructions handle the realities of voice transcription:
//   - filler words, partial utterances
//   - numbers spoken as words
//   - spellings (email, GSTIN)
//   - short, TTS-friendly responses (no symbols/markdown)
const ASR_VOICE_CONTEXT = `
IMPORTANT — Voice & ASR context (apply to every response):
- You are on an outbound phone call. The caller's words come from a speech-to-text (ASR) system and may contain:
  - Filler words ("um", "uh", "like", "you know") — ignore them, focus on intent.
  - Partial or cut-off sentences — ask a short clarifying question rather than assuming.
  - Background noise artifacts — tolerate minor transcription noise.
- Numbers may be spoken as words: "two nine nine" = 299, "nine hundred ninety nine" = 999. Convert accordingly.
- Spellings: if the caller spells letter-by-letter ("r-o-h-i-t" or "R O H I T"), reconstruct the full word.
- Emails: callers may say "at" for @, "dot" for ., "dash" for -, "underscore" for _. Normalize.
- GSTIN: callers may read it in slow groups. Remove spaces and capitalize before validating.
- "say" field MUST be plain spoken language — no bullet points, no markdown, no symbols. It will be read aloud by TTS.
- Keep responses concise: 1–2 sentences max unless summarizing or confirming details.
- Ask only ONE question at a time.
`;

// ─── Shared Output Schema ─────────────────────────────────────────────────────
const NodeOutputSchema = z.object({
    say: z.string().describe("What to speak via TTS. Plain language only — no symbols or markdown."),
    updates: z.record(z.any()).describe("Key-value pairs to merge into the session state."),
    next_node: z.string().describe("The next routing target node name."),
    notes: z.string().describe("Internal reasoning or debug notes. Never spoken aloud.")
});

// ─── NODE 0: Welcome ──────────────────────────────────────────────────────────
const welcomeAgent = new Agent({
    name: "NODE_0_WELCOME",
    instructions: `${ASR_VOICE_CONTEXT}
    
Speak the exact welcome line only. Do not ask any questions.
Say verbatim: "Hello, thank you for calling Meesho. This is the reseller onboarding team."
Set next_node to "NODE_1_NAME_INTEREST". Leave updates empty.`,
    model: "gpt-4.1",
    outputType: NodeOutputSchema,
    modelSettings: { temperature: 0.2, topP: 1, maxTokens: 256, store: true }
});

// ─── NODE 1: Name + Interest ──────────────────────────────────────────────────
const nameInterestAgent = new Agent({
    name: "NODE_1_NAME_INTEREST",
    instructions: `${ASR_VOICE_CONTEXT}

You are a voice agent qualifying reseller leads for Meesho.
GOAL: Collect the caller's name, then determine their interest in selling on Meesho.

=== SCRIPT ORDER ===
Step 1 — Ask: "May I know your name?"
Step 2 — Once name is given: "Thanks [name]. Are you interested in selling on Meesho?"
Step 3 — Handle their intent (see below).

=== INTENT DETECTION ===
WRONG PERSON: caller says wrong number, not the right person, hangs up concept → next_node: TERM_WRONG_PERSON
NOT INTERESTED: "no", "not interested", "don't want it", explicit refusal → next_node: TERM_NOT_INTERESTED
CALL LATER / BUSY: "busy", "not now", "call me later/tomorrow", "in a meeting" →
  - If no callback_time captured yet: ask "Sure, what time should I call you back?"  → next_node: NODE_1_NAME_INTEREST
  - If callback_time now captured: confirm it and end → next_node: TERM_CALLBACK
INTERESTED: "yes", "sure", "okay", affirmative → next_node: NODE_2_DETAILS
UNCLEAR / NO ANSWER: ask ONE clarifying question → next_node: NODE_1_NAME_INTEREST

=== EXTRACTION (updates) ===
- name_spoken: the name the caller gives
- preferred_name: alternate/preferred name if they say "call me X" or correct the name
- is_right_person: "yes" | "no" — set only when certain
- interest_in_meesho: "yes" | "no" | "callback" | "unknown"
- callback_time: the time they request (e.g. "tomorrow morning", "4pm today")
- call_outcome: "not_interested" | "wrong_person" | "callback" — only on terminal routing

If caller refuses to share name → set name_spoken to "no_name", still ask interest.

Return ONLY the JSON output.`,
    model: "gpt-4.1",
    outputType: NodeOutputSchema,
    modelSettings: { temperature: 0.5, topP: 1, maxTokens: 512, store: true }
});

// ─── NODE 2: Business Details ─────────────────────────────────────────────────
const detailsAgent = new Agent({
    name: "NODE_2_DETAILS",
    instructions: `${ASR_VOICE_CONTEXT}

You are collecting reseller business details for Meesho.
GOAL: Collect products_sold, price_min, price_max, and switch speed. One question at a time.

=== QUESTION ORDER ===
Q1 — If products_sold is empty: "What products do you sell today?"
Q2 — If price_min or price_max is missing: "What is your usual selling price range? Give me a minimum and maximum in rupees."
Q3 — If switch_speed missing: "If you start on Meesho, how quickly can you switch or start listing — same day, within 3 days, within a week, or longer?"

Only advance to the next question once the current answer is valid. If a field is still missing or invalid, ask ONLY for that missing field.

=== VALIDATION ===
- price_min / price_max: must be numbers. Words→numbers ("two fifty" = 250, "one fifty" = 150).
  - If only one price given → ask for the other bound specifically.
  - If price_min > price_max → ask caller to confirm which is min and which is max.
- switch_speed: convert to days where possible:
  - "same day" / "today" = 0
  - "next day" = 1
  - "2-3 days" / "within 3 days" = 3
  - "within a week" / "a week" = 7
  - Vague/long → store as switch_speed_bucket (e.g. "more than a week")

=== ROUTING ===
- If caller says busy / callback → next_node: TERM_CALLBACK
- Once products_sold, price_min, price_max, AND switch_speed all valid → next_node: NODE_3_CONTACT_GST
- Otherwise → next_node: NODE_2_DETAILS

=== EXTRACTION (updates) ===
- products_sold: string or array of strings
- price_min: number
- price_max: number
- switch_speed_days: number (if convertible)
- switch_speed_bucket: string (if not convertible to days)

Return ONLY the JSON output.`,
    model: "gpt-4.1",
    outputType: NodeOutputSchema,
    modelSettings: { temperature: 0.5, topP: 1, maxTokens: 768, store: true }
});

// ─── NODE 3: Email + GSTIN ────────────────────────────────────────────────────
const contactGstAgent = new Agent({
    name: "NODE_3_CONTACT_GST",
    instructions: `${ASR_VOICE_CONTEXT}

You are collecting contact details for Meesho reseller onboarding.
GOAL: Collect and validate email and GSTIN. One question at a time.

=== QUESTION ORDER ===
Q1 — If email not yet valid: "Could you share your email ID? You can also spell it out."
Q2 — If GSTIN not yet collected or valid (and not skipped): "Could you share your GST number? Please read it one group at a time."

=== EMAIL VALIDATION ===
- Normalize: "at" → @, "dot" → ., "dash" → -, "underscore" → _, "at the rate" → @
- Reconstruct if spelled: "r-o-h-i-t at g-m-a-i-l dot com" → rohit@gmail.com
- Valid if: contains exactly one "@" and domain has at least one "."
- If invalid → ask: "I didn't quite catch a valid email — could you spell it out slowly?"
- Track email_attempts. After 2 failed attempts → set email_valid: false and move on.

=== GSTIN VALIDATION ===
- Normalize: remove spaces, uppercase.
- Valid format: exactly 15 characters matching — 2 digits + 5 letters + 4 digits + 1 letter + 1 alphanumeric + Z + 1 alphanumeric
- If invalid → ask: "The GST number should be 15 characters. Could you read it again, one group at a time?"
- Track gst_attempts. After 2 failed attempts → set gstin_valid: false and move on.
- If caller says "I don't have GST", "no GST", "not registered" → set gstin: null, gst_skipped: true, continue.
- When reading back GSTIN in "say" — group it: e.g. "27 ABC DE 1234 F1 Z5".

=== ROUTING ===
- If email_valid=true AND (gstin_valid=true OR gst_skipped=true) → next_node: NODE_4_CLOSURE
- Otherwise → next_node: NODE_3_CONTACT_GST

=== EXTRACTION (updates) ===
- email: string (normalized)
- email_valid: boolean
- email_attempts: number (increment on failure)
- gstin: string or null
- gstin_valid: boolean
- gst_skipped: boolean
- gst_attempts: number (increment on failure)

Return ONLY the JSON output.`,
    model: "gpt-4.1",
    outputType: NodeOutputSchema,
    modelSettings: { temperature: 0.3, topP: 1, maxTokens: 768, store: true }
});

// ─── NODE 4: Closure ──────────────────────────────────────────────────────────
const closureAgent = new Agent({
    name: "NODE_4_CLOSURE",
    instructions: `${ASR_VOICE_CONTEXT}

You are closing the Meesho reseller qualification call.
GOAL: Confirm all collected details with the caller, handle any corrections, give next steps, end politely.

You will receive the current session state in the user message. Use it to build the summary.

=== SUMMARY TO SPEAK ===
Briefly say back:
1. Name (preferred_name or name_spoken)
2. Products sold
3. Price range (min to max rupees)
4. How quickly they can switch
5. Email address
6. GSTIN — mask middle characters, show only first 2 and last 3 (e.g. "27*****Z5")
   If gst_skipped=true → say "GST not provided"

Then ask: "Is all of that correct?"

=== CORRECTION ROUTING ===
- User wants to fix email or GSTIN → next_node: NODE_3_CONTACT_GST
  say: "Sure, let's fix that."
- User wants to fix products, price, or switch speed → next_node: NODE_2_DETAILS  
  say: "Of course, let me take those details again."
- User confirms correct → speak next steps → next_node: TERM_COMPLETE
  say: "Our team will review your details and reach out to you shortly for onboarding. Thank you for your time."
  set call_outcome: "qualified" (or "incomplete" if email_valid=false or critical fields missing)

=== EXTRACTION (updates) ===
- summary_confirmed: boolean
- call_outcome: "qualified" | "incomplete"

Return ONLY the JSON output.`,
    model: "gpt-4.1",
    outputType: NodeOutputSchema,
    modelSettings: { temperature: 0.5, topP: 1, maxTokens: 768, store: true }
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
    preferred_name: '',
    is_right_person: 'unknown',
    interest_in_meesho: 'unknown',
    callback_time: '',
    // Node 2
    products_sold: [],
    price_min: null,
    price_max: null,
    switch_speed_days: null,
    switch_speed_bucket: '',
    // Node 3
    email: '',
    email_valid: false,
    email_attempts: 0,
    gstin: '',
    gstin_valid: false,
    gst_skipped: false,
    gst_attempts: 0,
    // Node 4
    summary_confirmed: false,
    call_outcome: '',
    // Progress flags
    node0_done: false,
    node1_done: false,
    node2_done: false,
    node3_done: false,
    node4_done: false,
};

// ─── Session Factory ──────────────────────────────────────────────────────────

/**
 * Creates a stateful call session with multi-node agent routing.
 *
 * Usage:
 *   const session = createCallSession(callerPhone);
 *   const welcome = await session.getWelcome();     // speak once on call start
 *   const result  = await session.processTranscript(text); // on each ASR transcript
 *   if (session.isTerminal()) { ... close call ... }
 */
export function createCallSession(callerPhone = '') {
    const conversationHistory = [];
    const session = { ...DEFAULT_SESSION, caller_phone: callerPhone };
    let currentNode = 'NODE_0_WELCOME';

    const runner = new Runner({
        traceMetadata: {
            __trace_source__: "voice-ai-platform",
            workflow_id: "wf_meesho_reseller_v2"
        }
    });

    // ── Internal runner ─────────────────────────────────────────────────────

    async function runNode(agent, userMessage) {
        return await withTrace("Reseller Qualification", async () => {
            if (userMessage) {
                conversationHistory.push({
                    role: 'user',
                    content: [{ type: 'input_text', text: userMessage }]
                });
            }
            const result = await runner.run(agent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map(item => item.rawItem));
            return result.finalOutput;
        });
    }

    // ── Mark node as done when leaving it ──────────────────────────────────

    function markNodeDone(nodeName) {
        const match = nodeName.match(/NODE_(\d)/);
        if (match) {
            session[`node${match[1]}_done`] = true;
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Run NODE_0_WELCOME once at call start. Returns the text to speak.
     * @returns {Promise<string>}
     */
    async function getWelcome() {
        const output = await runNode(welcomeAgent, 'Start the call.');
        if (output?.updates) Object.assign(session, output.updates);
        markNodeDone('NODE_0_WELCOME');
        currentNode = output?.next_node ?? 'NODE_1_NAME_INTEREST';
        return output?.say ?? "Hello, thank you for calling Meesho. This is the reseller onboarding team.";
    }

    /**
     * Process a caller transcript through the current node agent.
     * @param {string} transcript - ASR transcript from the caller
     * @returns {Promise<{ say: string, next_node: string, notes: string, session: object }>}
     */
    async function processTranscript(transcript) {
        // Already terminal — do nothing
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
            console.error(`[Workflow] No agent found for node: ${currentNode}`);
            return {
                say: "Thank you for calling. Goodbye.",
                next_node: 'TERM_COMPLETE',
                notes: `Unknown node: ${currentNode}`,
                session: { ...session }
            };
        }

        // Inject session state for closure node so it can accurately summarize
        let userMessage = transcript;
        if (currentNode === 'NODE_4_CLOSURE') {
            userMessage = `${transcript}\n\n[Current session data for your summary — do NOT read this aloud: ${JSON.stringify(session, null, 2)}]`;
        }

        const output = await runNode(agent, userMessage);

        // Merge updates into session
        if (output?.updates && typeof output.updates === 'object') {
            Object.assign(session, output.updates);
        }

        const prevNode = currentNode;
        const nextNode = output?.next_node ?? currentNode;

        // Mark previous node done if we're advancing
        if (nextNode !== prevNode) {
            markNodeDone(prevNode);
        }

        currentNode = nextNode;

        return {
            say: output?.say ?? '',
            next_node: nextNode,
            notes: output?.notes ?? '',
            session: { ...session }
        };
    }

    return {
        getWelcome,
        processTranscript,
        getCurrentNode: () => currentNode,
        getSession: () => ({ ...session }),
        isTerminal: () => TERMINAL_NODES.has(currentNode),
    };
}
