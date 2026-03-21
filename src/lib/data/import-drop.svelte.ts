import { toast } from "svelte-sonner";
import { readFileAsText } from "$lib/utils/read-file-text.js";
import { unzipSync, strFromU8 } from "fflate";
import { filterLedgerFiles, resolveIncludes } from "$lib/ledger-include.js";
import { detectImportTarget } from "$lib/import-detect.js";
import { guessFromExtension } from "$lib/import-detect.js";
import { getDefaultPresetRegistry } from "$lib/csv-presets/index.js";
import { detectDelimiter, parseCsv } from "$lib/utils/csv-import.js";

const LEDGER_EXTENSIONS = new Set(["ledger", "beancount", "journal", "hledger", "dat"]);

class ImportDropStore {
    csvOpen = $state(false);
    csvContent = $state("");
    csvFileName = $state("");

    ofxOpen = $state(false);
    ofxContent = $state("");
    ofxFileName = $state("");

    pdfOpen = $state(false);
    pdfFile = $state<File | null>(null);
    pdfFileName = $state("");

    ledgerOpen = $state(false);
    ledgerContent = $state("");
    ledgerFileName = $state("");

    dragCounter = $state(0);
    dragging = $derived(this.dragCounter > 0);

    // Batch queue state
    _queue = $state<File[]>([]);
    _queueIndex = $state(0);
    _queueTotal = $state(0);
    private _advancing = false; // plain boolean — not reactive to avoid effect loops
    private _cancelled = false;
    private _skippedCount = 0;
    batchActive = $derived(this._queueTotal > 1 && this._queueIndex <= this._queueTotal);

    get batchIndex(): number {
        return this._queueIndex;
    }
    get batchTotal(): number {
        return this._queueTotal;
    }

    get anyDialogOpen(): boolean {
        return this.csvOpen || this.ofxOpen || this.pdfOpen || this.ledgerOpen;
    }

    /**
     * Route a single file to the appropriate import dialog.
     * Returns true if a dialog was opened, false if the file was unsupported.
     */
    async routeFile(file: File, silent = false): Promise<boolean> {
        const result = await detectImportTarget(file);
        if (!result) {
            if (!silent) toast.error("Unsupported file format");
            return false;
        }

        switch (result.target) {
            case "csv": {
                const text = result.text ?? (await readFileAsText(file));
                // In batch mode, skip CSVs that don't match any preset
                if (silent) {
                    const delimiter = detectDelimiter(text);
                    const { headers, rows } = parseCsv(text, delimiter);
                    const sampleRows = rows.slice(0, 20);
                    const best = getDefaultPresetRegistry().detectBest(headers, sampleRows);
                    if (!best) {
                        this._skippedCount++;
                        return false;
                    }
                }
                this.csvContent = text;
                this.csvFileName = file.name;
                this.csvOpen = true;
                return true;
            }
            case "ofx":
                this.ofxContent = result.text ?? (await readFileAsText(file));
                this.ofxFileName = file.name;
                this.ofxOpen = true;
                return true;
            case "pdf":
                this.pdfFile = file;
                this.pdfFileName = file.name;
                this.pdfOpen = true;
                return true;
            case "ledger":
                if (result.bytes && file.name.toLowerCase().endsWith(".zip")) {
                    try {
                        const entries = unzipSync(result.bytes);
                        const fileMap = new Map<string, string>();
                        for (const [name, data] of Object.entries(entries)) {
                            fileMap.set(name, strFromU8(data));
                        }
                        const ledgerFiles = filterLedgerFiles(fileMap);
                        if (ledgerFiles.length === 0) {
                            if (!silent) toast.error("No ledger files found in archive");
                            return false;
                        }
                        const parts: string[] = [];
                        for (const [, content] of ledgerFiles) {
                            parts.push(resolveIncludes(content, fileMap));
                        }
                        this.ledgerContent = parts.join("\n\n");
                    } catch (err) {
                        if (!silent) toast.error(`Failed to read zip: ${err}`);
                        return false;
                    }
                } else {
                    this.ledgerContent =
                        result.text ?? (await readFileAsText(file));
                }
                this.ledgerFileName = file.name;
                this.ledgerOpen = true;
                return true;
        }
    }

    /**
     * Expand a zip file into individual files if it contains mixed content.
     * Returns the original file wrapped in an array if all entries are ledger files.
     */
    async expandZip(file: File): Promise<File[]> {
        try {
            const buf = await file.arrayBuffer();
            const entries = unzipSync(new Uint8Array(buf));
            const names = Object.keys(entries).filter(
                (n) => !n.endsWith("/"),
            );
            if (names.length === 0) return [];

            // Check if ALL non-directory entries are ledger files
            const allLedger = names.every((name) => {
                const dot = name.lastIndexOf(".");
                if (dot < 0) return false;
                const ext = name.slice(dot + 1).toLowerCase();
                return LEDGER_EXTENSIONS.has(ext);
            });

            if (allLedger) {
                // Preserve existing merge behavior — return original zip
                return [file];
            }

            // Mixed content — convert each entry to a File
            return names.map((name) => {
                const data = entries[name];
                const baseName = name.includes("/")
                    ? name.slice(name.lastIndexOf("/") + 1)
                    : name;
                return new File([data], baseName);
            });
        } catch (err) {
            toast.error(`Failed to read zip: ${err}`);
            return [];
        }
    }

    /**
     * Main entry point for multi-file import (drop or file picker).
     */
    async routeFiles(files: File[]): Promise<void> {
        // Expand zips with mixed content
        const expanded: File[] = [];
        for (const file of files) {
            if (file.name.toLowerCase().endsWith(".zip")) {
                const inner = await this.expandZip(file);
                expanded.push(...inner);
            } else {
                expanded.push(file);
            }
        }

        if (expanded.length === 0) return;

        // Single file, no dialog open → direct route, no batch overhead
        if (expanded.length === 1 && !this.anyDialogOpen) {
            await this.routeFile(expanded[0]);
            return;
        }

        // Multi-file or dialog already open → enqueue
        if (this._queueTotal > 0) {
            // Append to existing batch
            this._queue = [...this._queue, ...expanded];
            this._queueTotal += expanded.length;
            // advanceQueue will pick these up when current dialog closes
        } else {
            // Start new batch
            this._cancelled = false;
            this._skippedCount = 0;
            this._queue = expanded;
            this._queueTotal = expanded.length;
            this._queueIndex = 0;
            if (!this.anyDialogOpen) {
                this.advanceQueue();
            }
        }
    }

    /**
     * Schedule advanceQueue outside the current $effect to avoid
     * mutating reactive state synchronously inside an effect.
     */
    scheduleAdvance(): void {
        if (this._cancelled) {
            this._queueTotal = 0;
            this._queueIndex = 0;
            this._skippedCount = 0;
            return;
        }
        if (this._queue.length > 0) {
            queueMicrotask(() => {
                if (!this._cancelled) this.advanceQueue();
            });
            return;
        }
        // Queue empty — reset batch state if a batch was active
        if (this._queueTotal > 1) {
            const imported = this._queueIndex - this._skippedCount;
            const parts: string[] = [];
            if (imported > 0) parts.push(`${imported} imported`);
            if (this._skippedCount > 0) parts.push(`${this._skippedCount} skipped`);
            this._queueTotal = 0;
            this._queueIndex = 0;
            this._skippedCount = 0;
            toast.info(`Batch import complete: ${parts.join(", ")}`);
        } else if (this._queueTotal > 0) {
            this._queueTotal = 0;
            this._queueIndex = 0;
            this._skippedCount = 0;
        }
    }

    /**
     * Advance to the next file in the batch queue.
     */
    async advanceQueue(): Promise<void> {
        if (this._advancing) return;
        if (this._cancelled) return;
        this._advancing = true;
        try {
            while (this._queue.length > 0) {
                const next = this._queue[0];
                this._queue = this._queue.slice(1);
                this._queueIndex++;
                // Small delay to let dialog animate out
                await new Promise((r) => setTimeout(r, 100));
                if (this._cancelled) return;
                const opened = await this.routeFile(next, true);
                if (opened) return; // Dialog opened, wait for user
                // Unsupported file — loop to next
            }
            // Queue exhausted without opening a dialog — reset immediately
            if (this._cancelled) return;
            if (this._queueTotal > 1) {
                const imported = this._queueIndex - this._skippedCount;
                const parts: string[] = [];
                if (imported > 0) parts.push(`${imported} imported`);
                if (this._skippedCount > 0) parts.push(`${this._skippedCount} skipped`);
                toast.info(`Batch import complete: ${parts.join(", ")}`);
            }
            this._queueTotal = 0;
            this._queueIndex = 0;
            this._skippedCount = 0;
        } finally {
            this._advancing = false;
        }
    }

    /**
     * Cancel the entire batch, closing any open dialog.
     */
    cancelBatch(): void {
        if (this._cancelled) return;
        const openDialogCount = this.anyDialogOpen ? 1 : 0;
        const remaining = this._queue.length + openDialogCount;
        const imported = this._queueIndex - this._skippedCount - openDialogCount;
        const parts: string[] = [`${remaining} cancelled`];
        if (imported > 0) parts.push(`${imported} imported`);
        if (this._skippedCount > 0) parts.push(`${this._skippedCount} skipped`);
        this._queue = [];
        this._cancelled = true;
        this._skippedCount = 0;
        this._queueTotal = 0;
        this._queueIndex = 0;
        this.closeCurrentDialog();
        toast.info(`Batch import: ${parts.join(", ")}`);
    }

    /**
     * Skip the current file (increments skip counter) then close the dialog.
     */
    skipFile(): void {
        this._skippedCount++;
        this.closeCurrentDialog();
    }

    /**
     * Close the currently open dialog.
     */
    closeCurrentDialog(): void {
        if (this.csvOpen) this.csvOpen = false;
        else if (this.ofxOpen) this.ofxOpen = false;
        else if (this.pdfOpen) this.pdfOpen = false;
        else if (this.ledgerOpen) this.ledgerOpen = false;
    }

    handleDrop(e: DragEvent): void {
        e.preventDefault();
        this.dragCounter = 0;
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        this.routeFiles(Array.from(files));
    }
}

export const importDrop = new ImportDropStore();
