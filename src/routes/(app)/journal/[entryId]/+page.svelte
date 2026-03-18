<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { getBackend } from "$lib/backend.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrencyFull } from "$lib/utils/format.js";
  import { entryInvolvesHidden } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";
  import { templateFromEntry } from "$lib/utils/recurring.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import { parseTags, serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import type { JournalEntry, LineItem } from "$lib/types/index.js";
  import { setBreadcrumbOverride, clearBreadcrumbOverride } from "$lib/data/breadcrumb.svelte.js";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";

  const journalStore = new JournalStore();
  const accountStore = new AccountStore();
  const settings = new SettingsStore();

  const entryId = $derived(page.params.entryId);
  let entry = $state<JournalEntry | null>(null);
  let items = $state<LineItem[]>([]);
  let metadata = $state<Record<string, string>>({});
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const isHidden = $derived(entryInvolvesHidden(items, hidden));
  const tags = $derived(parseTags(metadata[TAGS_META_KEY]));
  let entryLinks = $state<string[]>([]);
  let linkSuggestions = $state<string[]>([]);

  async function handleLinksChange(newLinks: string[]) {
    const id = entryId;
    if (!id) return;
    await getBackend().setEntryLinks(id, newLinks);
    entryLinks = newLinks;
  }

  async function handleTagsChange(newTags: string[]) {
    const id = entryId;
    if (!id) return;
    const serialized = serializeTags(newTags);
    await getBackend().setMetadata(id, { [TAGS_META_KEY]: serialized });
    metadata = { ...metadata, [TAGS_META_KEY]: serialized };
  }
  let loading = $state(true);

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

  async function loadEntry() {
    loading = true;
    const id = entryId;
    if (!id) { loading = false; return; }
    const backend = getBackend();
    const [entryResult, metaResult, linksResult, linkSuggestionsResult] = await Promise.all([
      journalStore.get(id),
      backend.getMetadata(id).catch(() => ({}) as Record<string, string>),
      backend.getEntryLinks(id).catch(() => [] as string[]),
      backend.getAllLinkNames().catch(() => [] as string[]),
    ]);
    if (entryResult) {
      entry = entryResult.entry;
      items = entryResult.items;
      const desc = entry.description;
      const label = desc
        ? desc.length > 40 ? desc.slice(0, 40) + "..." : desc
        : "Entry " + id.slice(0, 8);
      setBreadcrumbOverride(id, label);
    }
    metadata = metaResult;
    entryLinks = linksResult;
    linkSuggestions = linkSuggestionsResult;
    loading = false;
  }

  async function handleVoid() {
    if (!entry) return;
    const reversal = await journalStore.void_(entry.id);
    if (reversal) {
      toast.success("Entry voided");
      await loadEntry();
    } else {
      toast.error(journalStore.error ?? "Failed to void entry");
    }
  }

  function accountName(id: string): string {
    return accountStore.byId.get(id)?.full_name ?? id;
  }

  onMount(async () => {
    await Promise.all([
      accountStore.load(),
      loadEntry(),
    ]);
  });

  $effect(() => {
    if (entry && entry.status === "confirmed") {
      setTopBarActions([
        { type: 'button', label: 'Edit Entry', href: `/journal/new?edit=${entryId}`, variant: 'outline' },
        { type: 'menu', items: [
          { label: 'Make Recurring', onclick: async () => {
            if (!entry) return;
            const template = templateFromEntry(entry, items);
            await getBackend().createRecurringTemplate(template);
            toast.success("Recurring template created");
            goto("/journal/recurring");
          }},
          { label: 'Void Entry', onclick: handleVoid }
        ]}
      ]);
    } else {
      clearTopBarActions();
    }
  });

  onDestroy(() => {
    const id = entryId;
    if (id) clearBreadcrumbOverride(id);
    clearTopBarActions();
  });
</script>

<div class="space-y-6">
  {#if loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if !entry}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Entry not found.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    {#if isHidden}
      <div class="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200">
        This entry involves hidden currencies. It is excluded from the journal list and reports.
      </div>
    {/if}
    <Card.Root>
      <Card.Header>
        <Card.Title>Details</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-2 gap-4 text-sm">
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
          <div>
            <dt class="text-muted-foreground">Source</dt>
            <dd class="font-medium">{entry.source}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Created</dt>
            <dd class="font-medium">{entry.created_at}</dd>
          </div>
          {#if metadata["edit:original_id"]}
            <div>
              <dt class="text-muted-foreground">Edit of</dt>
              <dd><a href="/journal/{metadata['edit:original_id']}" class="text-blue-600 hover:underline dark:text-blue-400">Original entry</a></dd>
            </div>
          {/if}
          {#if entry.voided_by}
            <div>
              <dt class="text-muted-foreground">Voided by</dt>
              <dd><a href="/journal/{entry.voided_by}" class="text-blue-600 hover:underline dark:text-blue-400">Reversal entry</a></dd>
            </div>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>

    {@const displayMeta = Object.entries(metadata).filter(([k]) => k !== TAGS_META_KEY && k !== "links")}
    <Card.Root>
      <Card.Header>
        <Card.Title>Metadata</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-4">
        <dl class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt class="text-muted-foreground">Tags</dt>
            <dd><TagInput {tags} onchange={handleTagsChange} /></dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Links</dt>
            <dd><LinkInput links={entryLinks} onchange={handleLinksChange} suggestions={linkSuggestions} /></dd>
          </div>
        </dl>
        {#if displayMeta.length > 0}
          <dl class="grid grid-cols-2 gap-4 text-sm">
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
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Line Items</Card.Title>
      </Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Account</Table.Head>
            <Table.Head>Currency</Table.Head>
            <Table.Head class="text-right">Debit</Table.Head>
            <Table.Head class="text-right">Credit</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each items as item (item.id)}
            {@const amount = parseFloat(item.amount)}
            <Table.Row>
              <Table.Cell>
                <a href="/accounts/{item.account_id}" class="hover:underline">
                  {accountName(item.account_id)}
                </a>
              </Table.Cell>
              <Table.Cell>{item.currency}</Table.Cell>
              <Table.Cell class="text-right font-mono">
                {amount > 0 ? formatCurrencyFull(item.amount, item.currency) : ""}
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {amount < 0 ? formatCurrencyFull(item.amount.replace(/^-/, ""), item.currency) : ""}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {/if}
</div>
