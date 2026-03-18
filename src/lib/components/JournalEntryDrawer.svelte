<script lang="ts">
  import { v7 as uuidv7 } from "uuid";
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
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
  import { inferAccountType } from "$lib/browser-etherscan.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import MetadataEditor from "$lib/components/MetadataEditor.svelte";
  import AccountCombobox from "$lib/components/AccountCombobox.svelte";
  import FlowView from "$lib/components/FlowView.svelte";
  import { parseTags, serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import type { JournalEntry, LineItem, Account } from "$lib/types/index.js";
  import type { AccountType } from "$lib/types/account.js";
  import { invalidate } from "$lib/data/invalidation.js";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Plus from "lucide-svelte/icons/plus";
  import Pencil from "lucide-svelte/icons/pencil";
  import X from "lucide-svelte/icons/x";
  import ArrowRightLeft from "lucide-svelte/icons/arrow-right-left";
  import TableIcon from "lucide-svelte/icons/table";

  interface Props {
    open: boolean;
    mode: "view" | "new" | "edit";
    entryId?: string | null;
    onsaved?: (newId: string) => void;
    onclose?: () => void;
  }

  let { open = $bindable(), mode = $bindable(), entryId = $bindable(null), onsaved, onclose }: Props = $props();

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

  // ── New/Edit mode state ──
  let formDate = $state(new Date().toISOString().slice(0, 10));
  let formDescription = $state("");
  let formCurrency = $state("EUR");
  let formTags = $state<string[]>([]);
  let formLinks = $state<string[]>([]);
  let formMetadata = $state<Record<string, string>>({});
  let tagSuggestions = $state<string[]>([]);
  let formLinkSuggestions = $state<string[]>([]);
  let metaKeySuggestions = $state<string[]>([]);
  let editLoading = $state(false);
  let submitting = $state(false);

  interface FormLine {
    key: string;
    accountPath: string;
    debit: string;
    credit: string;
    _autoDebit: boolean;
    _autoCredit: boolean;
  }

  let lines = $state<FormLine[]>([]);
  const accountNames = $derived(accountStore.postable.map((a) => a.full_name));

  function resetFormLines() {
    lines = [
      { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false },
      { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false },
    ];
  }

  function addLine() {
    lines = [...lines, { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false }];
  }

  function removeLine(key: string) {
    if (lines.length <= 2) return;
    lines = lines.filter((l) => l.key !== key);
  }

  function handleDebitInput(lineIndex: number) {
    const line = lines[lineIndex];
    if (line.debit) line.credit = "";
    line._autoDebit = false;
    line._autoCredit = false;
    if (lines.length === 2) {
      const other = lines[1 - lineIndex];
      if (!other.credit || other._autoCredit) {
        other.credit = line.debit;
        other._autoCredit = true;
        other.debit = "";
        other._autoDebit = false;
      }
    }
  }

  function handleCreditInput(lineIndex: number) {
    const line = lines[lineIndex];
    if (line.credit) line.debit = "";
    line._autoCredit = false;
    line._autoDebit = false;
    if (lines.length === 2) {
      const other = lines[1 - lineIndex];
      if (!other.debit || other._autoDebit) {
        other.debit = line.credit;
        other._autoDebit = true;
        other.credit = "";
        other._autoCredit = false;
      }
    }
  }

  const totalDebit = $derived(lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0));
  const totalCredit = $derived(lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0));
  const isBalanced = $derived(Math.abs(totalDebit - totalCredit) < 0.001 && totalDebit > 0);

  async function ensureAccountHierarchy(fullName: string): Promise<string> {
    const existing = accountStore.active.find((a) => a.full_name === fullName);
    if (existing) return existing.id;
    const backend = getBackend();
    const parts = fullName.split(":");
    let parentId: string | null = null;
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(":");
      const cached = accountStore.accounts.find((a) => a.full_name === path);
      if (cached) { parentId = cached.id; continue; }
      const account: Account = {
        id: uuidv7(),
        parent_id: parentId,
        account_type: inferAccountType(path),
        name: parts[i - 1],
        full_name: path,
        allowed_currencies: [],
        is_postable: i === parts.length,
        is_archived: false,
        created_at: new Date().toISOString().slice(0, 10),
      };
      await backend.createAccount(account);
      parentId = account.id;
    }
    return parentId!;
  }

  async function prefillFromEntry(editId: string) {
    editLoading = true;
    try {
      const backend = getBackend();
      const [entryResult, metaResult, linksResult] = await Promise.all([
        backend.getJournalEntry(editId),
        backend.getMetadata(editId).catch(() => ({}) as Record<string, string>),
        backend.getEntryLinks(editId).catch(() => [] as string[]),
      ]);
      if (!entryResult) {
        toast.error("Entry not found");
        editLoading = false;
        return;
      }
      const [origEntry, origItems] = entryResult;

      if (origEntry.status === "voided") {
        toast.error("Cannot edit a voided entry");
        open = false;
        return;
      }

      formDate = origEntry.date;
      formDescription = origEntry.description;
      if (origItems.length > 0) formCurrency = origItems[0].currency;

      const formLines: FormLine[] = origItems.map((item) => {
        const amount = parseFloat(item.amount);
        const acct = accountStore.accounts.find((a) => a.id === item.account_id);
        return {
          key: uuidv7(),
          accountPath: acct?.full_name ?? item.account_id,
          debit: amount > 0 ? Math.abs(amount).toString() : "",
          credit: amount < 0 ? Math.abs(amount).toString() : "",
          _autoDebit: false,
          _autoCredit: false,
        };
      });
      lines = formLines.length >= 2 ? formLines : [
        ...formLines,
        ...Array.from({ length: 2 - formLines.length }, () => ({
          key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false,
        })),
      ];

      const filteredMeta: Record<string, string> = {};
      for (const [k, v] of Object.entries(metaResult)) {
        if (k === TAGS_META_KEY) {
          formTags = parseTags(v);
        } else if (!k.startsWith("edit:")) {
          filteredMeta[k] = v;
        }
      }
      formMetadata = filteredMeta;
      formLinks = linksResult;
    } finally {
      editLoading = false;
    }
  }

  async function handleSubmit() {
    if (!isBalanced) return;
    submitting = true;

    const newEntryId = uuidv7();
    const today = new Date().toISOString().slice(0, 10);
    const validLines = lines.filter((l) => l.accountPath && (l.debit || l.credit));

    let needsReload = false;
    const items: LineItem[] = [];
    for (const l of validLines) {
      const existingBefore = accountStore.active.find((a) => a.full_name === l.accountPath);
      const accountId = await ensureAccountHierarchy(l.accountPath);
      if (!existingBefore) needsReload = true;
      const debitAmount = parseFloat(l.debit) || 0;
      const creditAmount = parseFloat(l.credit) || 0;
      const amount = debitAmount > 0 ? debitAmount : -creditAmount;
      items.push({
        id: uuidv7(),
        journal_entry_id: newEntryId,
        account_id: accountId,
        currency: formCurrency,
        amount: amount.toString(),
        lot_id: null,
      });
    }

    if (needsReload) await accountStore.load();

    if (mode === "edit" && entryId) {
      const journalEntry: JournalEntry = {
        id: newEntryId, date: formDate, description: formDescription,
        status: "confirmed", source: "system:edit", voided_by: null, created_at: today,
      };
      const metaToSave = { ...formMetadata };
      if (formTags.length > 0) metaToSave[TAGS_META_KEY] = serializeTags(formTags);

      const result = await journalStore.edit(
        entryId, journalEntry, items,
        Object.keys(metaToSave).length > 0 ? metaToSave : undefined,
        formLinks.length > 0 ? formLinks : undefined,
      );

      if (result) {
        submitting = false;
        toast.success("Entry updated");
        invalidate("journal", "accounts", "reports");
        onsaved?.(result.newEntryId);
      } else {
        submitting = false;
        toast.error(journalStore.error ?? "Failed to edit entry");
      }
    } else {
      const journalEntry: JournalEntry = {
        id: newEntryId, date: formDate, description: formDescription,
        status: "confirmed", source: "manual", voided_by: null, created_at: today,
      };

      const ok = await journalStore.post(journalEntry, items);
      if (ok) {
        const metaToSave = { ...formMetadata };
        if (formTags.length > 0) metaToSave[TAGS_META_KEY] = serializeTags(formTags);
        if (Object.keys(metaToSave).length > 0) {
          await getBackend().setMetadata(newEntryId, metaToSave);
        }
        if (formLinks.length > 0) {
          await getBackend().setEntryLinks(newEntryId, formLinks);
        }
        submitting = false;
        toast.success("Journal entry posted");
        invalidate("journal", "accounts", "reports");
        onsaved?.(newEntryId);
      } else {
        submitting = false;
        toast.error(journalStore.error ?? "Failed to post entry");
      }
    }
  }

  // ── Lifecycle: reload on open/entryId/mode change ──
  let lastLoadedKey = $state("");

  $effect(() => {
    if (!open) return;
    const key = `${mode}:${entryId ?? ""}`;
    if (key === lastLoadedKey) return;
    lastLoadedKey = key;

    // Load account store once
    accountStore.load();

    if (mode === "view" && entryId) {
      loadEntry(entryId);
    } else if (mode === "edit" && entryId) {
      // Load suggestions + prefill
      resetFormLines();
      const backend = getBackend();
      Promise.all([
        backend.getAllTagValues().catch(() => [] as string[]),
        backend.getAllLinkNames().catch(() => [] as string[]),
        backend.getAllMetadataKeys().catch(() => [] as string[]),
      ]).then(([tags, links, keys]) => {
        tagSuggestions = tags;
        formLinkSuggestions = links;
        metaKeySuggestions = keys;
      });
      prefillFromEntry(entryId);
    } else if (mode === "new") {
      // Reset form
      formDate = new Date().toISOString().slice(0, 10);
      formDescription = "";
      formCurrency = "EUR";
      formTags = [];
      formLinks = [];
      formMetadata = {};
      resetFormLines();
      const backend = getBackend();
      Promise.all([
        backend.getAllTagValues().catch(() => [] as string[]),
        backend.getAllLinkNames().catch(() => [] as string[]),
        backend.getAllMetadataKeys().catch(() => [] as string[]),
      ]).then(([tags, links, keys]) => {
        tagSuggestions = tags;
        formLinkSuggestions = links;
        metaKeySuggestions = keys;
      });
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
    {#if mode === "view"}
      <!-- ═══ VIEW MODE ═══ -->
      <Drawer.Header class="space-y-1">
        <div class="flex items-center justify-between">
          <Drawer.Title class="text-sm font-medium text-muted-foreground">Entry Details</Drawer.Title>
          <div class="flex items-center gap-1">
            {#if entry && entry.status === "confirmed"}
              <Button variant="outline" size="sm" onclick={() => { mode = "edit"; }}>
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
          </section>

          <!-- Metadata -->
          {@const displayMeta = Object.entries(viewMetadata).filter(([k]) => k !== TAGS_META_KEY && k !== "links")}
          {#if viewTags.length > 0 || viewEntryLinks.length > 0 || displayMeta.length > 0}
            <section>
              <h3 class="text-sm font-medium text-muted-foreground mb-2">Metadata</h3>
              <div class="space-y-3 text-sm">
                {#if viewTags.length > 0 || viewEntryLinks.length > 0}
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
                {/if}
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
          {/if}

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

    {:else}
      <!-- ═══ NEW / EDIT MODE ═══ -->
      <Drawer.Header class="flex items-center justify-between">
        <Drawer.Title>{mode === "edit" ? "Edit Entry" : "New Entry"}</Drawer.Title>
        <Button variant="ghost" size="icon" class="h-8 w-8" onclick={() => { onclose?.(); }}>
          <X class="h-4 w-4" />
        </Button>
      </Drawer.Header>

      <div class="flex-1 overflow-y-auto px-4 pb-4">
        {#if editLoading}
          <div class="py-8 text-center">
            <p class="text-sm text-muted-foreground">Loading entry...</p>
          </div>
        {:else}
          <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-4">
            <!-- Entry Details -->
            <section>
              <h3 class="text-sm font-medium text-muted-foreground mb-2">Entry Details</h3>
              <div class="space-y-3">
                <div class="space-y-1">
                  <label for="drawer-date" class="text-sm font-medium">Date</label>
                  <Input id="drawer-date" type="date" bind:value={formDate} required />
                </div>
                <div class="space-y-1">
                  <label for="drawer-desc" class="text-sm font-medium">Description</label>
                  <Input id="drawer-desc" bind:value={formDescription} placeholder="e.g. Monthly rent payment" required />
                </div>

                <div class="space-y-1">
                  <span class="text-sm font-medium">Currency</span>
                  <Select.Root type="single" bind:value={formCurrency}>
                    <Select.Trigger class="w-full max-w-[200px]">
                      {@const cur = accountStore.currencies.find((c) => c.code === formCurrency)}
                      {cur ? `${cur.code} - ${cur.name}` : formCurrency}
                    </Select.Trigger>
                    <Select.Content>
                      {#each accountStore.currencies as c (c.code)}
                        <Select.Item value={c.code}>{c.code} - {c.name}</Select.Item>
                      {/each}
                      {#if accountStore.currencies.length === 0}
                        <Select.Item value="EUR">EUR</Select.Item>
                      {/if}
                    </Select.Content>
                  </Select.Root>
                </div>

                <div class="space-y-1">
                  <label class="text-sm font-medium">Tags</label>
                  <TagInput tags={formTags} onchange={(t) => { formTags = t; }} suggestions={tagSuggestions} />
                </div>
                <div class="space-y-1">
                  <label class="text-sm font-medium">Links</label>
                  <LinkInput links={formLinks} onchange={(l) => { formLinks = l; }} suggestions={formLinkSuggestions} />
                </div>

                <details class="space-y-1">
                  <summary class="text-sm font-medium cursor-pointer text-muted-foreground">Metadata</summary>
                  <MetadataEditor
                    metadata={formMetadata}
                    onchange={(m) => { formMetadata = m; }}
                    keySuggestions={metaKeySuggestions}
                    class="mt-2"
                  />
                </details>
              </div>
            </section>

            <hr class="border-border" />

            <!-- Line Items -->
            <section>
              <h3 class="text-sm font-medium text-muted-foreground mb-1">Line Items</h3>
              <p class="text-xs text-muted-foreground mb-3">Debits must equal credits for the entry to balance.</p>
              <div class="space-y-3">
                {#each lines as line, i (line.key)}
                  <div class="rounded-md border p-2 space-y-2">
                    <AccountCombobox
                      value={line.accountPath}
                      accounts={accountNames}
                      variant="input"
                      placeholder="Select account..."
                      onchange={(v) => { line.accountPath = v; }}
                    />
                    <div class="grid grid-cols-[1fr_1fr_40px] gap-2 items-center">
                      <div class="space-y-0.5">
                        <span class="text-xs text-muted-foreground">Debit</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          bind:value={line.debit}
                          class="text-right font-mono"
                          oninput={() => handleDebitInput(i)}
                        />
                      </div>
                      <div class="space-y-0.5">
                        <span class="text-xs text-muted-foreground">Credit</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          bind:value={line.credit}
                          class="text-right font-mono"
                          oninput={() => handleCreditInput(i)}
                        />
                      </div>
                      <div class="pt-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          type="button"
                          disabled={lines.length <= 2}
                          onclick={() => removeLine(line.key)}
                        >
                          <Trash2 class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                {/each}

                <Button variant="outline" size="sm" type="button" onclick={addLine}>
                  <Plus class="h-4 w-4 mr-1" /> Add Line
                </Button>
              </div>

              <div class="mt-4 flex justify-end gap-6 border-t pt-3 text-sm">
                <div>
                  <span class="text-muted-foreground">Debit:</span>
                  <span class="ml-1 font-mono font-medium">{totalDebit.toFixed(2)}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Credit:</span>
                  <span class="ml-1 font-mono font-medium">{totalCredit.toFixed(2)}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Diff:</span>
                  <span class="ml-1 font-mono font-medium {isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                    {Math.abs(totalDebit - totalCredit).toFixed(2)}
                  </span>
                </div>
              </div>
            </section>

            <div class="flex justify-end gap-2 pt-2 pb-2">
              <Button variant="outline" type="button" onclick={() => { onclose?.(); }}>Cancel</Button>
              <Button type="submit" disabled={!isBalanced || !formDescription.trim() || submitting}>
                {#if submitting}
                  {mode === "edit" ? "Saving..." : "Posting..."}
                {:else}
                  {mode === "edit" ? "Save Changes" : "Post Entry"}
                {/if}
              </Button>
            </div>
          </form>
        {/if}
      </div>
    {/if}
  </Drawer.Content>
</Drawer.Root>
