import type { Backend } from "../backend.js";

let hiddenSet = $state<Set<string>>(new Set());

export function getHiddenCurrencySet(): Set<string> {
  return hiddenSet;
}

export async function loadHiddenCurrencies(backend: Backend): Promise<void> {
  const codes = await backend.listHiddenCurrencies();
  hiddenSet = new Set(codes);
}

export async function markCurrencyHidden(backend: Backend, code: string): Promise<void> {
  await backend.setCurrencyHidden(code, true);
  hiddenSet = new Set([...hiddenSet, code]);
}

export async function unmarkCurrencyHidden(backend: Backend, code: string): Promise<void> {
  await backend.setCurrencyHidden(code, false);
  const next = new Set(hiddenSet);
  next.delete(code);
  hiddenSet = next;
}

export async function reloadHiddenCurrencies(backend: Backend): Promise<void> {
  await loadHiddenCurrencies(backend);
}
