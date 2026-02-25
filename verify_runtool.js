
async function runToolSim(toolObj, params) {
    const rawResult = await toolObj.execute(params);

    // Logic from agent-workflow.js:
    if (typeof rawResult === 'string') {
        try {
            const parsed = JSON.parse(rawResult);
            if (parsed && typeof parsed === 'object' && ('success' in parsed)) {
                return rawResult;
            }
        } catch (e) { }
    }

    const safeResult = {
        success: true,
        data: rawResult,
        timestamp: Date.now()
    };
    return JSON.stringify(safeResult);
}

async function test() {
    console.log('--- Test 1: Standard Tool (Returns JSON String) ---');
    const mockTool = {
        name: 'mock',
        execute: async () => JSON.stringify({ success: true, data: "some data", timestamp: 123 })
    };

    const result = await runToolSim(mockTool, {});
    console.log('Result:', result);
    if (result === JSON.stringify({ success: true, data: "some data", timestamp: 123 })) {
        console.log('SUCCESS: No double encoding for standard tool.');
    } else {
        console.log('FAILURE: Still double encoded or corrupted.');
    }

    console.log('\n--- Test 2: Raw Tool (Returns Row Object) ---');
    const rawTool = {
        name: 'raw',
        execute: async () => ({ foo: 'bar' })
    };
    const result2 = await runToolSim(rawTool, {});
    console.log('Result 2:', result2);
    const parsed2 = JSON.parse(result2);
    if (parsed2.success === true && parsed2.data.foo === 'bar') {
        console.log('SUCCESS: Wrapped raw object correctly.');
    } else {
        console.log('FAILURE: Failed to wrap raw object.');
    }

    console.log('\n--- Test 3: Raw String Tool ---');
    const stringTool = {
        name: 'string',
        execute: async () => "just a string"
    };
    const result3 = await runToolSim(stringTool, {});
    console.log('Result 3:', result3);
    const parsed3 = JSON.parse(result3);
    if (parsed3.success === true && parsed3.data === "just a string") {
        console.log('SUCCESS: Wrapped raw string correctly.');
    } else {
        console.log('FAILURE: Failed to wrap raw string.');
    }
}

test();
