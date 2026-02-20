<script lang="ts">
  import { onMount } from "svelte";
  import { v7 as uuidv7 } from "uuid";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import type { Account, AccountType } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import Search from "lucide-svelte/icons/search";
  import X from "lucide-svelte/icons/x";

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

  const filteredAccounts = $derived.by(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return store.active;
    return store.active.filter(
      (a) =>
        a.full_name.toLowerCase().includes(term) ||
        a.account_type.toLowerCase().includes(term),
    );
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
    <div class="relative w-full sm:w-auto sm:max-w-sm order-last sm:order-none">
      <Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input type="text" placeholder="Filter accounts..." bind:value={searchTerm} class="pl-9 pr-9"
        onkeydown={(e) => { if (e.key === 'Escape') searchTerm = ''; }} />
      {#if searchTerm}
        <button type="button" onclick={() => (searchTerm = "")}
          class="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
          <X class="size-4" />
        </button>
      {/if}
    </div>
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
            <Table.Head>Full Name</Table.Head>
            <Table.Head>Type</Table.Head>
            <Table.Head class="hidden md:table-cell">Postable</Table.Head>
            <Table.Head class="text-right hidden sm:table-cell">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each filteredAccounts as account (account.id)}
            <Table.Row>
              <Table.Cell>
                <a href="/accounts/{account.id}" class="font-medium hover:underline">{account.full_name}</a>
              </Table.Cell>
              <Table.Cell>
                <Badge variant="outline">{account.account_type}</Badge>
              </Table.Cell>
              <Table.Cell class="hidden md:table-cell">{account.is_postable ? "Yes" : "No"}</Table.Cell>
              <Table.Cell class="text-right hidden sm:table-cell">
                <Button variant="ghost" size="sm" onclick={() => handleArchive(account.id, account.full_name)}>
                  Archive
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {/if}
</div>
