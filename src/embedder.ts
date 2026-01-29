/**
 * Embedder module using Google GenAI for text embeddings.
 */

import { GoogleGenAI } from '@google/genai';

// Singleton client instance
let _client: GoogleGenAI | null = null;

// Embedding configuration
const EMBEDDING_MODEL = 'gemini-embedding-001';
const OUTPUT_DIMENSIONALITY = 768;
const DEFAULT_BATCH_SIZE = 100;
const BATCH_DELAY = 100; // milliseconds between batches
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // initial delay for exponential backoff

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize embedding vector (required for dimensions < 3072).
 */
function normalizeEmbedding(embedding: number[]): number[] {
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return embedding;
  return embedding.map(val => val / magnitude);
}

/**
 * Get or create a singleton GenAI client.
 */
function getClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GOOGLE_API_KEY environment variable is not set. ' +
        'Please set it with your Google AI API key.'
      );
    }
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/**
 * Generate embeddings for a single text.
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getClient();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: OUTPUT_DIMENSIONALITY },
      });

      if (!response.embeddings || response.embeddings.length === 0) {
        throw new Error('No embeddings returned from API');
      }

      // Normalize since we're using < 3072 dimensions
      return normalizeEmbedding(response.embeddings[0].values || []);
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
        const response = await client.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: batch,
          config: { outputDimensionality: OUTPUT_DIMENSIONALITY },
        });

        if (!response.embeddings) {
          throw new Error('No embeddings returned from API');
        }

        for (const embedding of response.embeddings) {
          // Normalize since we're using < 3072 dimensions
          allEmbeddings.push(normalizeEmbedding(embedding.values || []));
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
