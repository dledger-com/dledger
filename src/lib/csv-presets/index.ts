import { CsvPresetRegistry } from "./registry.js";
import {
  bankStatementPreset,
  krakenLedgerPreset,
  revolutPreset,
  binanceTradePreset,
  coinbaseTransactionsPreset,
  bybitTradePreset,
} from "./presets/index.js";

export { CsvPresetRegistry } from "./registry.js";
export { parseDate, detectDateFormat, DATE_FORMATS, type DateFormatId } from "./parse-date.js";
export { parseAmount, detectNumberFormat } from "./parse-amount.js";
export { detectColumns, type ColumnDetection } from "./detect.js";
export { matchRule, type CsvCategorizationRule } from "./categorize.js";
export { transformGeneric, importRecords, type TransformOptions, type TransformResult } from "./transform.js";
export type { CsvPreset, CsvRecord, PresetDetectionResult } from "./types.js";
export { setBankStatementRules } from "./presets/bank-statement.js";
export { setRevolutRules } from "./presets/revolut.js";

let _defaultRegistry: CsvPresetRegistry | null = null;

export function getDefaultPresetRegistry(): CsvPresetRegistry {
  if (_defaultRegistry) return _defaultRegistry;
  const reg = new CsvPresetRegistry();
  reg.register(krakenLedgerPreset);
  reg.register(binanceTradePreset);
  reg.register(coinbaseTransactionsPreset);
  reg.register(bybitTradePreset);
  reg.register(revolutPreset);
  reg.register(bankStatementPreset); // lowest priority (score 40-60)
  _defaultRegistry = reg;
  return reg;
}
