/**
 * Cosine similarity utilities for embedding-based classification.
 * Designed to run inside a Web Worker alongside Transformers.js.
 */

/** Compute cosine similarity between two vectors of equal length. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("Vectors must have equal length");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the nearest candidates to `query` by cosine similarity.
 * Returns up to `topK` results sorted by score descending.
 */
export function findNearest(
  query: Float32Array,
  candidates: Float32Array[],
  topK = 5,
): { index: number; score: number }[] {
  const scored = candidates.map((c, index) => ({
    index,
    score: cosineSimilarity(query, c),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
