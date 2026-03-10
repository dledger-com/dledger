<script lang="ts">
    import { importDrop } from "$lib/data/import-drop.svelte.js";
    import Upload from "lucide-svelte/icons/upload";
</script>

<svelte:window
    ondragenter={(e: DragEvent) => {
        e.preventDefault();
        importDrop.dragCounter++;
    }}
    ondragleave={() => {
        importDrop.dragCounter--;
    }}
    ondragover={(e: DragEvent) => {
        e.preventDefault();
    }}
    ondrop={(e: DragEvent) => {
        importDrop.handleDrop(e);
    }}
/>

{#if importDrop.dragging && !importDrop.anyDialogOpen}
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none"
    >
        <div
            class="absolute inset-4 rounded-xl border-2 border-dashed border-primary"
        ></div>
        <div class="flex flex-col items-center gap-2 text-center">
            <Upload class="h-12 w-12 text-primary" />
            <p class="text-lg font-semibold">Drop files to import</p>
            <p class="text-sm text-muted-foreground">
                CSV, OFX, PDF, Ledger, or ZIP
            </p>
        </div>
    </div>
{/if}
