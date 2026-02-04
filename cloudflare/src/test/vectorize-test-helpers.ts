import type { AiLike, VectorizeIndexLike } from "../vectorize";

const VECTOR_DIMENSIONS = 768;

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextSeed(seed: number): number {
  return (seed * 1664525 + 1013904223) >>> 0;
}

function normalize(vector: number[]): number[] {
  let sumSq = 0;
  for (const value of vector) {
    sumSq += value * value;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return vector.map((value) => value / norm);
}

export function makeDeterministicEmbedding(text: string): number[] {
  let seed = hashString(text);
  const values = new Array<number>(VECTOR_DIMENSIONS);

  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    seed = nextSeed(seed);
    values[i] = (seed % 1000) / 1000;
  }

  return normalize(values);
}

export function createFakeAi(): AiLike {
  const run = async (_model: string, inputs: { text: string[] }) => {
    const data = inputs.text.map((text) => makeDeterministicEmbedding(text));
    return { data };
  };

  return { run } as AiLike;
}

type StoredVector = {
  id: string;
  values: number[];
  metadata?: Record<string, VectorizeVectorMetadata>;
};

export function createMemoryVectorizeIndex(): VectorizeIndexLike & { clear: () => void } {
  const store = new Map<string, StoredVector>();

  const upsert = async (vectors: VectorizeVector[]) => {
    for (const vector of vectors) {
      const values = Array.isArray(vector.values)
        ? vector.values
        : Array.from(vector.values);
      store.set(vector.id, {
        id: vector.id,
        values,
        metadata: vector.metadata,
      });
    }
    return { ids: vectors.map((v) => v.id), count: vectors.length };
  };

  const query = async (
    queryVector: VectorFloatArray | number[],
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches> => {
    const limit = options?.topK ?? 5;
    const queryValues = normalize(
      Array.isArray(queryVector) ? queryVector : Array.from(queryVector)
    );

    const matches = Array.from(store.values()).map((entry) => {
      let score = 0;
      for (let i = 0; i < entry.values.length; i++) {
        score += entry.values[i] * queryValues[i];
      }
      return { id: entry.id, score };
    });

    matches.sort((a, b) => b.score - a.score);
    const sliced = matches.slice(0, limit);
    return { matches: sliced, count: sliced.length };
  };

  const deleteByIds = async (ids: string[]) => {
    for (const id of ids) {
      store.delete(id);
    }
    return { ids, count: ids.length };
  };

  const clear = () => {
    store.clear();
  };

  return { upsert, query, deleteByIds, clear };
}

export function createVectorizeModuleMock() {
  const index = createMemoryVectorizeIndex();

  return {
    __resetVectorizeMock: () => {
      index.clear();
    },
    generateEmbedding: async (_ai: AiLike, text: string) => {
      return makeDeterministicEmbedding(text);
    },
    generateEmbeddings: async (_ai: AiLike, texts: string[]) => {
      return texts.map((text) => makeDeterministicEmbedding(text));
    },
    upsertVector: async (
      _vectorize: VectorizeIndexLike,
      id: string,
      embedding: number[],
      metadata?: Record<string, string>
    ) => {
      await index.upsert([{ id, values: embedding, metadata }]);
    },
    upsertVectors: async (
      _vectorize: VectorizeIndexLike,
      vectors: Array<{ id: string; embedding: number[]; metadata?: Record<string, string> }>
    ) => {
      await index.upsert(
        vectors.map((vector) => ({
          id: vector.id,
          values: vector.embedding,
          metadata: vector.metadata,
        }))
      );
    },
    searchVectors: async (
      _vectorize: VectorizeIndexLike,
      queryEmbedding: number[],
      limit: number
    ) => {
      const results = await index.query(queryEmbedding, {
        topK: limit,
        returnMetadata: "none",
      });
      return results.matches.map((match) => ({
        id: match.id,
        score: match.score,
      }));
    },
    deleteVectors: async (_vectorize: VectorizeIndexLike, ids: string[]) => {
      await index.deleteByIds(ids);
    },
  };
}
