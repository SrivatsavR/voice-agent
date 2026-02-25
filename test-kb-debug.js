import dotenv from 'dotenv';
import { executeKBSearch } from './utils/vector-search.js';
import OpenAI from 'openai';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
    const query = process.argv[2] || "What is the payment cycle for sellers?";
    console.log(`\n========================================`);
    console.log(`🔍 DEBUG KB FETCH`);
    console.log(`========================================\n`);
    console.log(`💬 User Query: "${query}"\n`);

    // 1. Fetch chunks
    console.log(`[1] Fetching chunks from Pinecone...`);
    let kbResultRaw;
    try {
        // Direct call to the execution logic, bypassing the agent tool wrapper
        kbResultRaw = await executeKBSearch({ query });
    } catch (err) {
        console.error(`❌ Error fetching KB chunks:`, err);
        return;
    }

    let kbResultData;
    try {
        const parsed = JSON.parse(kbResultRaw);
        kbResultData = parsed.data || kbResultRaw;
    } catch (err) {
        kbResultData = kbResultRaw;
    }

    console.log(`\n📋 RETRIEVED CONTEXT:\n`);
    console.log(kbResultData);
    console.log(`\n----------------------------------------\n`);

    // 2. Simulate LLM Answer (NODE_4_CLOSURE)
    console.log(`[2] Simulating LLM Answer Generation...\n`);

    const systemPrompt = `
You are a Meesho Reseller Onboarding Specialist. 
A user asked a question, and the system fetched the Knowledge Base Results.
Your task is to explain the information simply in Hindi and ask: "Kya aapko kuch aur jaanna hai?"
Use Hinglish appropriately. Keep it brief.
`;

    const userPrompt = `User Question: "${query}"\n\n[SYSTEM: Knowledge Base Results: ${kbResultData}]`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1
        });

        console.log(`🤖 LLM ANSWER:\n`);
        console.log(response.choices[0].message.content);
        console.log(`\n========================================\n`);
    } catch (err) {
        if (err.message.includes('API key')) {
            console.warn(`⚠️ OpenAI API key issue, but we got the KB results!`);
        } else {
            console.error(`❌ OpenAI Error:`, err);
        }
    }
}

main();
