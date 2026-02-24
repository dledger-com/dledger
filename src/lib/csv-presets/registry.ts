import type { CsvPreset, PresetDetectionResult } from "./types.js";

export class CsvPresetRegistry {
  private presets: CsvPreset[] = [];

  register(preset: CsvPreset): void {
    this.presets.push(preset);
  }

  getAll(): CsvPreset[] {
    return [...this.presets];
  }

  getById(id: string): CsvPreset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  detectAll(headers: string[], sampleRows: string[][]): PresetDetectionResult[] {
    const results: PresetDetectionResult[] = [];
    for (const preset of this.presets) {
      const confidence = preset.detect(headers, sampleRows);
      if (confidence > 0) {
        results.push({ preset, confidence });
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  detectBest(
    headers: string[],
    sampleRows: string[][],
    threshold = 50,
  ): PresetDetectionResult | null {
    const all = this.detectAll(headers, sampleRows);
    return all.length > 0 && all[0].confidence >= threshold ? all[0] : null;
  }
}
