<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { v7 as uuidv7 } from "uuid";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import type { Account, JournalEntry, LineItem } from "$lib/types/index.js";
  import { getBackend } from "$lib/backend.js";
  import { inferAccountType } from "$lib/browser-etherscan.js";
  import { toast } from "svelte-sonner";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Plus from "lucide-svelte/icons/plus";
  import AccountCombobox from "$lib/components/AccountCombobox.svelte";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import MetadataEditor from "$lib/components/MetadataEditor.svelte";
  import { serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();

  let date = $state(new Date().toISOString().slice(0, 10));
  let description = $state("");
  let currency = $state("EUR");
  let tags = $state<string[]>([]);
  let entryLinks = $state<string[]>([]);
  let entryMetadata = $state<Record<string, string>>({});
  let tagSuggestions = $state<string[]>([]);
  let linkSuggestions = $state<string[]>([]);
  let metaKeySuggestions = $state<string[]>([]);

  interface FormLine {
    key: string;
    accountPath: string;
    debit: string;
    credit: string;
  }

  let lines = $state<FormLine[]>([
    { key: uuidv7(), accountPath: "", debit: "", credit: "" },
    { key: uuidv7(), accountPath: "", debit: "", credit: "" },
  ]);

  const accountNames = $derived(accountStore.postable.map((a) => a.full_name));

  function addLine() {
    lines = [...lines, { key: uuidv7(), accountPath: "", debit: "", credit: "" }];
  }

  async function ensureAccountHierarchy(fullName: string): Promise<string> {
    // Check existing accounts first
    const existing = accountStore.active.find((a) => a.full_name === fullName);
    if (existing) return existing.id;

    const backend = getBackend();
    const parts = fullName.split(":");
    let parentId: string | null = null;

    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(":");
      const cached = accountStore.accounts.find((a) => a.full_name === path);
      if (cached) {
        parentId = cached.id;
        continue;
      }
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

  function removeLine(key: string) {
    if (lines.length <= 2) return;
    lines = lines.filter((l) => l.key !== key);
  }

  const totalDebit = $derived(
    lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0),
  );
  const totalCredit = $derived(
    lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0),
  );
  const isBalanced = $derived(
    Math.abs(totalDebit - totalCredit) < 0.001 && totalDebit > 0,
  );

  let submitting = $state(false);

  async function handleSubmit() {
    if (!isBalanced) return;
    submitting = true;

    const entryId = uuidv7();
    const today = new Date().toISOString().slice(0, 10);

    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      status: "confirmed",
      source: "manual",
      voided_by: null,
      created_at: today,
    };

    const validLines = lines.filter((l) => l.accountPath && (l.debit || l.credit));

    // Resolve account paths to IDs (creating new accounts as needed)
    let needsReload = false;
    const items: LineItem[] = [];
    for (const l of validLines) {
      const existingBefore = accountStore.active.find((a) => a.full_name === l.accountPath);
      const accountId = await ensureAccountHierarchy(l.accountPath);
      if (!existingBefore) needsReload = true;

      const debitAmount = parseFloat(l.debit) || 0;
      const creditAmount = parseFloat(l.credit) || 0;
      // Positive = debit, negative = credit
      const amount = debitAmount > 0 ? debitAmount : -creditAmount;
      items.push({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: accountId,
        currency,
        amount: amount.toString(),
        lot_id: null,
      });
    }

    if (needsReload) await accountStore.load();

    const ok = await journalStore.post(entry, items);

    if (ok) {
      // Save tags + metadata
      const metaToSave = { ...entryMetadata };
      if (tags.length > 0) metaToSave[TAGS_META_KEY] = serializeTags(tags);
      if (Object.keys(metaToSave).length > 0) {
        await getBackend().setMetadata(entryId, metaToSave);
      }
      // Save links
      if (entryLinks.length > 0) {
        await getBackend().setEntryLinks(entryId, entryLinks);
      }
      submitting = false;
      toast.success("Journal entry posted");
      goto("/journal");
    } else {
      submitting = false;
      toast.error(journalStore.error ?? "Failed to post entry");
    }
  }

  onMount(async () => {
    await accountStore.load();
    try {
      const backend = getBackend();
      [tagSuggestions, linkSuggestions, metaKeySuggestions] = await Promise.all([
        backend.getAllTagValues(),
        backend.getAllLinkNames(),
        backend.getAllMetadataKeys(),
      ]);
    } catch {
      // Non-critical
    }
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">New Journal Entry</h1>
    <p class="text-muted-foreground">Create a new double-entry transaction.</p>
  </div>

  <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    <Card.Root>
      <Card.Header>
        <Card.Title>Entry Details</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-2">
            <label for="date" class="text-sm font-medium">Date</label>
            <Input id="date" type="date" bind:value={date} required />
          </div>
          <div class="space-y-2 sm:col-span-2">
            <label for="desc" class="text-sm font-medium">Description</label>
            <Input id="desc" bind:value={description} placeholder="e.g. Monthly rent payment" required />
          </div>
        </div>

        <div class="space-y-2">
          <label for="currency" class="text-sm font-medium">Currency</label>
          <select id="currency" bind:value={currency} class="flex h-9 w-full max-w-[200px] rounded-md border border-input bg-transparent px-3 py-1 text-sm">
            {#each accountStore.currencies as c}
              <option value={c.code}>{c.code} - {c.name}</option>
            {/each}
            {#if accountStore.currencies.length === 0}
              <option value="EUR">EUR</option>
            {/if}
          </select>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium">Tags</label>
          <TagInput tags={tags} onchange={(t) => { tags = t; }} suggestions={tagSuggestions} />
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium">Links</label>
          <LinkInput links={entryLinks} onchange={(l) => { entryLinks = l; }} suggestions={linkSuggestions} />
        </div>

        <details class="space-y-2">
          <summary class="text-sm font-medium cursor-pointer text-muted-foreground">Metadata</summary>
          <MetadataEditor
            metadata={entryMetadata}
            onchange={(m) => { entryMetadata = m; }}
            keySuggestions={metaKeySuggestions}
            class="mt-2"
          />
        </details>
      </Card.Content>
    </Card.Root>

    <Card.Root class="mt-4">
      <Card.Header>
        <Card.Title>Line Items</Card.Title>
        <Card.Description>Debits must equal credits for the entry to balance.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="space-y-2">
          <div class="grid grid-cols-[1fr_100px_100px_40px] gap-2 text-sm font-medium text-muted-foreground">
            <span>Account</span>
            <span class="text-right">Debit</span>
            <span class="text-right">Credit</span>
            <span></span>
          </div>

          {#each lines as line (line.key)}
            <div class="grid grid-cols-[1fr_100px_100px_40px] gap-2 items-center">
              <AccountCombobox
                value={line.accountPath}
                accounts={accountNames}
                variant="input"
                placeholder="Select account..."
                onchange={(v) => { line.accountPath = v; }}
              />
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                bind:value={line.debit}
                class="text-right font-mono"
                oninput={() => { if (line.debit) line.credit = ""; }}
              />
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                bind:value={line.credit}
                class="text-right font-mono"
                oninput={() => { if (line.credit) line.debit = ""; }}
              />
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
          {/each}

          <Button variant="outline" size="sm" type="button" onclick={addLine} class="mt-2">
            <Plus class="h-4 w-4 mr-1" /> Add Line
          </Button>
        </div>

        <div class="mt-4 flex justify-end gap-6 border-t pt-4 text-sm">
          <div>
            <span class="text-muted-foreground">Total Debit:</span>
            <span class="ml-2 font-mono font-medium">{totalDebit.toFixed(2)}</span>
          </div>
          <div>
            <span class="text-muted-foreground">Total Credit:</span>
            <span class="ml-2 font-mono font-medium">{totalCredit.toFixed(2)}</span>
          </div>
          <div>
            <span class="text-muted-foreground">Difference:</span>
            <span class="ml-2 font-mono font-medium {isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
              {Math.abs(totalDebit - totalCredit).toFixed(2)}
            </span>
          </div>
        </div>
      </Card.Content>
      <Card.Footer class="flex justify-end gap-2">
        <Button variant="outline" type="button" href="/journal">Cancel</Button>
        <Button type="submit" disabled={!isBalanced || !description.trim() || submitting}>
          {submitting ? "Posting..." : "Post Entry"}
        </Button>
      </Card.Footer>
    </Card.Root>
  </form>
</div>
