import { validateEmailTool, normalizeSpokenEmailTool, validatePriceRangeTool, normalizeListingDateTool } from './utils/validators.js';
import { searchKnowledgeBaseTool } from './utils/vector-search.js';

// Mock runTool logic from agent-workflow.js
const runTool = async (toolObj, params) => {
    try {
        console.log(`Running tool: ${toolObj?.name || 'unknown'}`);

        let rawResult;
        if (toolObj.execute) {
            rawResult = await toolObj.execute(params);
        } else if (toolObj.invoke) {
            // Wrapped tool. Invoke expects (runContext, jsonInputString)
            const inputStr = typeof params === 'string' ? params : JSON.stringify(params);
            rawResult = await toolObj.invoke({}, inputStr);
        } else {
            throw new Error(`Tool ${toolObj?.name || 'unknown'} has no execute or invoke method`);
        }

        const safeResult = {
            success: true,
            data: rawResult,
            timestamp: Date.now()
        };

        return JSON.stringify(safeResult);
    } catch (err) {
        console.error('runTool Error:', err);
        return JSON.stringify({
            success: false,
            error: err.message,
            timestamp: Date.now()
        });
    }
};

async function testTools() {
    console.log('--- Testing Tools via runTool Wrapper ---');

    console.log('\n1. Testing email validation...');
    const emailRes = await runTool(validateEmailTool, { email: 'test@example.com' });
    console.log('Final Output:', emailRes);
    const p1 = JSON.parse(emailRes);
    if (typeof p1.data === 'string' && p1.data.includes('success')) {
        console.log('WARNING: Double JSON detected in p1.data!');
    }

    console.log('\n2. Testing spoken email normalization...');
    const spokenRes = await runTool(normalizeSpokenEmailTool, { spoken_email: 'test at gmail dot com' });
    console.log('Final Output:', spokenRes);

    console.log('\n3. Testing price range (should swap)...');
    const priceRes = await runTool(validatePriceRangeTool, { price_min: 500, price_max: 200 });
    console.log('Final Output:', priceRes);

    console.log('\n4. Testing listing date...');
    const dateRes = await runTool(normalizeListingDateTool, { spoken_date: 'tomorrow', current_date_iso: '2026-02-24' });
    console.log('Final Output:', dateRes);

    console.log('\n5. Testing knowledge base search...');
    // KB search might fail if Pinecone isn't set up, but we want to see if the tool call ITSELF works
    try {
        const kbRes = await runTool(searchKnowledgeBaseTool, { query: 'what is meesho?' });
        console.log('Final Output:', kbRes);
    } catch (e) {
        console.log('KB Search failed as expected (likely config):', e.message);
    }
}

const safeHistorySlice = (history) => {
    let sliced = history.slice(-20);
    const clean = sliced.map(msg => ({
        role: msg.role,
        content: msg.content || null,
        tool_calls: msg.tool_calls || null,
        tool_call_id: msg.tool_call_id || null,
        name: msg.name || null
    }));

    for (let i = clean.length - 1; i >= 0; i--) {
        if (clean[i].role === 'tool' && !clean[i - 1]?.tool_calls) {
            for (let j = i - 1; j >= 0; j--) {
                if (clean[j].role === 'assistant' && clean[j].tool_calls) {
                    return clean.slice(j);
                }
            }
            return clean.slice(i + 1);
        }
    }
    return clean;
};

function testHistorySlicer() {
    console.log('\n--- Testing History Slicer ---');

    const badHistory = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call1', function: { name: 't1' } }] },
        // Slice
        { role: 'tool', tool_call_id: 'call1', content: 'result' }
    ];

    const safeSlice = safeHistorySlice(badHistory);
    console.log('Safe slice includes assistant:', safeSlice[0].role === 'assistant');

    const orphanedHistory = [
        { role: 'tool', tool_call_id: 'callX', content: 'orphan' }
    ];
    const fixedOrphan = safeHistorySlice(orphanedHistory);
    console.log('Fixed orphan length (should be 0):', fixedOrphan.length);
}

async function runAll() {
    await testTools();
    testHistorySlicer();
}

runAll().catch(console.error);
