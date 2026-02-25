import { Pinecone } from '@pinecone-database/pinecone';
import { tool } from '@openai/agents';
import { z } from 'zod';
import dotenv from 'dotenv';
import { Logger } from './logger.js';

const log = new Logger('VectorSearch');

dotenv.config();

// Ensure these are set in your .env file
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'meesho-index';

// Initialize clients
let pc = null;
let pineconeIndex = null;

if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
    pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    pineconeIndex = pc.index(PINECONE_INDEX_NAME);
} else {
    log.warn('Pinecone API key or Index Name is missing in .env. Search will be disabled.');
}




export const executeKBSearch = async (params) => {
    try {
        const query = params.query || params.question;
        if (!query) return JSON.stringify({ success: false, error: "Please ask a specific question.", timestamp: Date.now() });

        if (!pineconeIndex || !pc) {
            return JSON.stringify({
                success: true,
                data: "I'm sorry, my knowledge base is currently offline. Is there anything else I can assist you with?",
                timestamp: Date.now()
            });
        }

        log.info(`Generating embedding for query: "${query}"`);

        // 1. Generate an embedding for the user's question
        const embeddingResponse = await pc.inference.embed({
            model: 'llama-text-embed-v2',
            inputs: [query],
            parameters: { input_type: 'query' }
        });

        const queryVector = embeddingResponse.data[0].values;

        // 2. Query Pinecone
        const searchResults = await pineconeIndex.query({
            vector: queryVector,
            topK: 5,
            includeMetadata: true,
        });

        if (!searchResults.matches || searchResults.matches.length === 0) {
            return JSON.stringify({
                success: true,
                data: "I couldn't find a specific answer to that question in my documentation.",
                timestamp: Date.now()
            });
        }

        // 3. Extract text
        const snippets = searchResults.matches
            .filter(match => match.metadata && match.metadata.text)
            .map((match, i) => `[Source ${i + 1}]: ${match.metadata.text}`);

        if (snippets.length === 0) {
            return JSON.stringify({
                success: true,
                data: "I found some related information but it isn't formatted correctly. Please contact human support.",
                timestamp: Date.now()
            });
        }

        const combinedContext = snippets.join('\n\n---\n\n');
        return JSON.stringify({
            success: true,
            data: `Information from the Knowledge Base:\n${combinedContext}`,
            timestamp: Date.now()
        });

    } catch (error) {
        log.error('Knowledge Base Search Error', error);
        return JSON.stringify({
            success: false,
            error: "An error occurred while searching the knowledge base.",
            timestamp: Date.now()
        });
    }
}

export const searchKnowledgeBaseTool = tool({
    name: 'search_knowledge_base',
    description: "Searches the Meesho onboarding knowledge base (Vector DB) for answers to the caller's questions.",
    parameters: z.object({
        query: z.string().describe('The specific question asked by the user.').optional().nullable(),
        question: z.string().describe('Alias for query.').optional().nullable()
    }),
    execute: executeKBSearch
});
