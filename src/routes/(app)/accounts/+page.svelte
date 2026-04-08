<svelte:head><title>Accounts · dLedger</title></svelte:head>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Plus from "lucide-svelte/icons/plus";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
  import { DEMO_MODE } from "$lib/demo.js";
  import { v7 as uuidv7 } from "uuid";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import type { Account, AccountType } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import { createDefaultAccounts, type DefaultAccountSet } from "$lib/accounts/defaults.js";
  import { getBackend } from "$lib/backend.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
  import * as m from "$paraglide/messages.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";

  const store = new AccountStore();
  const settingsStore = new SettingsStore();

  // Reload when account data changes elsewhere (imports, cross-tab)
  const unsubAccounts = onInvalidate("accounts", () => { store.load(); });

  $effect(() => {
    setTopBarActions(
      DEMO_MODE
        ? []
        : [
            { type: 'button', label: m.btn_new_account(), onclick: () => { dialogOpen = true; }, fab: true, fabIcon: Plus }
          ],
    );
  });

  onDestroy(() => {
    unsubAccounts();
    clearTopBarActions();
  });

  let dialogOpen = $state(false);

  // Form state
  let formName = $state("");
  let formType = $state<AccountType>("asset");
  let formParentId = $state<string | null>(null);
  let formIsPostable = $state(true);
  let formOpenedAt = $state("1970-01-01");
  let formOpeningBalance = $state("");
  let formOpeningCurrency = $state("");

  const accountTypes: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

  let searchTerm = $state("");
  let showArchived = $state(false);

  // Tree view collapse state
  let collapsedIds = $state(new Set<string>());

  // Ancestor row highlighting on hover
  let hoveredId = $state<string | null>(null);

  const hoveredAncestorIds = $derived.by(() => {
    if (!hoveredId) return new Set<string>();
    const ids = new Set<string>();
    const hovered = store.byId.get(hoveredId);
    let pid = hovered?.parent_id ?? null;
    while (pid) {
      ids.add(pid);
      const parent = store.byId.get(pid);
      pid = parent?.parent_id ?? null;
    }
    return ids;
  });

  function toggleCollapse(id: string) {
    const next = new Set(collapsedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedIds = next;
  }

  // Set of account IDs that have at least one child
  const parentIds = $derived.by(() => {
    const source = showArchived ? store.accounts : store.active;
    return new Set(source.filter(a => a.parent_id !== null).map(a => a.parent_id!));
  });

  function getDepth(account: Account): number {
    return account.full_name.split(":").length - 1;
  }

  // Inline edit state
  let editingId = $state<string | null>(null);
  let editFullName = $state("");
  let editPostable = $state(true);
  let editSaving = $state(false);
  let suggestionsOpen = $state(false);

  // Merge state
  let pendingMergeTarget = $state<Account | null>(null);
  let mergeDialogOpen = $state(false);
  let merging = $state(false);

  const TYPE_PREFIXES: Record<AccountType, string[]> = {
    asset: ["Assets:", "Asset:"],
    liability: ["Liabilities:", "Liability:"],
    equity: ["Equity:"],
    revenue: ["Income:", "Revenue:"],
    expense: ["Expenses:", "Expense:"],
  };

  function getEditError(account: Account, newFullName: string): string | null {
    const trimmed = newFullName.trim();
    if (!trimmed) return m.error_name_required();
    if (!trimmed.includes(":")) return m.error_segments_required();
    const prefixes = TYPE_PREFIXES[account.account_type];
    if (!prefixes.some((p) => trimmed.startsWith(p))) {
      return m.error_must_start_with({ prefix: prefixes[0] });
    }
    return null;
  }

  const editError = $derived(
    editingId
      ? (() => {
          const account = store.accounts.find((a) => a.id === editingId);
          return account ? getEditError(account, editFullName) : null;
        })()
      : null,
  );

  const editHasChanges = $derived(
    editingId
      ? (() => {
          const account = store.accounts.find((a) => a.id === editingId);
          if (!account) return false;
          return editFullName.trim() !== account.full_name || editPostable !== account.is_postable;
        })()
      : false,
  );

  // Suggestions: sibling accounts + text matches, excluding the one being edited
  const editSuggestions = $derived.by(() => {
    if (!editingId) return [];
    const account = store.accounts.find((a) => a.id === editingId);
    if (!account) return [];
    const trimmed = editFullName.trim().toLowerCase();
    if (!trimmed) return [];

    const lastColon = trimmed.lastIndexOf(":");
    const parentPrefix = lastColon >= 0 ? trimmed.substring(0, lastColon + 1) : "";

    const sameType = store.active.filter((a) => a.id !== editingId && a.account_type === account.account_type);

    // Siblings: same parent prefix
    const siblings = parentPrefix
      ? sameType.filter((a) => a.full_name.toLowerCase().startsWith(parentPrefix))
      : [];

    // Text matches (existing behavior)
    const textMatches = sameType.filter((a) => a.full_name.toLowerCase().includes(trimmed));

    // Combine: siblings first, then text matches, deduplicated
    const seen = new Set<string>();
    const result: typeof sameType = [];
    for (const a of [...siblings, ...textMatches]) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        result.push(a);
      }
    }
    return result.slice(0, 10);
  });

  // Detect if editFullName matches an existing same-type account (for merge)
  const matchedExisting = $derived.by(() => {
    if (!editingId) return null;
    const account = store.accounts.find((a) => a.id === editingId);
    if (!account) return null;
    const trimmed = editFullName.trim();
    return store.active.find((a) => a.id !== editingId && a.account_type === account.account_type && a.full_name === trimmed) ?? null;
  });

  // Whether save action will be a merge
  const isMerge = $derived(pendingMergeTarget !== null || matchedExisting !== null);

  function startEdit(account: Account) {
    editingId = account.id;
    editFullName = account.full_name;
    editPostable = account.is_postable;
    pendingMergeTarget = null;
  }

  function cancelEdit() {
    editingId = null;
    editFullName = "";
    editPostable = true;
    pendingMergeTarget = null;
    suggestionsOpen = false;
  }

  function selectSuggestion(suggestion: Account) {
    editFullName = suggestion.full_name;
    pendingMergeTarget = suggestion;
    suggestionsOpen = false;
  }

  async function saveEdit() {
    if (!editingId || editError || !editHasChanges) return;
    const account = store.accounts.find((a) => a.id === editingId);
    if (!account) return;

    // Check if this should be a merge
    const mergeTarget = pendingMergeTarget ?? matchedExisting;
    if (mergeTarget) {
      mergeDialogOpen = true;
      return;
    }

    // Normal rename path
    editSaving = true;
    const updates: { full_name?: string; is_postable?: boolean } = {};
    if (editFullName.trim() !== account.full_name) updates.full_name = editFullName.trim();
    if (editPostable !== account.is_postable) updates.is_postable = editPostable;

    const ok = await store.update(editingId, updates);
    editSaving = false;
    if (ok) {
      toast.success(m.toast_account_updated({ name: editFullName.trim() }));
      cancelEdit();
    } else {
      toast.error(store.error ?? "Failed to update account");
    }
  }

  async function confirmMerge() {
    if (!editingId) return;
    const mergeTarget = pendingMergeTarget ?? matchedExisting;
    if (!mergeTarget) return;

    merging = true;
    const account = store.accounts.find((a) => a.id === editingId);
    const result = await store.merge(editingId, mergeTarget.id);
    merging = false;
    mergeDialogOpen = false;

    if (result) {
      const moved = result.lineItems + result.lots + result.assertions + result.reconciliations;
      toast.success(m.toast_account_merged({ source: account?.full_name ?? "", target: mergeTarget.full_name, count: String(moved) }));
      cancelEdit();
    } else {
      toast.error(store.error ?? "Failed to merge accounts");
    }
  }

  const filteredAccounts = $derived.by(() => {
    const accounts = showArchived ? store.accounts : store.active;
    const term = searchTerm.trim();

    // When searching, find matching accounts + all their ancestors
    let includedIds: Set<string> | null = null;
    if (term) {
      const matching = accounts.filter(a => matchesFilter(a, term, ["full_name", "account_type"]));
      includedIds = new Set<string>();
      for (const account of matching) {
        includedIds.add(account.id);
        let pid = account.parent_id;
        while (pid) {
          if (includedIds.has(pid)) break;
          includedIds.add(pid);
          const parent = store.byId.get(pid);
          pid = parent?.parent_id ?? null;
        }
      }
    }

    // Walk sorted list, applying both inclusion filter and collapse logic
    const result: Account[] = [];
    let skipPrefix: string | null = null;
    for (const account of accounts) {
      if (includedIds && !includedIds.has(account.id)) continue;
      if (skipPrefix && account.full_name.startsWith(skipPrefix)) continue;
      skipPrefix = null;
      result.push(account);
      if (collapsedIds.has(account.id)) {
        skipPrefix = account.full_name + ":";
      }
    }
    return result;
  });

  // Virtual scrolling
  let scrollEl = $state<HTMLDivElement | null>(null);

  const virtualizer = createVirtualizer(() => ({
    count: filteredAccounts.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 44,
    overscan: 10,
  }));

  const virtualItems = $derived(
    virtualizer.getVirtualItems().filter((row) => row.index < filteredAccounts.length)
  );
  const totalSize = $derived(virtualizer.getTotalSize());
  const paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  const paddingBottom = $derived(
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0
  );

  function resetForm() {
    formName = "";
    formType = "asset";
    formParentId = null;
    formIsPostable = true;
    formOpenedAt = "1970-01-01";
    formOpeningBalance = "";
    formOpeningCurrency = settingsStore.currency || "";
  }

  function startSubAccount(parent: Account) {
    formName = "";
    formType = parent.account_type;
    formParentId = parent.id;
    formIsPostable = true;
    formOpenedAt = "1970-01-01";
    formOpeningBalance = "";
    formOpeningCurrency = settingsStore.currency || "";
    dialogOpen = true;
  }

  async function handleCreate() {
    const today = new Date().toISOString().slice(0, 10);
    const isAssetOrLiability = formType === "asset" || formType === "liability";

    // Compute full_name from parent + name
    let fullName = formName;
    if (formParentId) {
      const parent = store.accounts.find(a => a.id === formParentId);
      if (parent) fullName = parent.full_name + ":" + formName;
    }

    const account: Account = {
      id: uuidv7(),
      parent_id: formParentId,
      account_type: formType,
      name: formName,
      full_name: fullName,
      allowed_currencies: [],
      is_postable: formIsPostable,
      is_archived: false,
      created_at: today,
      opened_at: isAssetOrLiability ? formOpenedAt : null,
    };

    const ok = await store.create(account);
    if (!ok) {
      toast.error(store.error ?? "Failed to create account");
      return;
    }

    // Create opening balance entry if specified
    const balanceNum = parseFloat(formOpeningBalance);
    const balStr = String(formOpeningBalance);
    if (isAssetOrLiability && balStr.trim() && !isNaN(balanceNum) && balanceNum !== 0 && formOpeningCurrency.trim()) {
      try {
        const backend = getBackend();
        const allAccounts = await backend.listAccounts();
        const equityPath = "Equity:Opening-Balances";

        // Ensure Equity:Opening-Balances account exists
        let counterpartyId = allAccounts.find(ac => ac.full_name === equityPath)?.id;
        if (!counterpartyId) {
          const parts = equityPath.split(":");
          let parentId: string | null = null;
          for (let depth = 1; depth <= parts.length; depth++) {
            const path = parts.slice(0, depth).join(":");
            const existing = allAccounts.find(ac => ac.full_name === path);
            if (existing) {
              parentId = existing.id;
              continue;
            }
            const type = path.startsWith("Equity") ? "equity" as const : path.startsWith("Assets") ? "asset" as const : "liability" as const;
            const newId = uuidv7();
            await backend.createAccount({
              id: newId, parent_id: parentId, account_type: type,
              name: parts[depth - 1], full_name: path, allowed_currencies: [],
              is_postable: depth === parts.length, is_archived: false, created_at: today,
            });
            parentId = newId;
            if (depth === parts.length) counterpartyId = newId;
          }
        }

        // Create system:pad journal entry
        const entryId = uuidv7();
        const amountStr = balanceNum.toString();
        await backend.postJournalEntry(
          { id: entryId, date: formOpenedAt, description: `Opening balance for ${fullName}`, status: "confirmed", source: "system:pad", voided_by: null, created_at: today },
          [
            { id: uuidv7(), journal_entry_id: entryId, account_id: account.id, currency: formOpeningCurrency.trim().toUpperCase(), amount: amountStr, lot_id: null },
            { id: uuidv7(), journal_entry_id: entryId, account_id: counterpartyId!, currency: formOpeningCurrency.trim().toUpperCase(), amount: (-balanceNum).toString(), lot_id: null },
          ],
        );

        const { invalidate } = await import("$lib/data/invalidation.js");
        invalidate("journal", "accounts", "reports");
      } catch (e) {
        toast.error(m.toast_opening_balance_failed({ message: e instanceof Error ? e.message : String(e) }));
        dialogOpen = false;
        resetForm();
        return;
      }
    }

    toast.success(m.toast_account_created({ name: fullName }));
    dialogOpen = false;
    resetForm();
  }

  async function handleArchive(id: string, name: string) {
    const ok = await store.archive(id);
    if (ok) {
      toast.success(m.toast_account_archived({ name }));
    } else {
      toast.error(store.error ?? "Failed to archive account");
    }
  }

  async function handleUnarchive(id: string, name: string) {
    const ok = await store.unarchive(id);
    if (ok) {
      toast.success(m.toast_account_restored({ name }));
    } else {
      toast.error(store.error ?? "Failed to unarchive account");
    }
  }

  // Default accounts state
  let defaultSet = $state<DefaultAccountSet>("standard");
  let creatingDefaults = $state(false);

  async function handleCreateDefaults() {
    creatingDefaults = true;
    try {
      const result = await createDefaultAccounts(getBackend(), defaultSet);
      toast.success(m.toast_accounts_created_count({ count: String(result.created) }));
      await store.load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      creatingDefaults = false;
    }
  }

  onMount(() => {
    store.load();
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <ListFilter bind:value={searchTerm} placeholder={m.placeholder_filter_accounts()} class="order-last sm:order-none" />
    {#if store.archivedCount > 0}
      <label class="flex items-center gap-2 text-sm">
        <Switch checked={showArchived} onCheckedChange={(v) => (showArchived = v)} />
        {m.label_show_archived({ count: String(store.archivedCount) })}
      </label>
    {/if}
  </div>

    <Dialog.Root bind:open={dialogOpen}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{m.dialog_create_account()}</Dialog.Title>
          <Dialog.Description>{m.dialog_create_account_desc()}</Dialog.Description>
        </Dialog.Header>
        <form onsubmit={(e) => { e.preventDefault(); handleCreate(); }} class="space-y-4">
          <div class="space-y-2">
            <label for="name" class="text-sm font-medium">{m.label_name()}</label>
            <Input id="name" bind:value={formName} placeholder="e.g. Checking" required />
            {#if formParentId}
              {@const parent = store.accounts.find(a => a.id === formParentId)}
              {#if parent}
                <p class="text-xs text-muted-foreground">{m.label_path({ path: `${parent.full_name}:${formName || "..."}` })}</p>
              {/if}
            {/if}
          </div>
          <div class="space-y-2">
            <span class="text-sm font-medium">{m.label_type()}</span>
            <Select.Root type="single" bind:value={formType}>
              <Select.Trigger class="w-full">
                {formType.charAt(0).toUpperCase() + formType.slice(1)}
              </Select.Trigger>
              <Select.Content>
                {#each accountTypes as t (t)}
                  <Select.Item value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="space-y-2">
            <span class="text-sm font-medium">{m.label_parent_account()}</span>
            <Select.Root type="single" value={formParentId ?? ""} onValueChange={(val) => { formParentId = val === "" ? null : val; }}>
              <Select.Trigger class="w-full">
                {#if formParentId}
                  {@const parent = store.accounts.find(a => a.id === formParentId)}
                  {parent?.full_name ?? formParentId}
                {:else}
                  {m.option_none_top_level()}
                {/if}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="">{m.option_none_top_level()}</Select.Item>
                {#each store.accounts.filter(a => !a.is_postable || a.account_type === formType) as acc (acc.id)}
                  <Select.Item value={acc.id}>{acc.full_name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex items-center gap-2">
            <Switch id="postable" bind:checked={formIsPostable} />
            <label for="postable" class="text-sm font-medium">{m.label_postable()}</label>
          </div>
          {#if formType === "asset" || formType === "liability"}
            <div class="space-y-2">
              <label for="openedAt" class="text-sm font-medium">{m.label_opening_date()}</label>
              <Input id="openedAt" type="date" bind:value={formOpenedAt} />
            </div>
            <div class="space-y-2">
              <label class="text-sm font-medium">{m.label_opening_balance()}</label>
              <div class="flex gap-2">
                <Input type="number" step="any" bind:value={formOpeningBalance} placeholder="0.00" class="flex-1" />
                <Input bind:value={formOpeningCurrency} placeholder="USD" class="w-24 uppercase" />
              </div>
            </div>
          {/if}
          <Dialog.Footer>
            <Button type="submit" disabled={!formName.trim()}>{m.btn_create()}</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>

  {#if store.loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3, 4, 5] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if store.active.length === 0 && store.archivedCount === 0}
    <Card.Root>
      <Card.Content class="py-8 space-y-4">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_accounts_configured()}
        </p>
        <div class="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Select.Root type="single" bind:value={defaultSet}>
            <Select.Trigger>
              {defaultSet === "minimal" ? m.account_set_minimal() : defaultSet === "standard" ? m.account_set_standard() : m.account_set_comprehensive()}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="minimal">{m.account_set_minimal()}</Select.Item>
              <Select.Item value="standard">{m.account_set_standard()}</Select.Item>
              <Select.Item value="comprehensive">{m.account_set_comprehensive()}</Select.Item>
            </Select.Content>
          </Select.Root>
          <Button onclick={handleCreateDefaults} disabled={creatingDefaults}>
            {creatingDefaults ? m.state_creating() : m.btn_create_default_accounts()}
          </Button>
        </div>
      </Card.Content>
    </Card.Root>
  {:else if store.active.length === 0 && store.archivedCount > 0 && !showArchived}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_all_archived()}
        </p>
      </Card.Content>
    </Card.Root>
  {:else if filteredAccounts.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_accounts_match({ search: searchTerm })}
        </p>
        <div class="flex justify-center mt-2">
          <Button variant="outline" size="sm" onclick={() => (searchTerm = "")}>{m.btn_clear_search()}</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-x-0 rounded-none shadow-none py-0">
      <div bind:this={scrollEl} class="overflow-y-auto max-h-[calc(100vh-140px)] md:max-h-[calc(100vh-220px)] [&_[data-slot=table-container]]:overflow-visible">
      <Table.Root>
        <Table.Header class="sticky top-0 z-10 bg-background">
          <Table.Row class="hidden sm:table-row">
            <Table.Head>{m.label_account()}</Table.Head>
            <Table.Head>{m.label_type()}</Table.Head>
            <Table.Head class="hidden md:table-cell">{m.label_postable_short()}</Table.Head>
            <Table.Head class="text-right">{m.label_actions()}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#if paddingTop > 0}
            <tr><td style="height: {paddingTop}px;" colspan="4"></td></tr>
          {/if}
          {#each virtualItems as row (row.key)}
            {@const account = filteredAccounts[row.index]}
            {#if editingId === account.id}
              <!-- Mobile edit row -->
              <Table.Row class="sm:hidden">
                <Table.Cell colspan={99} class="py-2 px-3">
                  <div style:padding-left="{getDepth(account) * 1}rem">
                    <div class="space-y-2">
                      <Popover.Root bind:open={suggestionsOpen}>
                        <Popover.Trigger class="w-full text-left">
                          <Input
                            bind:value={editFullName}
                            class={editError ? "border-destructive" : isMerge ? "border-yellow-500" : ""}
                            onfocus={() => { suggestionsOpen = true; }}
                            oninput={() => { pendingMergeTarget = null; suggestionsOpen = true; }}
                            onkeydown={(e: KeyboardEvent) => {
                              if (e.key === "Escape") { if (suggestionsOpen) { suggestionsOpen = false; e.stopPropagation(); } else cancelEdit(); }
                              if (e.key === "Enter" && !suggestionsOpen && !editError && editHasChanges) saveEdit();
                            }}
                          />
                        </Popover.Trigger>
                        {#if editSuggestions.length > 0}
                          <Popover.Content class="w-[320px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                            <Command.Root shouldFilter={false}>
                              <Command.List class="max-h-[200px]">
                                <Command.Group heading={m.label_suggestions()}>
                                  {#each editSuggestions as suggestion}
                                    <Command.Item
                                      value={suggestion.full_name}
                                      onSelect={() => selectSuggestion(suggestion)}
                                      class="font-mono text-xs"
                                    >
                                      {suggestion.full_name}
                                    </Command.Item>
                                  {/each}
                                </Command.Group>
                              </Command.List>
                            </Command.Root>
                          </Popover.Content>
                        {/if}
                      </Popover.Root>
                      {#if editError}
                        <p class="text-xs text-destructive">{editError}</p>
                      {:else if isMerge}
                        <p class="text-xs text-yellow-600 dark:text-yellow-400">{m.label_will_merge({ name: (pendingMergeTarget ?? matchedExisting)?.full_name ?? "" })}</p>
                      {/if}
                      <div class="flex items-center gap-2">
                        <Button
                          variant={isMerge ? "destructive" : "ghost"}
                          size="sm"
                          onclick={saveEdit}
                          disabled={!!editError || !editHasChanges || editSaving}
                        >
                          {#if editSaving}
                            {m.state_saving()}
                          {:else if isMerge}
                            {m.btn_merge()}
                          {:else}
                            {m.btn_save()}
                          {/if}
                        </Button>
                        <Button variant="ghost" size="sm" onclick={cancelEdit} disabled={editSaving}>
                          {m.btn_cancel()}
                        </Button>
                      </div>
                    </div>
                  </div>
                </Table.Cell>
              </Table.Row>
              <!-- Desktop edit row -->
              <Table.Row
                class="hidden sm:table-row {hoveredAncestorIds.has(account.id) ? 'bg-muted/30' : ''}"
                onmouseenter={() => (hoveredId = account.id)}
                onmouseleave={() => { if (hoveredId === account.id) hoveredId = null; }}
              >
                <Table.Cell>
                  <div style:padding-left="{getDepth(account) * 1.25}rem">
                  <div class="space-y-1">
                    <Popover.Root bind:open={suggestionsOpen}>
                      <Popover.Trigger class="w-full text-left">
                        <Input
                          bind:value={editFullName}
                          class={editError ? "border-destructive" : isMerge ? "border-yellow-500" : ""}
                          onfocus={() => { suggestionsOpen = true; }}
                          oninput={() => { pendingMergeTarget = null; suggestionsOpen = true; }}
                          onkeydown={(e: KeyboardEvent) => {
                            if (e.key === "Escape") { if (suggestionsOpen) { suggestionsOpen = false; e.stopPropagation(); } else cancelEdit(); }
                            if (e.key === "Enter" && !suggestionsOpen && !editError && editHasChanges) saveEdit();
                          }}
                        />
                      </Popover.Trigger>
                      {#if editSuggestions.length > 0}
                        <Popover.Content class="w-[320px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                          <Command.Root shouldFilter={false}>
                            <Command.List class="max-h-[200px]">
                              <Command.Group heading={m.label_suggestions()}>
                                {#each editSuggestions as suggestion}
                                  <Command.Item
                                    value={suggestion.full_name}
                                    onSelect={() => selectSuggestion(suggestion)}
                                    class="font-mono text-xs"
                                  >
                                    {suggestion.full_name}
                                  </Command.Item>
                                {/each}
                              </Command.Group>
                            </Command.List>
                          </Command.Root>
                        </Popover.Content>
                      {/if}
                    </Popover.Root>
                    {#if editError}
                      <p class="text-xs text-destructive">{editError}</p>
                    {:else if isMerge}
                      <p class="text-xs text-yellow-600 dark:text-yellow-400">{m.label_will_merge({ name: (pendingMergeTarget ?? matchedExisting)?.full_name ?? "" })}</p>
                    {/if}
                  </div>
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <AccountTypeBadge type={account.account_type} />
                </Table.Cell>
                <Table.Cell class="hidden md:table-cell">
                  <Switch bind:checked={editPostable} />
                </Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <Button
                      variant={isMerge ? "destructive" : "ghost"}
                      size="sm"
                      onclick={saveEdit}
                      disabled={!!editError || !editHasChanges || editSaving}
                    >
                      {#if editSaving}
                        {m.state_saving()}
                      {:else if isMerge}
                        {m.btn_merge()}
                      {:else}
                        {m.btn_save()}
                      {/if}
                    </Button>
                    <Button variant="ghost" size="sm" onclick={cancelEdit} disabled={editSaving}>
                      {m.btn_cancel()}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {:else}
              <!-- Mobile row -->
              <Table.Row
                class="sm:hidden {account.is_archived ? 'opacity-50' : ''}"
              >
                <Table.Cell colspan={99} class="py-2 px-3">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0 flex-1" style:padding-left="{getDepth(account) * 1}rem">
                      <!-- Line 1: expand/collapse + name -->
                      <div class="flex items-center gap-1">
                        {#if parentIds.has(account.id)}
                          <button class="p-0.5 -ml-1 rounded hover:bg-muted" onclick={() => toggleCollapse(account.id)}>
                            {#if collapsedIds.has(account.id)}
                              <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
                            {:else}
                              <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
                            {/if}
                          </button>
                        {:else}
                          <span class="w-5"></span>
                        {/if}
                        {#if account.is_postable}
                          <a href="/accounts/{account.id}" class="font-medium hover:underline truncate" title={account.full_name}>{account.name}</a>
                        {:else}
                          <span class="text-sm text-muted-foreground font-medium truncate" title={account.full_name}>{account.name}</span>
                        {/if}
                      </div>
                      <!-- Line 2: type badge + postable -->
                      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5 ml-5 text-xs text-muted-foreground">
                        <AccountTypeBadge type={account.account_type} />
                        {#if account.is_postable}
                          <span>{m.label_postable_short()}</span>
                        {/if}
                      </div>
                    </div>
                    {#if !DEMO_MODE}
                      <!-- Actions -->
                      <div class="shrink-0">
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            {#snippet child({ props })}
                              <Button variant="ghost" size="icon-sm" {...props}>
                                <EllipsisVertical class="h-4 w-4" />
                                <span class="sr-only">{m.label_actions()}</span>
                              </Button>
                            {/snippet}
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content align="end">
                            <DropdownMenu.Item onclick={() => startSubAccount(account)}>{m.btn_add_sub_account()}</DropdownMenu.Item>
                            {#if account.parent_id !== null}
                              <DropdownMenu.Item onclick={() => startEdit(account)}>{m.btn_edit()}</DropdownMenu.Item>
                            {/if}
                            {#if account.is_archived}
                              <DropdownMenu.Item onclick={() => handleUnarchive(account.id, account.full_name)}>{m.btn_unarchive()}</DropdownMenu.Item>
                            {:else}
                              <DropdownMenu.Item onclick={() => handleArchive(account.id, account.full_name)}>{m.btn_archive()}</DropdownMenu.Item>
                            {/if}
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </div>
                    {/if}
                  </div>
                </Table.Cell>
              </Table.Row>
              <!-- Desktop row -->
              <Table.Row
                class="hidden sm:table-row {hoveredAncestorIds.has(account.id) ? 'bg-muted/30' : ''} {account.is_archived ? 'opacity-50' : ''}"
                onmouseenter={() => (hoveredId = account.id)}
                onmouseleave={() => { if (hoveredId === account.id) hoveredId = null; }}
              >
                <Table.Cell>
                  <div class="flex items-center" style:padding-left="{getDepth(account) * 1.25}rem">
                    {#if parentIds.has(account.id)}
                      <button class="p-0.5 -ml-1 mr-1 rounded hover:bg-muted" onclick={() => toggleCollapse(account.id)}>
                        {#if collapsedIds.has(account.id)}
                          <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
                        {:else}
                          <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
                        {/if}
                      </button>
                    {:else}
                      <span class="w-5"></span>
                    {/if}

                    {#if account.is_postable}
                      <a href="/accounts/{account.id}" class="font-medium hover:underline" title={account.full_name}>{account.name}</a>
                    {:else}
                      <span class="text-sm text-muted-foreground font-medium" title={account.full_name}>{account.name}</span>
                    {/if}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <AccountTypeBadge type={account.account_type} />
                </Table.Cell>
                <Table.Cell class="hidden md:table-cell">{account.is_postable ? m.label_yes() : m.label_no()}</Table.Cell>
                <Table.Cell class="text-right">
                  {#if !DEMO_MODE}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                          <Button variant="ghost" size="icon-sm" {...props}>
                            <EllipsisVertical class="h-4 w-4" />
                            <span class="sr-only">{m.label_actions()}</span>
                          </Button>
                        {/snippet}
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item onclick={() => startSubAccount(account)}>{m.btn_add_sub_account()}</DropdownMenu.Item>
                        {#if account.parent_id !== null}
                          <DropdownMenu.Item onclick={() => startEdit(account)}>{m.btn_edit()}</DropdownMenu.Item>
                        {/if}
                        {#if account.is_archived}
                          <DropdownMenu.Item onclick={() => handleUnarchive(account.id, account.full_name)}>{m.btn_unarchive()}</DropdownMenu.Item>
                        {:else}
                          <DropdownMenu.Item onclick={() => handleArchive(account.id, account.full_name)}>{m.btn_archive()}</DropdownMenu.Item>
                        {/if}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
          {#if paddingBottom > 0}
            <tr><td style="height: {paddingBottom}px;" colspan="4"></td></tr>
          {/if}
        </Table.Body>
      </Table.Root>
      </div>
    </Card.Root>
  {/if}
</div>

<!-- Merge confirmation dialog -->
<Dialog.Root bind:open={mergeDialogOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{m.dialog_merge_account()}</Dialog.Title>
      <Dialog.Description>
        {#if editingId}
          {@const source = store.accounts.find((a) => a.id === editingId)}
          {@const target = pendingMergeTarget ?? matchedExisting}
          {m.dialog_merge_account_desc({ source: source?.full_name ?? "", target: target?.full_name ?? "" })}
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (mergeDialogOpen = false)} disabled={merging}>{m.btn_cancel()}</Button>
      <Button variant="destructive" onclick={confirmMerge} disabled={merging}>
        {merging ? m.state_merging() : m.btn_merge()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
