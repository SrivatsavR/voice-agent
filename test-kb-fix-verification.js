import { createCallSession } from './services/agent-workflow.js';
import { Logger } from './utils/logger.js';

async function verifyKBFIX() {
    console.log('--- Verifying KB Response Fix (V3 - Discrete State) ---');

    const callId = 'test-kb-fix-v3';
    const log = Logger.forCall(callId, 'stream-789', '1234567890');
    const session = createCallSession('1234567890', { logger: log });

    // 1. Manually simulate state inside NODE_4_CLOSURE
    // We want to test the prompt logic in processTranscript when results arrive.

    // Start welcome to initialize
    await session.getWelcome();

    console.log('\n[Phase 1] Injecting KB Search Active state...');
    // We simulate the moment after the agent says "Zaroor, main check karke batati hoon."
    // and updates the session with kb_query.

    // First, a normal turn to get into history
    await session.processTranscript("What is the payment cycle?");

    // Manually set session flags (simulating background process started)
    const innerSession = session.getSession();
    innerSession.kb_search_active = true;

    console.log('Current search flag:', innerSession.kb_search_active);

    console.log('\n[Phase 2] Simulating KB result injection...');
    // In background-kb logic, we clear search_active THEN call processTranscript
    innerSession.kb_search_active = false;

    const kbResult = "Sellers are paid every 7 days.";
    const r5 = await session.processTranscript(`[SYSTEM: Knowledge Base Results: ${kbResult}]`);

    console.log('Agent Answer:', r5.say);

    // Final Validation: History Check
    // The history item for the LAST user role should NOT have the "Wait for results" message.
    const finalHistory = session.getSession().transcript;
    const lastUserMsg = finalHistory.filter(m => m.role === 'user').pop();

    console.log('\nFinal User Message in History Content:\n');
    console.log(lastUserMsg.content);

    const hasWaitWarning = lastUserMsg.content.includes('Wait for results');

    if (hasWaitWarning) {
        console.log('\n❌ FAIL: "Wait for results" warning was still appended!');
    } else {
        console.log('\n✅ PASS: Contradictory "Wait for results" warning was correctly omitted.');
    }
}

verifyKBFIX().catch(console.error);
