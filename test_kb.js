
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'meesho-index';

async function testPinecone() {
    if (!PINECONE_API_KEY) {
        console.error('Error: PINECONE_API_KEY is missing in .env');
        return;
    }

    try {
        const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
        const pineconeIndex = pc.index(PINECONE_INDEX_NAME);

        console.log(`Testing Pinecone Index: ${PINECONE_INDEX_NAME}`);

        // Try a simple query
        const query = "What is Meesho commission?";
        console.log(`Querying: "${query}"`);

        // Generate embedding using the same model as in vector-search.js
        const embeddingResponse = await pc.inference.embed({
            model: 'llama-text-embed-v2',
            inputs: [query],
            parameters: { input_type: 'query' }
        });

        const queryVector = embeddingResponse.data[0].values;
        console.log('Generated query vector successfully.');

        const searchResults = await pineconeIndex.query({
            vector: queryVector,
            topK: 3,
            includeMetadata: true,
        });

        console.log('\n--- Search Matches ---');
        console.log(JSON.stringify(searchResults.matches, null, 2));

        if (!searchResults.matches || searchResults.matches.length === 0) {
            console.log('\nWARNING: No matches found.');
        } else {
            const hasText = searchResults.matches.some(m => m.metadata && m.metadata.text);
            if (!hasText) {
                console.log('\nWARNING: Matches found but metadata "text" field is missing.');
                // Check what metadata fields DO exist
                const sampleMetadata = searchResults.matches[0].metadata;
                console.log('Available metadata fields:', Object.keys(sampleMetadata || {}));
            } else {
                console.log('\nSUCCESS: Found relevant text in metadata.');
            }
        }

    } catch (error) {
        console.error('\nERROR during Pinecone test:', error);
    }
}

testPinecone();
