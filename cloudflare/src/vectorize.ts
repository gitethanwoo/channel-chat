// Vectorize operations module
// Handles vector storage and similarity search using Cloudflare Vectorize

// Type for the sync embedding response (not the async one)
interface EmbeddingResponse {
  shape?: number[];
  data?: number[][];
  pooling?: "mean" | "cls";
}

export type AiLike = Pick<Ai, "run">;
export type VectorizeIndexLike = Pick<VectorizeIndex, "upsert" | "query" | "deleteByIds">;

/**
 * Generate an embedding for a single text using Workers AI
 * Model: @cf/baai/bge-base-en-v1.5 (768 dimensions)
 */
export async function generateEmbedding(ai: AiLike, text: string): Promise<number[]> {
  const response = (await ai.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as EmbeddingResponse;

  if (!response.data || response.data.length === 0) {
    throw new Error("No embedding data returned");
  }

  return response.data[0];
}

/**
 * Generate embeddings for multiple texts using Workers AI
 * Workers AI supports batching for efficiency
 */
export async function generateEmbeddings(ai: AiLike, texts: string[]): Promise<number[][]> {
  const response = (await ai.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  })) as EmbeddingResponse;

  if (!response.data) {
    throw new Error("No embedding data returned");
  }

  return response.data;
}

/**
 * Insert or update a single vector in Vectorize
 * @param vectorize - The Vectorize index binding
 * @param id - The vectorize_id to store (will also be stored in D1)
 * @param embedding - The embedding vector (768 dimensions)
 * @param metadata - Optional metadata (e.g., video_id for filtering)
 */
export async function upsertVector(
  vectorize: VectorizeIndexLike,
  id: string,
  embedding: number[],
  metadata?: Record<string, string>
): Promise<void> {
  await vectorize.upsert([
    {
      id,
      values: embedding,
      metadata,
    },
  ]);
}

/**
 * Batch upsert multiple vectors into Vectorize
 * @param vectorize - The Vectorize index binding
 * @param vectors - Array of vectors with id, embedding, and optional metadata
 */
export async function upsertVectors(
  vectorize: VectorizeIndexLike,
  vectors: Array<{ id: string; embedding: number[]; metadata?: Record<string, string> }>
): Promise<void> {
  const vectorizeVectors = vectors.map((v) => ({
    id: v.id,
    values: v.embedding,
    metadata: v.metadata,
  }));
  await vectorize.upsert(vectorizeVectors);
}

/**
 * Search for similar vectors using cosine similarity
 * @param vectorize - The Vectorize index binding
 * @param queryEmbedding - The query embedding vector
 * @param limit - Maximum number of results to return
 * @returns Array of matches with id and similarity score
 */
export async function searchVectors(
  vectorize: VectorizeIndexLike,
  queryEmbedding: number[],
  limit: number
): Promise<Array<{ id: string; score: number }>> {
  const results = await vectorize.query(queryEmbedding, {
    topK: limit,
    returnMetadata: "none",
  });

  return results.matches.map((match) => ({
    id: match.id,
    score: match.score,
  }));
}

/**
 * Delete vectors by their IDs
 * @param vectorize - The Vectorize index binding
 * @param ids - Array of vector IDs to delete
 */
export async function deleteVectors(vectorize: VectorizeIndexLike, ids: string[]): Promise<void> {
  await vectorize.deleteByIds(ids);
}
