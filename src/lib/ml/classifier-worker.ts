/**
 * Web Worker for ML-based transaction classification.
 *
 * Runs Transformers.js in a separate thread to avoid blocking the UI.
 * Handles model loading, embedding generation, and zero-shot classification.
 */

import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
  type ZeroShotClassificationPipeline,
} from "@huggingface/transformers";
import { cosineSimilarity, findNearest } from "./cosine.js";

// Configure Transformers.js for browser usage
env.allowRemoteModels = true;
env.useBrowserCache = true;

let embedder: FeatureExtractionPipeline | null = null;
let zeroShot: ZeroShotClassificationPipeline | null = null;

/** Message types sent to the worker */
interface InitMessage {
  type: "init";
  id: string;
  payload: { loadZeroShot?: boolean };
}

interface ClassifyBatchMessage {
  type: "classify-batch";
  id: string;
  payload: {
    descriptions: string[];
    accounts: string[];
    threshold: number;
    zeroShotTopN: number;
  };
}

interface DisposeMessage {
  type: "dispose";
  id: string;
}

type WorkerMessage = InitMessage | ClassifyBatchMessage | DisposeMessage;

/** Result for a single classified description */
interface ClassifyResult {
  account: string;
  confidence: number;
  method: "embedding" | "zero-shot";
}

function postProgress(id: string, current: number, total: number, message?: string) {
  self.postMessage({ type: "progress", id, progress: { current, total, message } });
}

function postResult(id: string, data: unknown) {
  self.postMessage({ type: "result", id, data });
}

function postError(id: string, error: string) {
  self.postMessage({ type: "error", id, error });
}

async function handleInit(msg: InitMessage) {
  const { loadZeroShot } = msg.payload;

  try {
    postProgress(msg.id, 0, loadZeroShot ? 2 : 1, "Loading embedding model...");

    const embeddingProgressCb = (progress: { status: string; progress?: number }) => {
      if (progress.status === "progress" && progress.progress !== undefined) {
        postProgress(msg.id, Math.round(progress.progress), 100, "Downloading embedding model...");
      }
    };
    // @ts-expect-error — pipeline() overload union is too complex for TS; result is cast explicitly
    embedder = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      progress_callback: embeddingProgressCb,
    })) as FeatureExtractionPipeline;

    if (loadZeroShot) {
      postProgress(msg.id, 1, 2, "Loading zero-shot model...");

      const zsProgressCb = (progress: { status: string; progress?: number }) => {
        if (progress.status === "progress" && progress.progress !== undefined) {
          postProgress(msg.id, Math.round(progress.progress), 100, "Downloading zero-shot model...");
        }
      };
      zeroShot = (await pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-xsmall", {
        progress_callback: zsProgressCb,
      })) as ZeroShotClassificationPipeline;
    }

    postResult(msg.id, { ready: true });
  } catch (err) {
    postError(msg.id, err instanceof Error ? err.message : String(err));
  }
}

/** Embed a list of texts using the embedding model. */
async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!embedder) throw new Error("Embedding model not loaded");

  const results: Float32Array[] = [];
  // Process in batches of 32 to avoid memory issues
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await embedder(batch, { pooling: "mean", normalize: true });
    // output.tolist() returns number[][] — convert to Float32Array[]
    const list = output.tolist() as number[][];
    for (const vec of list) {
      results.push(new Float32Array(vec));
    }
  }
  return results;
}

async function handleClassifyBatch(msg: ClassifyBatchMessage) {
  const { descriptions, accounts, threshold, zeroShotTopN } = msg.payload;

  if (!embedder) {
    postError(msg.id, "Embedding model not loaded — call init first");
    return;
  }

  try {
    const total = descriptions.length;
    postProgress(msg.id, 0, total, "Embedding accounts...");

    // Embed all account names once
    // Use the leaf name for better semantic matching (e.g., "Groceries" from "Expenses:Groceries")
    const accountLabels = accounts.map((a) => {
      const parts = a.split(":");
      return parts[parts.length - 1];
    });
    const accountEmbeddings = await embedTexts(accountLabels);

    const results: ClassifyResult[] = [];

    // Classify each description
    for (let i = 0; i < descriptions.length; i++) {
      postProgress(msg.id, i, total, `Classifying ${i + 1}/${total}...`);

      const desc = descriptions[i];
      const [descEmbedding] = await embedTexts([desc]);

      // Find nearest account by cosine similarity
      const nearest = findNearest(descEmbedding, accountEmbeddings, zeroShotTopN);
      const bestMatch = nearest[0];

      if (bestMatch && bestMatch.score >= threshold) {
        results.push({
          account: accounts[bestMatch.index],
          confidence: bestMatch.score,
          method: "embedding",
        });
      } else if (zeroShot && nearest.length > 0) {
        // Try zero-shot with top-N candidate accounts
        const candidateAccounts = nearest.map((n) => accounts[n.index]);
        const candidateLabels = nearest.map((n) => accountLabels[n.index]);

        try {
          const zsResult = await zeroShot(desc, candidateLabels, {
            multi_label: false,
          });

          // zsResult can be a single result object
          const zsData = zsResult as { labels: string[]; scores: number[] };
          if (zsData.labels && zsData.scores && zsData.scores[0] >= threshold) {
            const bestLabel = zsData.labels[0];
            const labelIdx = candidateLabels.indexOf(bestLabel);
            results.push({
              account: labelIdx >= 0 ? candidateAccounts[labelIdx] : candidateAccounts[0],
              confidence: zsData.scores[0],
              method: "zero-shot",
            });
          } else {
            // Below threshold even with zero-shot
            results.push({
              account: accounts[bestMatch.index],
              confidence: bestMatch.score,
              method: "embedding",
            });
          }
        } catch {
          // Zero-shot failed — fall back to embedding result
          results.push({
            account: accounts[bestMatch.index],
            confidence: bestMatch.score,
            method: "embedding",
          });
        }
      } else {
        // No match at all (shouldn't happen if accounts is non-empty)
        results.push({
          account: "",
          confidence: 0,
          method: "embedding",
        });
      }
    }

    postProgress(msg.id, total, total, "Classification complete");
    postResult(msg.id, results);
  } catch (err) {
    postError(msg.id, err instanceof Error ? err.message : String(err));
  }
}

function handleDispose(msg: DisposeMessage) {
  embedder = null;
  zeroShot = null;
  postResult(msg.id, { disposed: true });
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      await handleInit(msg);
      break;
    case "classify-batch":
      await handleClassifyBatch(msg);
      break;
    case "dispose":
      handleDispose(msg);
      break;
  }
};
