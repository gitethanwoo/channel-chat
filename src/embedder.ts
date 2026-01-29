/**
 * Embedder module using Google GenAI for text embeddings.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// Singleton client instance
let _client: GoogleGenerativeAI | null = null;

// Embedding configuration
const EMBEDDING_MODEL = 'text-embedding-004';
const DEFAULT_BATCH_SIZE = 100;
const BATCH_DELAY = 100; // milliseconds between batches
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // initial delay for exponential backoff

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get or create a singleton GenAI client.
 */
function getClient(): GoogleGenerativeAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GOOGLE_API_KEY environment variable is not set. ' +
        'Please set it with your Google AI API key.'
      );
    }
    _client = new GoogleGenerativeAI(apiKey);
  }
  return _client;
}

/**
 * Generate embeddings for a single text.
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: EMBEDDING_MODEL });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      // Retry on rate limit errors
      if (errorStr.includes('rate') || errorStr.includes('quota') || errorStr.includes('429')) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
      }
      throw error;
    }
  }

  throw new Error(`Failed to embed text after ${MAX_RETRIES} retries`);
}

/**
 * Generate embeddings for multiple texts in batches.
 */
export async function embedBatch(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
  showProgress: boolean = true
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = getClient();
  const model = client.getGenerativeModel({ model: EMBEDDING_MODEL });
  const allEmbeddings: number[][] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);

  for (let batchIdx = 0; batchIdx < texts.length; batchIdx += batchSize) {
    const batch = texts.slice(batchIdx, batchIdx + batchSize);
    const batchNum = Math.floor(batchIdx / batchSize) + 1;

    if (showProgress && totalBatches > 1) {
      console.log(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);
    }

    // Retry logic for the batch
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await model.batchEmbedContents({
          requests: batch.map(text => ({ content: { parts: [{ text }], role: 'user' } })),
        });

        for (const embedding of result.embeddings) {
          allEmbeddings.push(embedding.values);
        }

        break; // Success, exit retry loop
      } catch (error) {
        const errorStr = String(error).toLowerCase();
        // Retry on rate limit errors
        if (errorStr.includes('rate') || errorStr.includes('quota') || errorStr.includes('429')) {
          if (attempt < MAX_RETRIES - 1) {
            const delay = RETRY_DELAY * Math.pow(2, attempt);
            if (showProgress) {
              console.log(`Rate limited, waiting ${delay / 1000}s before retry...`);
            }
            await sleep(delay);
            continue;
          }
        }
        throw error;
      }
    }

    // Add delay between batches to avoid rate limiting
    if (batchIdx + batchSize < texts.length) {
      await sleep(BATCH_DELAY);
    }
  }

  if (showProgress && totalBatches > 1) {
    console.log(`Embedded ${allEmbeddings.length} texts successfully.`);
  }

  return allEmbeddings;
}
