<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { v7 as uuidv7 } from "uuid";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
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
  import ExchangeEntryForm from "$lib/components/ExchangeEntryForm.svelte";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import MetadataEditor from "$lib/components/MetadataEditor.svelte";
  import { parseTags, serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import { EQUITY_TRADING } from "$lib/accounts/paths.js";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();

  const editingEntryId = $derived(page.url?.searchParams.get("edit") ?? null);
  const isEditMode = $derived(!!editingEntryId);

  let date = $state(new Date().toISOString().slice(0, 10));
  let description = $state("");
  let currency = $state("EUR");
  let tags = $state<string[]>([]);
  let entryLinks = $state<string[]>([]);
  let entryMetadata = $state<Record<string, string>>({});
  let tagSuggestions = $state<string[]>([]);
  let linkSuggestions = $state<string[]>([]);
  let metaKeySuggestions = $state<string[]>([]);
  let editLoading = $state(false);

  type EntryMode = "simple" | "exchange";
  let entryMode = $state<EntryMode>("simple");
  let fromCurrency = $state("EUR");
  let toCurrency = $state("BTC");
  let fromAmount = $state("");
  let toAmount = $state("");
  let fromAccount = $state("");
  let toAccount = $state("");

  interface FormLine {
    key: string;
    accountPath: string;
    debit: string;
    credit: string;
    _autoDebit: boolean;
    _autoCredit: boolean;
  }

  let lines = $state<FormLine[]>([
    { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false },
    { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false },
  ]);

  const accountNames = $derived(accountStore.postable.map((a) => a.full_name));

  function addLine() {
    lines = [...lines, { key: uuidv7(), accountPath: "", debit: "", credit: "", _autoDebit: false, _autoCredit: false }];
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

  const isExchangeValid = $derived(
    fromCurrency !== toCurrency &&
    parseFloat(fromAmount) > 0 &&
    parseFloat(toAmount) > 0 &&
    fromAccount.trim() !== "" &&
    toAccount.trim() !== "",
  );

  const exchangePreviewLines = $derived.by(() => {
    const fAmt = parseFloat(fromAmount);
    const tAmt = parseFloat(toAmount);
    if (!fAmt || !tAmt || fAmt <= 0 || tAmt <= 0) return [];
    return [
      { account: fromAccount || "?", currency: fromCurrency, amount: -fAmt },
      { account: toAccount || "?", currency: toCurrency, amount: tAmt },
      { account: EQUITY_TRADING, currency: fromCurrency, amount: fAmt },
      { account: EQUITY_TRADING, currency: toCurrency, amount: -tAmt },
    ];
  });

  const exchangeBalances = $derived(
    exchangePreviewLines.reduce((acc, l) => {
      acc[l.currency] = (acc[l.currency] ?? 0) + l.amount;
      return acc;
    }, {} as Record<string, number>),
  );

  let submitting = $state(false);

  const canSubmit = $derived(
    (entryMode === "simple" ? isBalanced : isExchangeValid) &&
    description.trim() !== "" &&
    !submitting,
  );

  async function prefillFromEntry(entryId: string) {
    editLoading = true;
    try {
      const backend = getBackend();
      const [entryResult, metaResult, linksResult] = await Promise.all([
        backend.getJournalEntry(entryId),
        backend.getMetadata(entryId).catch(() => ({}) as Record<string, string>),
        backend.getEntryLinks(entryId).catch(() => [] as string[]),
      ]);
      if (!entryResult) {
        toast.error("Entry not found");
        editLoading = false;
        return;
      }
      const [origEntry, origItems] = entryResult;

      if (origEntry.status === "voided") {
        toast.error("Cannot edit a voided entry");
        goto("/journal");
        return;
      }

      date = origEntry.date;
      description = origEntry.description;

      // Detect exchange entries: exactly 4 items, 2 currencies, Equity:Trading lines
      const uniqueCurrencies = new Set(origItems.map((i) => i.currency));
      const equityLines = origItems.filter((i) => {
        const acct = accountStore.accounts.find((a) => a.id === i.account_id);
        return acct?.full_name === EQUITY_TRADING || acct?.full_name?.startsWith("Equity:Trading:");
      });
      const nonEquityLines = origItems.filter((i) => {
        const acct = accountStore.accounts.find((a) => a.id === i.account_id);
        return acct?.full_name !== EQUITY_TRADING && !acct?.full_name?.startsWith("Equity:Trading:");
      });

      if (origItems.length === 4 && uniqueCurrencies.size === 2 && equityLines.length === 2 && nonEquityLines.length === 2) {
        // Exchange entry detected — populate exchange mode
        entryMode = "exchange";
        const spent = nonEquityLines.find((i) => parseFloat(i.amount) < 0);
        const received = nonEquityLines.find((i) => parseFloat(i.amount) > 0);
        if (spent && received) {
          const spentAcct = accountStore.accounts.find((a) => a.id === spent.account_id);
          const rcvdAcct = accountStore.accounts.find((a) => a.id === received.account_id);
          fromCurrency = spent.currency;
          fromAmount = Math.abs(parseFloat(spent.amount)).toString();
          fromAccount = spentAcct?.full_name ?? spent.account_id;
          toCurrency = received.currency;
          toAmount = parseFloat(received.amount).toString();
          toAccount = rcvdAcct?.full_name ?? received.account_id;
        }
      } else {
        // Simple entry — use existing logic
        entryMode = "simple";

        // Determine currency from first line item
        if (origItems.length > 0) {
          currency = origItems[0].currency;
        }

        // Convert line items to form lines
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
      }

      // Set metadata (excluding edit provenance keys from original)
      const filteredMeta: Record<string, string> = {};
      for (const [k, v] of Object.entries(metaResult)) {
        if (k === TAGS_META_KEY) {
          tags = parseTags(v);
        } else if (!k.startsWith("edit:")) {
          filteredMeta[k] = v;
        }
      }
      entryMetadata = filteredMeta;

      entryLinks = linksResult;
    } finally {
      editLoading = false;
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    submitting = true;

    const entryId = uuidv7();
    const today = new Date().toISOString().slice(0, 10);

    let needsReload = false;
    const items: LineItem[] = [];

    if (entryMode === "exchange") {
      const fAmt = parseFloat(fromAmount);
      const tAmt = parseFloat(toAmount);
      const rawLines = [
        { account: fromAccount, currency: fromCurrency, amount: (-fAmt).toString() },
        { account: toAccount, currency: toCurrency, amount: tAmt.toString() },
        { account: EQUITY_TRADING, currency: fromCurrency, amount: fAmt.toString() },
        { account: EQUITY_TRADING, currency: toCurrency, amount: (-tAmt).toString() },
      ];

      for (const l of rawLines) {
        const existingBefore = accountStore.active.find((a) => a.full_name === l.account);
        const accountId = await ensureAccountHierarchy(l.account);
        if (!existingBefore) needsReload = true;
        items.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: accountId,
          currency: l.currency,
          amount: l.amount,
          lot_id: null,
        });
      }
    } else {
      const validLines = lines.filter((l) => l.accountPath && (l.debit || l.credit));

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
    }

    if (needsReload) await accountStore.load();

    if (editingEntryId) {
      // Edit mode: void original + post replacement atomically
      const entry: JournalEntry = {
        id: entryId,
        date,
        description,
        status: "confirmed",
        source: "system:edit",
        voided_by: null,
        created_at: today,
      };

      const metaToSave = { ...entryMetadata };
      if (tags.length > 0) metaToSave[TAGS_META_KEY] = serializeTags(tags);

      const result = await journalStore.edit(
        editingEntryId,
        entry,
        items,
        Object.keys(metaToSave).length > 0 ? metaToSave : undefined,
        entryLinks.length > 0 ? entryLinks : undefined,
      );

      if (result) {
        submitting = false;
        toast.success("Entry updated");
        goto(`/journal/${result.newEntryId}`);
      } else {
        submitting = false;
        toast.error(journalStore.error ?? "Failed to edit entry");
      }
    } else {
      // New entry mode
      const entry: JournalEntry = {
        id: entryId,
        date,
        description,
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: today,
      };

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

    if (editingEntryId) {
      await prefillFromEntry(editingEntryId);
    }
  });
</script>

<div class="space-y-6">
  {#if editLoading}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Loading entry...</p>
      </Card.Content>
    </Card.Root>
  {:else}
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

          {#if entryMode === "simple"}
            <div class="space-y-2">
              <span class="text-sm font-medium">Currency</span>
              <Select.Root type="single" bind:value={currency}>
                <Select.Trigger class="w-full max-w-[200px]">
                  {@const cur = accountStore.currencies.find((c) => c.code === currency)}
                  {cur ? `${cur.code} - ${cur.name}` : currency}
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
          {/if}

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <label class="text-sm font-medium">Tags</label>
              <TagInput tags={tags} onchange={(t) => { tags = t; }} suggestions={tagSuggestions} />
            </div>
            <div class="space-y-2">
              <label class="text-sm font-medium">Links</label>
              <LinkInput links={entryLinks} onchange={(l) => { entryLinks = l; }} suggestions={linkSuggestions} />
            </div>
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
        <Tabs.Root bind:value={entryMode}>
        <div class="flex items-start justify-between gap-4 px-6">
          <div class="space-y-1.5">
            <div class="leading-none font-semibold">Line Items</div>
            <p class="text-muted-foreground text-sm">
              {entryMode === "simple"
                ? "Debits must equal credits for the entry to balance."
                : "Define a currency exchange — 4 balanced line items will be generated."}
            </p>
          </div>
          <Tabs.List class="shrink-0">
            <Tabs.Trigger value="simple">Simple</Tabs.Trigger>
            <Tabs.Trigger value="exchange">Exchange</Tabs.Trigger>
          </Tabs.List>
        </div>
        <Card.Content>
          {#if entryMode === "simple"}
            <div class="space-y-2">
              <div class="grid grid-cols-[1fr_100px_100px_40px] gap-2 text-sm font-medium text-muted-foreground">
                <span>Account</span>
                <span class="text-right">Debit</span>
                <span class="text-right">Credit</span>
                <span></span>
              </div>

              {#each lines as line, i (line.key)}
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
                    oninput={() => handleDebitInput(i)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    bind:value={line.credit}
                    class="text-right font-mono"
                    oninput={() => handleCreditInput(i)}
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
                <span class="ml-2 font-mono font-medium {isBalanced ? 'text-positive' : 'text-negative'}">
                  {Math.abs(totalDebit - totalCredit).toFixed(2)}
                </span>
              </div>
            </div>
          {:else}
            <ExchangeEntryForm
              currencies={accountStore.currencies}
              accountNames={accountNames}
              bind:fromCurrency
              bind:toCurrency
              bind:fromAmount
              bind:toAmount
              bind:fromAccount
              bind:toAccount
            />

            {#if exchangePreviewLines.length > 0}
              <div class="mt-4 border-t pt-4 space-y-2">
                <span class="text-sm font-medium text-muted-foreground">Generated line items</span>
                <div class="rounded-md border">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b text-muted-foreground">
                        <th class="text-left px-3 py-2 font-medium">Account</th>
                        <th class="text-left px-3 py-2 font-medium">Currency</th>
                        <th class="text-right px-3 py-2 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each exchangePreviewLines as line}
                        <tr class="border-b last:border-b-0">
                          <td class="px-3 py-2 font-mono text-xs">{line.account}</td>
                          <td class="px-3 py-2">{line.currency}</td>
                          <td class="px-3 py-2 text-right font-mono {line.amount < 0 ? 'text-negative' : 'text-positive'}">
                            {line.amount < 0 ? "" : "+"}{line.amount}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                <div class="flex gap-4 text-xs text-muted-foreground">
                  {#each Object.entries(exchangeBalances) as [cur, bal]}
                    <span>
                      {cur}: {bal.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}
                      <span class="{Math.abs(bal) < 0.0001 ? 'text-positive' : 'text-negative'}">
                        {Math.abs(bal) < 0.0001 ? "✓" : "✗"}
                      </span>
                    </span>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        </Card.Content>
        </Tabs.Root>
        <Card.Footer class="flex justify-end gap-2">
          <Button variant="outline" type="button" href="/journal">Cancel</Button>
          <Button type="submit" disabled={!canSubmit}>
            {#if submitting}
              {isEditMode ? "Saving..." : "Posting..."}
            {:else}
              {isEditMode ? "Save Changes" : "Post Entry"}
            {/if}
          </Button>
        </Card.Footer>
      </Card.Root>
    </form>
  {/if}
</div>
