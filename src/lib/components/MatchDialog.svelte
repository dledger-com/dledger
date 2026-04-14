<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import Loader from "lucide-svelte/icons/loader";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import type { MatchCandidate, MergeResult } from "$lib/matching/types.js";
  import { mergeMatchedPair, mergeAllMatches } from "$lib/matching/merge.js";
  import type { Account } from "$lib/types/index.js";

  interface Props {
    open: boolean;
    matches: MatchCandidate[];
    accountMap: Map<string, Account>;
    onMerged?: () => void;
    onViewEntry?: (entryId: string) => void;
  }

  let { open = $bindable(), matches, accountMap, onMerged, onViewEntry }: Props = $props();

  let mergingId = $state<string | null>(null);
  let mergingAll = $state(false);
  let mergedIds = $state(new Set<string>());
  let skippedIds = $state(new Set<string>());
  let skippedExpanded = $state(false);

  const pendingMatches = $derived(
    matches.filter(
      (m) => !mergedIds.has(m.movementA.entry.id) && !skippedIds.has(m.movementA.entry.id),
    ),
  );

  const skippedMatches = $derived(
    matches.filter((m) => skippedIds.has(m.movementA.entry.id)),
  );

  const highConfidenceCount = $derived(
    pendingMatches.filter((m) => m.confidence === "high").length,
  );

  async function handleMergeSingle(match: MatchCandidate) {
    mergingId = match.movementA.entry.id;
    try {
      const backend = getBackend();
      const { warning } = await mergeMatchedPair(backend, match, accountMap);
      mergedIds = new Set([...mergedIds, match.movementA.entry.id]);
      if (warning) toast.warning(warning);
      else toast.success("Entry merged");
      onMerged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      mergingId = null;
    }
  }

  async function handleSkip(match: MatchCandidate) {
    try {
      const backend = getBackend();
      await backend.setMetadata(match.movementA.entry.id, { cross_match_skipped: "true" });
      await backend.setMetadata(match.movementB.entry.id, { cross_match_skipped: "true" });
      skippedIds = new Set([...skippedIds, match.movementA.entry.id]);
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleUnskip(match: MatchCandidate) {
    try {
      const backend = getBackend();
      await backend.setMetadata(match.movementA.entry.id, { cross_match_skipped: "" });
      await backend.setMetadata(match.movementB.entry.id, { cross_match_skipped: "" });
      const next = new Set(skippedIds);
      next.delete(match.movementA.entry.id);
      skippedIds = next;
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleMergeAllHigh() {
    mergingAll = true;
    try {
      const backend = getBackend();
      const highMatches = pendingMatches.filter((m) => m.confidence === "high");
      const result: MergeResult = await mergeAllMatches(backend, highMatches, accountMap);
      const ids = new Set(mergedIds);
      for (const m of highMatches) ids.add(m.movementA.entry.id);
      mergedIds = ids;

      if (result.warnings.length > 0) {
        toast.warning(`Merged ${result.matched}, ${result.warnings.length} warning(s)`);
      } else {
        toast.success(`Merged ${result.matched} entries`);
      }
      onMerged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      mergingAll = false;
    }
  }

  function confidenceVariant(c: string): "default" | "secondary" | "destructive" | "outline" {
    if (c === "high") return "default";
    if (c === "medium") return "secondary";
    return "outline";
  }

  function resetState() {
    mergedIds = new Set();
    mergingId = null;
    mergingAll = false;
    skippedExpanded = false;
  }
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) resetState(); }}>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Cross-Source Transaction Matching</Dialog.Title>
      <Dialog.Description>
        Entries from different sources that may represent the same transfer.
      </Dialog.Description>
    </Dialog.Header>

    {#if matches.length === 0}
      <p class="text-sm text-muted-foreground py-8 text-center">
        No potential matches found.
      </p>
    {:else}
      {#if highConfidenceCount > 0}
        <div class="flex justify-end mb-3">
          <Button
            variant="default"
            size="sm"
            disabled={mergingAll || mergingId !== null}
            onclick={handleMergeAllHigh}
          >
            {#if mergingAll}
              <Loader class="h-3.5 w-3.5 mr-1 animate-spin" />
            {/if}
            Merge All High-Confidence ({highConfidenceCount})
          </Button>
        </div>
      {/if}

      <div class="space-y-4">
        {#each pendingMatches as match (match.movementA.entry.id + match.movementB.entry.id)}
          {@const isMerging = mergingId === match.movementA.entry.id}
          <div class="rounded-md border p-3 space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
              <Badge variant={confidenceVariant(match.confidence)}>
                {match.confidence} ({match.score})
              </Badge>
              <span class="text-xs text-muted-foreground">
                {match.matchedCurrency}
                {#if match.amountDifferencePercent > 0}
                  &middot; {match.amountDifferencePercent}% diff
                {/if}
                {#if match.dateDifferenceDays > 0}
                  &middot; {match.dateDifferenceDays}d apart
                {/if}
              </span>
            </div>

            <!-- Side A -->
            <div class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30">
              <div class="flex items-center gap-3">
                <span class="text-muted-foreground w-24">{match.movementA.entry.date}</span>
                {#if onViewEntry}
                  <button type="button" class="hover:underline truncate max-w-[300px] bg-transparent border-0 p-0 text-left cursor-pointer" title={match.movementA.entry.description} onclick={() => onViewEntry?.(match.movementA.entry.id)}>
                    {match.movementA.entry.description}
                  </button>
                {:else}
                  <a href="/journal/{match.movementA.entry.id}" class="hover:underline truncate max-w-[300px]" title={match.movementA.entry.description}>
                    {match.movementA.entry.description}
                  </a>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                <span class="font-mono text-xs">{formatCurrency(match.movementA.amount, match.matchedCurrency)}</span>
                <Badge variant="outline" class="text-xs">{match.movementA.realAccountName.split(":").slice(-2).join(":")}</Badge>
              </div>
            </div>

            <!-- Side B -->
            <div class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30">
              <div class="flex items-center gap-3">
                <span class="text-muted-foreground w-24">{match.movementB.entry.date}</span>
                {#if onViewEntry}
                  <button type="button" class="hover:underline truncate max-w-[300px] bg-transparent border-0 p-0 text-left cursor-pointer" title={match.movementB.entry.description} onclick={() => onViewEntry?.(match.movementB.entry.id)}>
                    {match.movementB.entry.description}
                  </button>
                {:else}
                  <a href="/journal/{match.movementB.entry.id}" class="hover:underline truncate max-w-[300px]" title={match.movementB.entry.description}>
                    {match.movementB.entry.description}
                  </a>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                <span class="font-mono text-xs">{formatCurrency(match.movementB.amount, match.matchedCurrency)}</span>
                <Badge variant="outline" class="text-xs">{match.movementB.realAccountName.split(":").slice(-2).join(":")}</Badge>
              </div>
            </div>

            <!-- Proposed merge preview -->
            <div class="text-xs text-muted-foreground px-2">
              Merge: {match.movementA.realAccountName} &rarr; {match.movementB.realAccountName}
            </div>

            <!-- Actions -->
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => handleSkip(match)} disabled={isMerging}>
                Skip
              </Button>
              <Button variant="default" size="sm" class="h-7 text-xs" onclick={() => handleMergeSingle(match)} disabled={isMerging || mergingAll}>
                {#if isMerging}
                  <Loader class="h-3 w-3 mr-1 animate-spin" />
                {/if}
                Merge
              </Button>
            </div>
          </div>
        {/each}
      </div>

      {#if pendingMatches.length === 0 && matches.length > 0 && skippedMatches.length === 0}
        <p class="text-sm text-muted-foreground py-4 text-center">
          All matches have been processed.
        </p>
      {/if}

      {#if skippedMatches.length > 0}
        <div class="mt-4 border-t pt-3">
          <button
            class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            onclick={() => (skippedExpanded = !skippedExpanded)}
          >
            {#if skippedExpanded}
              <ChevronDown class="h-4 w-4" />
            {:else}
              <ChevronRight class="h-4 w-4" />
            {/if}
            Skipped ({skippedMatches.length})
          </button>

          {#if skippedExpanded}
            <div class="space-y-3 mt-3">
              {#each skippedMatches as match (match.movementA.entry.id + match.movementB.entry.id)}
                <div class="rounded-md border border-dashed p-3 space-y-2 opacity-70">
                  <div class="flex items-center gap-2 flex-wrap">
                    <Badge variant={confidenceVariant(match.confidence)}>
                      {match.confidence} ({match.score})
                    </Badge>
                    <span class="text-xs text-muted-foreground">
                      {match.matchedCurrency}
                    </span>
                  </div>

                  <div class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30">
                    <div class="flex items-center gap-3">
                      <span class="text-muted-foreground w-24">{match.movementA.entry.date}</span>
                      <span class="truncate max-w-[300px]">{match.movementA.entry.description}</span>
                    </div>
                    <span class="font-mono text-xs">{formatCurrency(match.movementA.amount, match.matchedCurrency)}</span>
                  </div>

                  <div class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30">
                    <div class="flex items-center gap-3">
                      <span class="text-muted-foreground w-24">{match.movementB.entry.date}</span>
                      <span class="truncate max-w-[300px]">{match.movementB.entry.description}</span>
                    </div>
                    <span class="font-mono text-xs">{formatCurrency(match.movementB.amount, match.matchedCurrency)}</span>
                  </div>

                  <div class="flex justify-end">
                    <Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => handleUnskip(match)}>
                      Unskip
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
