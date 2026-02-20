import type { Backend } from "../backend.js";

let spamSet = $state<Set<string>>(new Set());

export function getSpamCurrencySet(): Set<string> {
  return spamSet;
}

export async function loadSpamCurrencies(backend: Backend): Promise<void> {
  const codes = await backend.listSpamCurrencies();
  spamSet = new Set(codes);
}

export async function markCurrencySpam(backend: Backend, code: string): Promise<void> {
  await backend.setCurrencySpam(code, true);
  spamSet = new Set([...spamSet, code]);
}

export async function unmarkCurrencySpam(backend: Backend, code: string): Promise<void> {
  await backend.setCurrencySpam(code, false);
  const next = new Set(spamSet);
  next.delete(code);
  spamSet = next;
}

export async function reloadSpamCurrencies(backend: Backend): Promise<void> {
  await loadSpamCurrencies(backend);
}
