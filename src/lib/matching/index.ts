export type { EntryMovement, MatchCandidate, MergeResult, MergeOptions } from "./types.js";
export { isSuspenseAccount, isFeeAccount } from "./suspense.js";
export { extractMovement, extractAllCandidates } from "./extract.js";
export { findMatches } from "./score.js";
export { mergeMatchedPair, mergeAllMatches } from "./merge.js";
