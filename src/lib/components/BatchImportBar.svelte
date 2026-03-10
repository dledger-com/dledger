<script lang="ts">
    import { importDrop } from "$lib/data/import-drop.svelte.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import FileStack from "lucide-svelte/icons/file-stack";
    import SkipForward from "lucide-svelte/icons/skip-forward";
    import XCircle from "lucide-svelte/icons/x-circle";
</script>

{#if importDrop.batchActive}
    <div
        class="fixed top-0 left-0 right-0 z-[60] flex items-center justify-center p-2 pointer-events-none"
    >
        <div
            class="flex items-center gap-3 rounded-full bg-background/95 backdrop-blur-sm border shadow-lg px-4 py-2 pointer-events-auto"
        >
            <FileStack class="h-4 w-4 text-muted-foreground shrink-0" />
            <span class="text-sm font-medium">
                File {importDrop.batchIndex} of {importDrop.batchTotal}
            </span>
            <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                onpointerdown={(e: PointerEvent) => {
                    e.stopPropagation();
                    importDrop.skipFile();
                }}
            >
                <SkipForward class="mr-1 h-3 w-3" /> Skip
            </Button>
            <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onpointerdown={(e: PointerEvent) => {
                    e.stopPropagation();
                    importDrop.cancelBatch();
                }}
            >
                <XCircle class="mr-1 h-3 w-3" /> Cancel All
            </Button>
        </div>
    </div>
{/if}
