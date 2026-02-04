import { describe, it, expect } from "vitest";
import {
  generateEmbedding,
  generateEmbeddings,
  upsertVector,
  searchVectors,
  deleteVectors,
} from "../vectorize";
import {
  createFakeAi,
  createMemoryVectorizeIndex,
  makeDeterministicEmbedding,
} from "./vectorize-test-helpers";

describe("Workers AI Embeddings", () => {
  it("generateEmbedding returns a 768-dimension vector", async () => {
    const embedding = await generateEmbedding(createFakeAi(), "Hello world");
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(768);
    expect(typeof embedding[0]).toBe("number");
  });

  it("generateEmbeddings returns multiple 768-dimension vectors", async () => {
    const embeddings = await generateEmbeddings(createFakeAi(), [
      "First text",
      "Second text",
    ]);
    expect(embeddings.length).toBe(2);
    expect(embeddings[0].length).toBe(768);
    expect(embeddings[1].length).toBe(768);
  });
});

describe("Vectorize Operations", () => {
  it("upsertVector succeeds without error", async () => {
    const embedding = makeDeterministicEmbedding(
      "How to bake a chocolate cake with frosting"
    );
    const vectorize = createMemoryVectorizeIndex();
    const vectorId = "__test__vec_cake";

    // Verify upsert doesn't throw
    await upsertVector(vectorize, vectorId, embedding, {
      video_id: "__test__vid_cake",
    });
  });

  it("searchVectors returns results from the index", async () => {
    const vectorize = createMemoryVectorizeIndex();
    const embedding = makeDeterministicEmbedding(
      "artificial intelligence and machine learning"
    );
    await upsertVector(vectorize, "__test__vec_ai", embedding);

    const results = await searchVectors(vectorize, embedding, 5);
    expect(Array.isArray(results)).toBe(true);
    for (const result of results) {
      expect(typeof result.id).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("searchVectors returns scores in descending order", async () => {
    const vectorize = createMemoryVectorizeIndex();
    const embeddingA = makeDeterministicEmbedding("how to cook food recipes");
    const embeddingB = makeDeterministicEmbedding("how to fix a leaky faucet");
    await upsertVector(vectorize, "__test__vec_a", embeddingA);
    await upsertVector(vectorize, "__test__vec_b", embeddingB);

    const results = await searchVectors(vectorize, embeddingA, 5);
    if (results.length > 1) {
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    }
  });

  it("deleteVectors removes vectors from the index", async () => {
    const vectorize = createMemoryVectorizeIndex();
    const embedding = makeDeterministicEmbedding(
      "Temporary vector for deletion test"
    );
    const vectorId = "__test__vec_deleteme";

    await upsertVector(vectorize, vectorId, embedding);
    await deleteVectors(vectorize, [vectorId]);

    const results = await searchVectors(vectorize, embedding, 5);
    const match = results.find((r) => r.id === vectorId);
    expect(match).toBeUndefined();
  });
});
