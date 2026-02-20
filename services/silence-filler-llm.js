import OpenAI from 'openai';

const openai = new OpenAI();

/**
 * Generates a contextual silence filler phrase using a small LLM.
 * 
 * @param {object} session - The current extraction session state
 * @param {Logger} log - Logger instance
 * @returns {Promise<string>} A warm, contextually relevant filler phrase
 */
export async function generateContextualFiller(session, log) {
    const compLog = log.withComponent('FillerLLM');
    const timer = compLog.time('generateFiller');

    try {
        const name = session.preferred_name || session.name_spoken || 'Seller';

        // Build context summary from state
        const contextLines = [];
        if (session.name_spoken) contextLines.push(`Name: ${name}`);
        if (session.products_sold?.length) contextLines.push(`Products: ${session.products_sold.join(', ')}`);
        if (session.email) contextLines.push(`Email: ${session.email}`);
        if (session.interest_in_meesho === 'yes') contextLines.push(`Interest: Yes`);

        const contextStr = contextLines.length > 0 ? contextLines.join(', ') : 'Initial greeting';

        const systemPrompt = `
You are a Meesho Seller Onboarding Specialist. The caller has been silent for a few seconds.
Your goal is to generate a very brief (max 6-8 words), natural, and gentle silence filler phrase in Hinglish (Hindi + English).

=== RULES ===
1. Be polite and patient. Act like a human making a phone call.
2. If this is the first silence, you can say something like "take your time". If they've been silent a lot, ask if they are still there.
3. Use the seller's name if provided: "${name}".
4. Use a mix of Hindi and English like a natural Indian conversation. Do NOT sound like a robotic IVR.
5. Output ONLY the phrase text. No quotes, no intro, no punctuation at the end usually.
6. Do NOT ask for new information.

=== CONTEXT ===
${contextStr}

=== EXAMPLES ===
- ${name} ji? Take your time, no rush.
- Aaraam se sochiye, main yahaan hoon.
- Hello ${name} ji, aap sun paa rahe hain?
- Take your time, ${name} ji.
- Koi doubt ho toh poochiye, I am here.
`.trim();

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: "Generate a filler phrase." }
            ],
            temperature: 0.7,
            max_tokens: 30,
        });

        const phrase = response.choices[0]?.message?.content?.trim() || "Hello? Aap sun paa rahe hain?";
        compLog.timeEnd(timer, { phrase });
        return phrase;

    } catch (err) {
        compLog.error('Error generating filler', err);
        compLog.timeEnd(timer, { error: true });
        return "Hello? Aap sun paa rahe hain?"; // Fallback
    }
}
