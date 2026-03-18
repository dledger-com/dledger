<script lang="ts">
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { getBackend } from "$lib/backend.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { entryInvolvesHidden } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";
  import { templateFromEntry } from "$lib/utils/recurring.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import FlowView from "$lib/components/FlowView.svelte";
  import { parseTags, serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import type { JournalEntry, LineItem } from "$lib/types/index.js";
  import type { AccountType } from "$lib/types/account.js";
  import { invalidate } from "$lib/data/invalidation.js";
  import Pencil from "lucide-svelte/icons/pencil";
  import X from "lucide-svelte/icons/x";
  import ArrowRightLeft from "lucide-svelte/icons/arrow-right-left";
  import TableIcon from "lucide-svelte/icons/table";

  interface Props {
    open: boolean;
    entryId?: string | null;
    onedit?: () => void;
    onsaved?: (newId: string) => void;
    onclose?: () => void;
  }

  let { open = $bindable(), entryId = $bindable(null), onedit, onsaved, onclose }: Props = $props();

  const journalStore = new JournalStore();
  const accountStore = new AccountStore();
  const settings = new SettingsStore();

  // ── Responsive ──
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    isMobile = mq.matches;
    const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  // ── View mode state ──
  let lineItemView = $state<"table" | "flow">(settings.settings.journalLineItemView ?? "flow");
  let entry = $state<JournalEntry | null>(null);
  let viewItems = $state<LineItem[]>([]);
  let viewMetadata = $state<Record<string, string>>({});
  let viewLoading = $state(false);
  let viewEntryLinks = $state<string[]>([]);
  let viewLinkSuggestions = $state<string[]>([]);
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const isHidden = $derived(entryInvolvesHidden(viewItems, hidden));
  const viewTags = $derived(parseTags(viewMetadata[TAGS_META_KEY]));

  function formatMetaKey(key: string): string {
    let display = key
      .replace(/^handler:/, "")
      .replace(/^tx:/, "")
      .replace(/^trade:/, "")
      .replace(/^deposit:/, "")
      .replace(/^withdrawal:/, "")
      .replace(/^ledger:/, "")
      .replace(/^v2:/, "");
    return display.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function truncateAddress(addr: string): string {
    if (addr.length > 16 && addr.startsWith("0x")) {
      return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
    }
    return addr;
  }

  function formatMetaValue(key: string, value: string): string {
    if (key.endsWith("usd_value")) return `$${value}`;
    if (key.endsWith("implied_apy")) return `${value}%`;
    if (key === "tx:from" || key === "tx:to" || key === "tx:hash") return truncateAddress(value);
    if (key === "tx:gas_price_gwei") return `${value} gwei`;
    if (key === "tx:contracts") return value.split(",").map(truncateAddress).join(", ");
    return value;
  }

  function accountName(id: string): string {
    return accountStore.byId.get(id)?.full_name ?? id;
  }

  function accountTypeLookup(id: string): AccountType | undefined {
    return accountStore.byId.get(id)?.account_type;
  }

  async function loadEntry(id: string) {
    viewLoading = true;
    const backend = getBackend();
    const [entryResult, metaResult, linksResult, linkSuggestionsResult] = await Promise.all([
      journalStore.get(id),
      backend.getMetadata(id).catch(() => ({}) as Record<string, string>),
      backend.getEntryLinks(id).catch(() => [] as string[]),
      backend.getAllLinkNames().catch(() => [] as string[]),
    ]);
    if (entryResult) {
      entry = entryResult.entry;
      viewItems = entryResult.items;
    } else {
      entry = null;
      viewItems = [];
    }
    viewMetadata = metaResult;
    viewEntryLinks = linksResult;
    viewLinkSuggestions = linkSuggestionsResult;
    viewLoading = false;
  }

  async function handleViewLinksChange(newLinks: string[]) {
    if (!entryId) return;
    await getBackend().setEntryLinks(entryId, newLinks);
    viewEntryLinks = newLinks;
  }

  async function handleViewTagsChange(newTags: string[]) {
    if (!entryId) return;
    const serialized = serializeTags(newTags);
    await getBackend().setMetadata(entryId, { [TAGS_META_KEY]: serialized });
    viewMetadata = { ...viewMetadata, [TAGS_META_KEY]: serialized };
  }

  async function handleVoid() {
    if (!entry) return;
    const reversal = await journalStore.void_(entry.id);
    if (reversal) {
      toast.success("Entry voided");
      invalidate("journal", "accounts", "reports");
      await loadEntry(entry.id);
    } else {
      toast.error(journalStore.error ?? "Failed to void entry");
    }
  }

  // ── Lifecycle: reload on open/entryId change ──
  let lastLoadedKey = $state("");

  $effect(() => {
    if (!open) return;
    const key = `view:${entryId ?? ""}`;
    if (key === lastLoadedKey) return;
    lastLoadedKey = key;

    accountStore.load();

    if (entryId) {
      loadEntry(entryId);
    }
  });

  // Reset key when drawer closes
  $effect(() => {
    if (!open) lastLoadedKey = "";
  });

  function handleOpenChange(newOpen: boolean) {
    open = newOpen;
    if (!newOpen) onclose?.();
  }
</script>

<Drawer.Root open={open} onOpenChange={handleOpenChange} direction={isMobile ? 'bottom' : 'right'}>
  <Drawer.Content class={isMobile ? '' : 'sm:max-w-xl'}>
    <Drawer.Header class="space-y-1">
      <div class="flex items-center justify-between">
        <Drawer.Title class="text-sm font-medium text-muted-foreground">Entry Details</Drawer.Title>
        <div class="flex items-center gap-1">
          {#if entry && entry.status === "confirmed"}
            <Button variant="outline" size="sm" onclick={() => { onedit?.(); }}>
              <Pencil class="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
          {/if}
          <Button variant="ghost" size="icon" class="h-8 w-8" onclick={() => { onclose?.(); }}>
            <X class="h-4 w-4" />
          </Button>
        </div>
      </div>
      {#if entry}
        <p class="text-base font-semibold leading-snug">{entry.description}</p>
      {/if}
    </Drawer.Header>

    <div class="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
      {#if viewLoading}
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      {:else if !entry}
        <p class="text-sm text-muted-foreground text-center py-8">Entry not found.</p>
      {:else}
        {#if isHidden}
          <div class="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200">
            This entry involves hidden currencies.
          </div>
        {/if}

        <!-- Details -->
        <section>
          <h3 class="text-sm font-medium text-muted-foreground mb-2">Details</h3>
          <dl class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt class="text-muted-foreground">Date</dt>
              <dd class="font-medium">{entry.date}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Status</dt>
              <dd>
                <Badge variant={entry.status === "confirmed" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                  {entry.status}
                </Badge>
              </dd>
            </div>
          </dl>
          <details class="mt-2">
            <summary class="text-xs text-muted-foreground cursor-pointer">More details</summary>
            <dl class="grid grid-cols-2 gap-3 text-sm mt-2">
              <div>
                <dt class="text-muted-foreground">Source</dt>
                <dd class="font-medium">{entry.source}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Created</dt>
                <dd class="font-medium">{entry.created_at}</dd>
              </div>
              {#if viewMetadata["edit:original_id"]}
                <div>
                  <dt class="text-muted-foreground">Edit of</dt>
                  <dd>
                    <button
                      class="text-blue-600 hover:underline dark:text-blue-400 text-left"
                      onclick={() => { entryId = viewMetadata['edit:original_id']; }}
                    >Original entry</button>
                  </dd>
                </div>
              {/if}
              {#if entry.voided_by}
                <div>
                  <dt class="text-muted-foreground">Voided by</dt>
                  <dd>
                    <button
                      class="text-blue-600 hover:underline dark:text-blue-400 text-left"
                      onclick={() => { entryId = entry!.voided_by; }}
                    >Reversal entry</button>
                  </dd>
                </div>
              {/if}
            </dl>
          </details>
        </section>

        <!-- Metadata -->
        {@const displayMeta = Object.entries(viewMetadata).filter(([k]) => k !== TAGS_META_KEY && k !== "links")}
        <section>
            <h3 class="text-sm font-medium text-muted-foreground mb-2">Metadata</h3>
            <div class="space-y-3 text-sm">
              <div class="space-y-2">
                  <div>
                    <dt class="text-muted-foreground">Tags</dt>
                    <dd><TagInput tags={viewTags} onchange={handleViewTagsChange} /></dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Links</dt>
                    <dd><LinkInput links={viewEntryLinks} onchange={handleViewLinksChange} suggestions={viewLinkSuggestions} /></dd>
                  </div>
              </div>
              {#if displayMeta.length > 0}
                <dl class="grid grid-cols-2 gap-3">
                  {#each displayMeta as [key, value]}
                    <div>
                      <dt class="text-muted-foreground">{formatMetaKey(key)}</dt>
                      <dd>
                        {#if key === "handler"}
                          <Badge variant="secondary">{value}</Badge>
                        {:else}
                          <span class="font-medium">{formatMetaValue(key, value)}</span>
                        {/if}
                      </dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </div>
          </section>

        <!-- Line Items -->
        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-medium text-muted-foreground">Line Items</h3>
            <Button
              variant="ghost"
              size="icon"
              class="h-7 w-7"
              title={lineItemView === "table" ? "Switch to flow view" : "Switch to table view"}
              onclick={() => { const v = lineItemView === "table" ? "flow" : "table"; lineItemView = v; settings.update({ journalLineItemView: v }); }}
            >
              {#if lineItemView === "table"}
                <ArrowRightLeft class="h-3.5 w-3.5" />
              {:else}
                <TableIcon class="h-3.5 w-3.5" />
              {/if}
            </Button>
          </div>
          {#if lineItemView === "flow"}
            <FlowView items={viewItems} {accountName} {accountTypeLookup} />
          {:else}
            <div class="border rounded-md overflow-hidden">
              <table class="w-full table-fixed text-sm">
                <thead>
                  <tr class="border-b bg-muted/50">
                    <th class="text-left font-medium px-3 py-2">Account</th>
                    <th class="text-right font-medium px-3 py-2 w-[100px]">Debit</th>
                    <th class="text-right font-medium px-3 py-2 w-[100px]">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {#each viewItems as item (item.id)}
                    {@const amount = parseFloat(item.amount)}
                    <tr class="border-b last:border-b-0">
                      <td class="px-3 py-2">
                        <span class="block break-words" title={accountName(item.account_id)}>{accountName(item.account_id)}</span>
                      </td>
                      <td class="text-right font-mono px-3 py-2 whitespace-nowrap">
                        {amount > 0 ? formatCurrency(amount, item.currency) : ""}
                      </td>
                      <td class="text-right font-mono px-3 py-2 whitespace-nowrap">
                        {amount < 0 ? formatCurrency(Math.abs(amount), item.currency) : ""}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {/if}
    </div>

    {#if entry && entry.status === "confirmed"}
      <Drawer.Footer>
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" onclick={async () => {
            if (!entry) return;
            const template = templateFromEntry(entry, viewItems);
            await getBackend().createRecurringTemplate(template);
            toast.success("Recurring template created");
            open = false;
            goto("/journal/recurring");
          }}>Make Recurring</Button>
          <Button variant="destructive" size="sm" onclick={handleVoid}>Void Entry</Button>
        </div>
      </Drawer.Footer>
    {/if}
  </Drawer.Content>
</Drawer.Root>
