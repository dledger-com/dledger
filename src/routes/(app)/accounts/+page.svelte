<script lang="ts">
  import { onMount, tick } from "svelte";
  import { v7 as uuidv7 } from "uuid";
  import * as Card from "$lib/components/ui/card/index.js";
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
  import type { Account, AccountType } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import ChevronDown from "lucide-svelte/icons/chevron-down";

  const store = new AccountStore();
  let dialogOpen = $state(false);

  // Form state
  let formName = $state("");
  let formFullName = $state("");
  let formType = $state<AccountType>("asset");
  let formParentId = $state<string | null>(null);
  let formIsPostable = $state(true);

  const accountTypes: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

  let searchTerm = $state("");

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
  const parentIds = $derived(
    new Set(store.active.filter(a => a.parent_id !== null).map(a => a.parent_id!))
  );

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
    if (!trimmed) return "Name is required";
    if (!trimmed.includes(":")) return "Must contain at least two segments (e.g. Assets:Bank)";
    const prefixes = TYPE_PREFIXES[account.account_type];
    if (!prefixes.some((p) => trimmed.startsWith(p))) {
      return `Must start with ${prefixes[0]}`;
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
      toast.success(`Account "${editFullName.trim()}" updated`);
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
      toast.success(`Merged "${account?.full_name}" into "${mergeTarget.full_name}" (${moved} items moved)`);
      cancelEdit();
    } else {
      toast.error(store.error ?? "Failed to merge accounts");
    }
  }

  const filteredAccounts = $derived.by(() => {
    const accounts = store.active;
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

  function resetForm() {
    formName = "";
    formFullName = "";
    formType = "asset";
    formParentId = null;
    formIsPostable = true;
  }

  async function handleCreate() {
    const today = new Date().toISOString().slice(0, 10);
    const account: Account = {
      id: uuidv7(),
      parent_id: formParentId,
      account_type: formType,
      name: formName,
      full_name: formFullName || formName,
      allowed_currencies: [],
      is_postable: formIsPostable,
      is_archived: false,
      created_at: today,
    };

    const ok = await store.create(account);
    if (ok) {
      toast.success(`Account "${account.full_name}" created`);
      dialogOpen = false;
      resetForm();
    } else {
      toast.error(store.error ?? "Failed to create account");
    }
  }

  async function handleArchive(id: string, name: string) {
    const ok = await store.archive(id);
    if (ok) {
      toast.success(`Account "${name}" archived`);
    } else {
      toast.error(store.error ?? "Failed to archive account");
    }
  }

  onMount(() => store.load());
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="shrink-0">
      <h1 class="text-2xl font-bold tracking-tight">Chart of Accounts</h1>
      <p class="text-muted-foreground hidden sm:block">Manage your account structure and hierarchy.</p>
    </div>
    <ListFilter bind:value={searchTerm} placeholder="Filter accounts..." class="order-last sm:order-none" />
    <Dialog.Root bind:open={dialogOpen}>
      <Dialog.Trigger>
        {#snippet child({ props })}
          <Button {...props}>New Account</Button>
        {/snippet}
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>Create Account</Dialog.Title>
          <Dialog.Description>Add a new account to your chart of accounts.</Dialog.Description>
        </Dialog.Header>
        <form onsubmit={(e) => { e.preventDefault(); handleCreate(); }} class="space-y-4">
          <div class="space-y-2">
            <label for="name" class="text-sm font-medium">Name</label>
            <Input id="name" bind:value={formName} placeholder="e.g. Checking" required />
          </div>
          <div class="space-y-2">
            <label for="fullName" class="text-sm font-medium">Full Name (path)</label>
            <Input id="fullName" bind:value={formFullName} placeholder="e.g. Assets:Bank:Checking" />
          </div>
          <div class="space-y-2">
            <label for="type" class="text-sm font-medium">Type</label>
            <select id="type" bind:value={formType} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
              {#each accountTypes as t}
                <option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              {/each}
            </select>
          </div>
          <div class="space-y-2">
            <label for="parent" class="text-sm font-medium">Parent Account</label>
            <select id="parent" bind:value={formParentId} class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
              <option value={null}>None (top-level)</option>
              {#each store.accounts.filter(a => !a.is_postable || a.account_type === formType) as acc}
                <option value={acc.id}>{acc.full_name}</option>
              {/each}
            </select>
          </div>
          <div class="flex items-center gap-2">
            <Switch id="postable" bind:checked={formIsPostable} />
            <label for="postable" class="text-sm font-medium">Postable (can receive transactions)</label>
          </div>
          <Dialog.Footer>
            <Button type="submit" disabled={!formName.trim()}>Create</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  </div>

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
  {:else if store.active.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No accounts configured yet. Add your first account to build your chart of accounts.
        </p>
      </Card.Content>
    </Card.Root>
  {:else if filteredAccounts.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No accounts match "{searchTerm}".
        </p>
        <div class="flex justify-center mt-2">
          <Button variant="outline" size="sm" onclick={() => (searchTerm = "")}>Clear search</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Account</Table.Head>
            <Table.Head>Type</Table.Head>
            <Table.Head class="hidden md:table-cell">Postable</Table.Head>
            <Table.Head class="text-right hidden sm:table-cell">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each filteredAccounts as account (account.id)}
            {#if editingId === account.id}
              <Table.Row
                class={hoveredAncestorIds.has(account.id) ? "bg-muted/30" : ""}
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
                              <Command.Group heading="Suggestions">
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
                      <p class="text-xs text-yellow-600 dark:text-yellow-400">Will merge into "{(pendingMergeTarget ?? matchedExisting)?.full_name}"</p>
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
                <Table.Cell class="text-right hidden sm:table-cell">
                  <div class="flex items-center justify-end gap-1">
                    <Button
                      variant={isMerge ? "destructive" : "ghost"}
                      size="sm"
                      onclick={saveEdit}
                      disabled={!!editError || !editHasChanges || editSaving}
                    >
                      {#if editSaving}
                        Saving...
                      {:else if isMerge}
                        Merge
                      {:else}
                        Save
                      {/if}
                    </Button>
                    <Button variant="ghost" size="sm" onclick={cancelEdit} disabled={editSaving}>
                      Cancel
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row
                class={hoveredAncestorIds.has(account.id) ? "bg-muted/30" : ""}
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
                <Table.Cell class="hidden md:table-cell">{account.is_postable ? "Yes" : "No"}</Table.Cell>
                <Table.Cell class="text-right hidden sm:table-cell">
                  <div class="flex items-center justify-end gap-1">
                    {#if account.parent_id !== null}
                      <Button variant="ghost" size="sm" onclick={() => startEdit(account)}>
                        Edit
                      </Button>
                    {/if}
                    <Button variant="ghost" size="sm" onclick={() => handleArchive(account.id, account.full_name)}>
                      Archive
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {/if}
</div>

<!-- Merge confirmation dialog -->
<Dialog.Root bind:open={mergeDialogOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Merge Account?</Dialog.Title>
      <Dialog.Description>
        {#if editingId}
          {@const source = store.accounts.find((a) => a.id === editingId)}
          {@const target = pendingMergeTarget ?? matchedExisting}
          Move all transactions from "{source?.full_name}" into "{target?.full_name}", then delete "{source?.full_name}". This cannot be undone.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (mergeDialogOpen = false)} disabled={merging}>Cancel</Button>
      <Button variant="destructive" onclick={confirmMerge} disabled={merging}>
        {merging ? "Merging..." : "Merge"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
