const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Streaming chat completion from OpenAI.
 * @param {string} prompt - User input text.
 * @param {string} systemPrompt - System prompt to define behavior.
 * @param {Array} history - Array of previous messages for context.
 * @returns {AsyncGenerator} - Yields chunks of text response.
 */
async function* streamOpenAIResponse(prompt, systemPrompt, history = []) {
    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: prompt }
        ];

        const stream = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            stream: true,
        });

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                yield content;
            }
        }
    } catch (error) {
        console.error('OpenAI Stream Error:', error);
        throw error;
    }
}

module.exports = { streamOpenAIResponse };
