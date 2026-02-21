import { Pinecone } from '@pinecone-database/pinecone';
import { tool } from '@openai/agents';
import { z } from 'zod/v3';
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



export const searchKnowledgeBaseTool = tool({
    name: 'search_knowledge_base',
    description: "Searches the Meesho onboarding knowledge base (Vector DB) for answers to the caller's questions.",
    parameters: z.object({
        query: z.string().describe('The search query or question asked by the user, formatted for the vector index.')
    }).strict(),
    execute: async ({ query }) => {
        try {
            if (!pineconeIndex || !pc) {
                return "I'm sorry, my knowledge base is currently offline. Is there anything else I can assist you with?";
            }

            log.info(`Generating embedding for query: "${query}"`);

            // 1. Generate an embedding for the user's question using Pinecone Inference
            const embeddingResponse = await pc.inference.embed({
                model: 'llama-text-embed-v2',
                inputs: [query],
                parameters: { input_type: 'query' }
            });

            const queryVector = embeddingResponse.data[0].values;
            log.info(`Generated embedding vector (first 5 of ${queryVector.length})`, queryVector.slice(0, 5));

            // 2. Query Pinecone using the embedding
            log.info(`Querying Pinecone index: ${PINECONE_INDEX_NAME}`);
            const searchResults = await pineconeIndex.query({
                vector: queryVector,
                topK: 3, // Change this to return more chunks if needed
                includeMetadata: true,
            });

            if (!searchResults.matches || searchResults.matches.length === 0) {
                return "I couldn't find a specific answer to that question in my documentation.";
            }

            // 3. Extract the text chunks from the results
            const snippets = searchResults.matches
                .filter(match => match.metadata && match.metadata.text)
                .map(match => match.metadata.text);

            if (snippets.length === 0) {
                return "I found some related information but it isn't formatted correctly to read. Please contact human support.";
            }

            // Compile the relevant pieces for the LLM to read and synthesize into an answer
            const combinedContext = snippets.join('\n\n---\n\n');
            log.info(`Retrieved ${snippets.length} relevant context chunks from Pinecone`, snippets);

            return `Information from the Knowledge Base:\n${combinedContext}`;

        } catch (error) {
            log.error('Knowledge Base Search Error', error);
            return "An error occurred while searching the knowledge base. Please let the user know you cannot answer right now.";
        }
    }
});
