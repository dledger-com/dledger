import type { QifProfileExtension } from "./types.js";
import type { QifParseResult } from "../qif/parse-qif.js";

export interface QifProfileDetectionResult {
  profile: QifProfileExtension;
  confidence: number;
}

export class QifProfileRegistry {
  private profiles: QifProfileExtension[] = [];

  register(profile: QifProfileExtension): void {
    this.profiles.push(profile);
  }

  getAll(): QifProfileExtension[] {
    return [...this.profiles];
  }

  getById(id: string): QifProfileExtension | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  /**
   * Detect the best profile for the given filename and/or parsed QIF content.
   * Combines filename and content scores, returns the highest.
   */
  detectBest(filename: string, result: QifParseResult): QifProfileDetectionResult | null {
    let best: QifProfileDetectionResult | null = null;
    for (const profile of this.profiles) {
      const fnScore = profile.detectFilename?.(filename) ?? 0;
      const contentScore = profile.detectContent?.(result) ?? 0;
      const confidence = Math.max(fnScore, contentScore);
      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = { profile, confidence };
      }
    }
    return best;
  }
}
