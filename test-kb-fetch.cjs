// Unit test for synchronous Knowledge Base fetch in closure node
// Run with: node test-kb-fetch.cjs

const { createCallSession } = require('./services/agent-workflow');
const { searchKnowledgeBaseTool } = require('./utils/vector-search');

// Mock TTS that records spoken chunks
class MockTTS {
    constructor() { this.spoken = []; }
    sendText(txt) { this.spoken.push(txt); }
    flush() { }
    isSpeaking = false;
}

(async () => {
    // Stub KB tool to return a deterministic answer
    const originalExecute = searchKnowledgeBaseTool.execute;
    searchKnowledgeBaseTool.execute = async (params) => {
        return JSON.stringify({ success: true, data: '7 days payment cycle for sellers.', timestamp: Date.now() });
    };

    const tts = new MockTTS();
    const session = createCallSession('', { logger: console });

    // Walk through the flow to reach the closure node
    await session.getWelcome();                     // NODE_1_NAME_INTEREST
    await session.processTranscript('Amrita', tts);   // name
    await session.processTranscript('haan', tts);    // interest
    await session.processTranscript('books', tts);   // products
    await session.processTranscript('100-200', tts); // price range
    await session.processTranscript('tomorrow', tts); // listing date
    await session.processTranscript('amrita@example.com', tts); // email
    await session.processTranscript('yes', tts);      // GST acceptance
    await session.processTranscript('123456789012345', tts); // GST number

    // Now we are in NODE_4_CLOSURE. Ask the payment‑cycle question.
    await session.processTranscript('What is the payment cycle for sellers?', tts);

    // Restore original tool
    searchKnowledgeBaseTool.execute = originalExecute;

    const allSpoken = tts.spoken.join(' ');
    if (allSpoken.includes('7 days')) {
        console.log('✅ Test passed: KB answer used.');
    } else {
        console.error('❌ Test failed: KB answer not found in spoken output.');
        console.error('Spoken output:', allSpoken);
        process.exit(1);
    }
})();
