<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import type { ReinterpretCandidate } from "$lib/reinterpret.js";
    import { applyReinterpret } from "$lib/reinterpret.js";
    import { getBackend } from "$lib/backend.js";
    import { invalidate } from "$lib/data/invalidation.js";
    import { toast } from "svelte-sonner";
    import ArrowRight from "lucide-svelte/icons/arrow-right";
    import Loader from "lucide-svelte/icons/loader";

    interface Props {
        open: boolean;
        candidates: ReinterpretCandidate[];
        onApplied?: () => void;
    }

    let { open = $bindable(), candidates, onApplied }: Props = $props();

    let applying = $state(false);
    let progress = $state(0);

    async function handleApply() {
        applying = true;
        progress = 0;
        try {
            const result = await applyReinterpret(
                getBackend(),
                candidates,
                {
                    onProgress: (current, total) => {
                        progress = total > 0 ? Math.round((current / total) * 100) : 0;
                    },
                },
            );
            if (result.errors.length > 0) {
                toast.warning(`Reinterpreted ${result.applied} entries, ${result.errors.length} errors`);
            } else {
                toast.success(`Reinterpreted ${result.applied} entries`);
            }
            invalidate("journal", "accounts", "reports");
            open = false;
            onApplied?.();
        } catch (e) {
            toast.error(String(e));
        } finally {
            applying = false;
        }
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
        <Dialog.Header>
            <Dialog.Title>Reinterpret {candidates.length} transaction{candidates.length === 1 ? '' : 's'}</Dialog.Title>
            <Dialog.Description>
                The following entries will have their suspense accounts replaced based on categorization rules.
            </Dialog.Description>
        </Dialog.Header>

        <div class="max-h-[60vh] overflow-y-auto space-y-1 my-4">
            {#each candidates as c}
                <div class="flex items-center gap-3 text-sm rounded px-3 py-2 bg-muted/30">
                    <span class="text-muted-foreground w-24 shrink-0">{c.entry.date}</span>
                    <span class="truncate flex-1 min-w-0">{c.entry.description}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline" class="font-mono text-xs">{c.oldAccountName.split(':').pop()}</Badge>
                        <ArrowRight class="h-3 w-3 text-muted-foreground" />
                        <Badge variant="secondary" class="font-mono text-xs">{c.newAccountName.split(':').pop()}</Badge>
                    </div>
                </div>
            {/each}
        </div>

        <Dialog.Footer>
            {#if applying}
                <div class="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
                    <Loader class="h-4 w-4 animate-spin" />
                    <span>{progress}%</span>
                </div>
            {/if}
            <Button variant="outline" onclick={() => open = false} disabled={applying}>Cancel</Button>
            <Button onclick={handleApply} disabled={applying}>
                {applying ? 'Applying...' : 'Apply'}
            </Button>
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
