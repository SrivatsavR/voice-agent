import { Runner, Agent } from '@openai/agents';

async function test() {
    const agent = new Agent({
        name: 'test',
        instructions: 'Say hello in valid json. {"say": "hello", "updates": {}}',
        model: 'gpt-4o-mini',
        modelSettings: { response_format: { type: 'json_object' } }
    });
    const runner = new Runner();
    const stream = await runner.run(agent, 'hi', { stream: true });
    console.log('Stream started');
    for await (const e of stream) {
        console.log('Event:', e.type);
        if (e.type === 'raw_model_stream_event') {
            console.log('  Data type:', e.data?.type);
            console.log('  Data text:', e.data?.text);
            console.log('  Part:', e.data?.part);
        }
    }
}
test().catch(console.error);
