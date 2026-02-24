import { CsvPresetRegistry } from "./registry.js";
import {
  bankStatementPreset,
  krakenLedgerPreset,
  revolutPreset,
  binanceTradePreset,
  coinbaseTransactionsPreset,
  bybitTradePreset,
  bisqPreset,
  bitfinexPreset,
  bitstampPreset,
  bittrexPreset,
  coinlistPreset,
  cryptoComAppPreset,
  cryptoComExchangePreset,
  gateioPreset,
  nexoPreset,
  poloniexPreset,
  yieldAppPreset,
  laBanquePostalePreset,
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
export { setLaBanquePostaleRules } from "./presets/la-banque-postale.js";

let _defaultRegistry: CsvPresetRegistry | null = null;

export function getDefaultPresetRegistry(): CsvPresetRegistry {
  if (_defaultRegistry) return _defaultRegistry;
  const reg = new CsvPresetRegistry();
  reg.register(krakenLedgerPreset);
  reg.register(binanceTradePreset);
  reg.register(coinbaseTransactionsPreset);
  reg.register(bybitTradePreset);
  reg.register(bisqPreset);
  reg.register(bitfinexPreset);
  reg.register(bitstampPreset);
  reg.register(bittrexPreset);
  reg.register(coinlistPreset);
  reg.register(cryptoComAppPreset);
  reg.register(cryptoComExchangePreset);
  reg.register(gateioPreset);
  reg.register(nexoPreset);
  reg.register(poloniexPreset);
  reg.register(yieldAppPreset);
  reg.register(laBanquePostalePreset);
  reg.register(revolutPreset);
  reg.register(bankStatementPreset); // lowest priority (score 40-60)
  _defaultRegistry = reg;
  return reg;
}
