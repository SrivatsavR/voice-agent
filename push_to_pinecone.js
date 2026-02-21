import { Pinecone } from '@pinecone-database/pinecone';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'meesho-index';

if (!PINECONE_API_KEY) {
    console.error('Error: PINECONE_API_KEY is missing in .env file.');
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const pineconeIndex = pc.index(PINECONE_INDEX_NAME);

async function main() {
    const text = fs.readFileSync(join(__dirname, 'meesho-terms.txt'), 'utf8');

    // Splitting the terms and conditions logically, for instance by sections or paragraphs.
    const chunks = text.split(/\n\s*\n/).map(chunk => chunk.trim()).filter(chunk => chunk.length > 50);

    console.log(`Extracted ${chunks.length} chunks from the document. Generating embeddings using Pinecone Inference...`);

    const batchSize = 96; // max 96 for pinecone inference typically
    let totalUpserted = 0;
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        // Generate embeddings using Pinecone Inference API
        const embeddingResponse = await pc.inference.embed({
            model: 'llama-text-embed-v2',
            inputs: batch,
            parameters: { input_type: 'passage', truncate: 'END' }
        });

        // Prepare records for Pinecone
        const records = embeddingResponse.data.map((emb, idx) => ({
            id: `meesho-terms-chunk-${i + idx}`,
            values: emb.values,
            metadata: { text: batch[idx] }
        }));

        console.log(`Upserting batch ${Math.floor(i / batchSize) + 1} (${records.length} records) to index: ${PINECONE_INDEX_NAME}...`);
        if (records.length === 0) { console.log('Empty records array?', embeddingResponse); }
        await pineconeIndex.upsert({ records });
        totalUpserted += records.length;
    }

    console.log(`Successfully pushed ${totalUpserted} chunks of terms and conditions to Pinecone!`);
}

main().catch(error => {
    console.error('Error pushing to Pinecone:', error);
});
