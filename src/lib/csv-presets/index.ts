import { getPluginManager } from "../plugins/manager.js";
import type { CsvPresetRegistry } from "./registry.js";

export { CsvPresetRegistry } from "./registry.js";
export { parseDate, detectDateFormat, DATE_FORMATS, type DateFormatId } from "./parse-date.js";
export { parseAmount, detectNumberFormat } from "./parse-amount.js";
export { detectColumns, type ColumnDetection } from "./detect.js";
export { matchRule, applyRuleTags, type CsvCategorizationRule } from "./categorize.js";
export { transformGeneric, importRecords, enqueueRecordImport, type TransformOptions, type TransformResult, type ImportOptions } from "./transform.js";
export { buildDedupIndex, markDuplicates, computeRecordFingerprint, type DedupIndex } from "./dedup.js";
export type { CsvPreset, CsvRecord, CsvFileHeader, PresetDetectionResult } from "./types.js";
export { setBankStatementRules } from "./presets/bank-statement.js";
export { setRevolutRules } from "./presets/revolut.js";
export { setLaBanquePostaleRules } from "./presets/la-banque-postale.js";
export { setN26Rules } from "./presets/n26.js";
export { setWiseRules } from "./presets/wise.js";

/**
 * Get the default CSV preset registry backed by the PluginManager.
 */
export function getDefaultPresetRegistry(): CsvPresetRegistry {
  return getPluginManager().csvPresets;
}
