import { toast } from "svelte-sonner";
import { readFileAsText } from "$lib/utils/read-file-text.js";
import { unzipSync, strFromU8 } from "fflate";
import { filterLedgerFiles, resolveIncludes } from "$lib/ledger-include.js";
import { detectImportTarget } from "$lib/import-detect.js";

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

    get anyDialogOpen(): boolean {
        return this.csvOpen || this.ofxOpen || this.pdfOpen || this.ledgerOpen;
    }

    async routeFile(file: File): Promise<void> {
        const result = await detectImportTarget(file);
        if (!result) {
            toast.error("Unsupported file format");
            return;
        }

        switch (result.target) {
            case "csv":
                this.csvContent = result.text ?? (await readFileAsText(file));
                this.csvFileName = file.name;
                this.csvOpen = true;
                break;
            case "ofx":
                this.ofxContent = result.text ?? (await readFileAsText(file));
                this.ofxFileName = file.name;
                this.ofxOpen = true;
                break;
            case "pdf":
                this.pdfFile = file;
                this.pdfFileName = file.name;
                this.pdfOpen = true;
                break;
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
                            toast.error("No ledger files found in archive");
                            return;
                        }
                        const parts: string[] = [];
                        for (const [, content] of ledgerFiles) {
                            parts.push(resolveIncludes(content, fileMap));
                        }
                        this.ledgerContent = parts.join("\n\n");
                    } catch (err) {
                        toast.error(`Failed to read zip: ${err}`);
                        return;
                    }
                } else {
                    this.ledgerContent =
                        result.text ?? (await readFileAsText(file));
                }
                this.ledgerFileName = file.name;
                this.ledgerOpen = true;
                break;
        }
    }

    handleDrop(e: DragEvent): void {
        e.preventDefault();
        this.dragCounter = 0;
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        if (files.length > 1) {
            toast.error("Please drop only one file at a time");
            return;
        }
        this.routeFile(files[0]);
    }
}

export const importDrop = new ImportDropStore();
