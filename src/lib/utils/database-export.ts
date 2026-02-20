import type { Backend } from "$lib/backend.js";

export function downloadDatabase(data: Uint8Array, filename?: string): void {
  const name = filename ?? `dledger-backup-${new Date().toISOString().slice(0, 10)}.db`;
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function exportDatabaseBackup(backend: Backend): Promise<Uint8Array> {
  if (!backend.exportDatabase) {
    throw new Error("Database export is not supported by this backend");
  }
  return backend.exportDatabase();
}

export async function importDatabaseBackup(backend: Backend, data: Uint8Array): Promise<void> {
  if (!backend.importDatabase) {
    throw new Error("Database import is not supported by this backend");
  }
  await backend.importDatabase(data);
}
