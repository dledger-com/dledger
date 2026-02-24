import type { CsvImportOptions } from "$lib/utils/csv-import.js";

export interface CsvRecord {
  date: string;
  description: string;
  lines: { account: string; currency: string; amount: string }[];
  groupKey?: string;
  sourceKey?: string;
}

export interface CsvPreset {
  id: string;
  name: string;
  description: string;
  detect(headers: string[], sampleRows: string[][]): number; // 0-100
  getDefaultMapping(headers: string[]): Partial<CsvImportOptions>;
  transform(headers: string[], rows: string[][]): CsvRecord[] | null;
}

export interface PresetDetectionResult {
  preset: CsvPreset;
  confidence: number;
}
