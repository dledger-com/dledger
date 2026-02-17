export interface Extension {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: "source" | "handler";
  enabled: boolean;
  capabilities: {
    ledger_read: boolean;
    ledger_write: boolean;
    http: boolean;
    allowed_domains: string[];
  };
}

export interface ExtensionConfig {
  extension_id: string;
  config: Record<string, unknown>;
}

export interface ConfigField {
  key: string;
  label: string;
  field_type: string;
  required: boolean;
  default_value: string;
  description: string;
  options: string;
}

export interface CsvImportParams {
  csvData: string;
  account: string;
  contraAccount: string;
  currency: string;
  dateColumn: number;
  descriptionColumn: number;
  amountColumn: number;
  dateFormat: string;
  skipHeader: boolean;
  delimiter: string;
}
