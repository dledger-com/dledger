<script lang="ts">
  import { v7 as uuidv7 } from "uuid";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { getBackend } from "$lib/backend.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { toast } from "svelte-sonner";
  import { inferAccountType } from "$lib/browser-etherscan.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import LinkInput from "$lib/components/LinkInput.svelte";
  import MetadataEditor from "$lib/components/MetadataEditor.svelte";
  import AccountCombobox from "$lib/components/AccountCombobox.svelte";
  import { parseTags, serializeTags, TAGS_META_KEY, NOTE_META_KEY } from "$lib/utils/tags.js";
  import type { JournalEntry, LineItem, Account } from "$lib/types/index.js";
  import { invalidate } from "$lib/data/invalidation.js";
  import { AlertDialog } from "bits-ui";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Plus from "lucide-svelte/icons/plus";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import ExchangeEntryForm from "$lib/components/ExchangeEntryForm.svelte";
  import { EQUITY_TRADING } from "$lib/accounts/paths.js";
  import * as m from "$paraglide/messages.js";

  interface Props {
    open: boolean;
    mode: "new" | "edit";
    entryId?: string | null;
    onsaved?: (newId: string) => void;
    onclose?: () => void;
  }

  let { open = $bindable(), mode, entryId = $bindable(null), onsaved, onclose }: Props = $props();

  const journalStore = new JournalStore();
  const accountStore = new AccountStore();

  // ── Responsive ──
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    isMobile = mq.matches;
    const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  // ── Form state ──
  let formDate = $state(new Date().toISOString().slice(0, 10));
  let formDescription = $state("");
  let formCurrency = $state("EUR");
  let formTags = $state<string[]>([]);
  let formLinks = $state<string[]>([]);
  let formNote = $state("");
  let formMetadata = $state<Record<string, string>>({});
  let tagSuggestions = $state<string[]>([]);
  let formLinkSuggestions = $state<string[]>([]);
  let metaKeySuggestions = $state<string[]>([]);
  let editLoading = $state(false);
  let submitting = $state(false);

  // ── Exchange mode state ──
  let entryMode = $state<"simple" | "exchange">("simple");
  let fromCurrency = $state("EUR");
  let toCurrency = $state("BTC");
  let fromAmount = $state("");
  let toAmount = $state("");
  let fromAccount = $state("");
  let toAccount = $state("");

  // ── Dirty-state tracking ──
  let cleanSnapshot = $state("");
  let confirmDiscardOpen = $state(false);

  function takeSnapshot(): string {
    return JSON.stringify({
      formDate, formDescription, formCurrency, formTags, formLinks, formNote, formMetadata,
      lines: lines.map(l => ({ accountPath: l.accountPath, debit: l.debit, credit: l.credit })),
    });
  }

  const isDirty = $derived(cleanSnapshot !== "" && cleanSnapshot !== takeSnapshot());

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

  const isExchangeValid = $derived(
    fromCurrency !== toCurrency &&
    parseFloat(fromAmount) > 0 &&
    parseFloat(toAmount) > 0 &&
    fromAccount.trim() !== "" &&
    toAccount.trim() !== "",
  );

  const canPost = $derived(
    (entryMode === "simple" ? isBalanced : isExchangeValid) &&
    formDescription.trim() !== "" &&
    !submitting,
  );

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
        toast.error(m.error_entry_not_found());
        editLoading = false;
        return;
      }
      const [origEntry, origItems] = entryResult;

      if (origEntry.status === "voided") {
        toast.error(m.error_cannot_edit_voided());
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
      formNote = "";
      for (const [k, v] of Object.entries(metaResult)) {
        if (k === TAGS_META_KEY) {
          formTags = parseTags(v);
        } else if (k === NOTE_META_KEY) {
          formNote = v;
        } else if (!k.startsWith("edit:")) {
          filteredMeta[k] = v;
        }
      }
      formMetadata = filteredMeta;
      formLinks = linksResult;
      cleanSnapshot = takeSnapshot();
    } finally {
      editLoading = false;
    }
  }

  async function handleSubmit() {
    if (!canPost) return;
    submitting = true;

    const newEntryId = uuidv7();
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
          journal_entry_id: newEntryId,
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
    }

    if (needsReload) await accountStore.load();

    if (mode === "edit" && entryId) {
      const journalEntry: JournalEntry = {
        id: newEntryId, date: formDate, description: formDescription,
        status: "confirmed", source: "system:edit", voided_by: null, created_at: today,
      };
      const metaToSave = { ...formMetadata };
      if (formTags.length > 0) metaToSave[TAGS_META_KEY] = serializeTags(formTags);
      if (formNote) metaToSave[NOTE_META_KEY] = formNote;

      const result = await journalStore.edit(
        entryId, journalEntry, items,
        Object.keys(metaToSave).length > 0 ? metaToSave : undefined,
        formLinks.length > 0 ? formLinks : undefined,
      );

      if (result) {
        submitting = false;
        toast.success(m.toast_entry_updated());
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
        if (formNote) metaToSave[NOTE_META_KEY] = formNote;
        if (Object.keys(metaToSave).length > 0) {
          await getBackend().setMetadata(newEntryId, metaToSave);
        }
        if (formLinks.length > 0) {
          await getBackend().setEntryLinks(newEntryId, formLinks);
        }
        submitting = false;
        toast.success(m.toast_entry_posted());
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

    accountStore.load();

    if (mode === "edit" && entryId) {
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
      formDate = new Date().toISOString().slice(0, 10);
      formDescription = "";
      formCurrency = "EUR";
      formTags = [];
      formLinks = [];
      formNote = "";
      formMetadata = {};
      entryMode = "simple";
      fromCurrency = "EUR";
      toCurrency = "BTC";
      fromAmount = "";
      toAmount = "";
      fromAccount = "";
      toAccount = "";
      resetFormLines();
      cleanSnapshot = takeSnapshot();
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

  // Reset key when dialog closes
  $effect(() => {
    if (!open) {
      lastLoadedKey = "";
      cleanSnapshot = "";
      entryMode = "simple";
    }
  });

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function autoResizeAction(el: HTMLTextAreaElement) {
    autoResize(el);
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen && isDirty) {
      confirmDiscardOpen = true;
      return;
    }
    open = newOpen;
    if (!newOpen) onclose?.();
  }
</script>

<Dialog.Root open={open} onOpenChange={handleOpenChange}>
  <Dialog.Content
    showCloseButton={false}
    class={isMobile
      ? "h-[100dvh] max-h-[100dvh] w-full max-w-full rounded-none p-0 flex flex-col"
      : "max-w-2xl max-h-[90vh] p-0 flex flex-col"}
  >
    <Dialog.Header class="space-y-1 px-6 pt-6 pb-0">
      <Dialog.Title class="text-sm font-medium text-muted-foreground">
        {mode === "edit" ? m.dialog_edit_entry() : m.dialog_new_entry()}
      </Dialog.Title>
      <Input id="dialog-desc" bind:value={formDescription} placeholder="e.g. Monthly rent payment"
             class="text-base font-semibold border-none shadow-none px-0 h-auto focus-visible:ring-0" required />
    </Dialog.Header>

    <div class="flex-1 overflow-y-auto px-6 pb-4">
      {#if editLoading}
        <div class="py-8 text-center">
          <p class="text-sm text-muted-foreground">{m.state_loading()}</p>
        </div>
      {:else}
        <form id="journal-entry-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-4">
          <!-- Details -->
          <section>
            <h3 class="text-sm font-medium text-muted-foreground mb-2">{m.section_details()}</h3>
            <div class="space-y-3">
              <div class="space-y-1">
                <label for="dialog-date" class="text-sm font-medium">{m.label_date()}</label>
                <Input id="dialog-date" type="date" bind:value={formDate} required />
              </div>

              <div class="space-y-1">
                <span class="text-sm font-medium">{m.label_currency()}</span>
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
            </div>
          </section>

          <!-- Metadata -->
          <section>
            <h3 class="text-sm font-medium text-muted-foreground mb-2">{m.section_metadata()}</h3>
            <div class="space-y-3">
              <div class="space-y-1">
                <dt class="text-muted-foreground">{m.label_tags()}</dt>
                <dd><TagInput tags={formTags} onchange={(t) => { formTags = t; }} suggestions={tagSuggestions} /></dd>
              </div>
              <div class="space-y-1">
                <dt class="text-muted-foreground">{m.label_links()}</dt>
                <dd><LinkInput links={formLinks} onchange={(l) => { formLinks = l; }} suggestions={formLinkSuggestions} /></dd>
              </div>
              <div class="space-y-1">
                <dt class="text-muted-foreground">{m.label_note()}</dt>
                <dd>
                  <textarea
                    bind:value={formNote}
                    placeholder={m.placeholder_note()}
                    use:autoResizeAction
                    oninput={(e) => autoResize(e.currentTarget)}
                    class="w-full rounded border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus:border-primary resize-none overflow-y-auto min-h-[2lh] max-h-[12lh]"
                  ></textarea>
                </dd>
              </div>
              <MetadataEditor
                metadata={formMetadata}
                onchange={(m) => { formMetadata = m; }}
                keySuggestions={metaKeySuggestions}
              />
            </div>
          </section>

          <!-- Line Items -->
          <Tabs.Root bind:value={entryMode}>
            <section>
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium text-muted-foreground">{m.section_line_items()}</h3>
                <Tabs.List>
                  <Tabs.Trigger value="simple">{m.label_simple()}</Tabs.Trigger>
                  <Tabs.Trigger value="exchange">{m.label_exchange()}</Tabs.Trigger>
                </Tabs.List>
              </div>

              {#if entryMode === "simple"}
                <p class="text-xs text-muted-foreground mb-3">{m.error_debits_must_equal_credits()}</p>
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
                          <span class="text-xs text-muted-foreground">{m.label_debit()}</span>
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
                          <span class="text-xs text-muted-foreground">{m.label_credit()}</span>
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
                    <Plus class="h-4 w-4 mr-1" /> {m.btn_add_line()}
                  </Button>
                </div>

                <div class="mt-4 flex justify-end gap-6 border-t pt-3 text-sm">
                  <div>
                    <span class="text-muted-foreground">{m.label_debit()}:</span>
                    <span class="ml-1 font-mono font-medium">{totalDebit.toFixed(2)}</span>
                  </div>
                  <div>
                    <span class="text-muted-foreground">{m.label_credit()}:</span>
                    <span class="ml-1 font-mono font-medium">{totalCredit.toFixed(2)}</span>
                  </div>
                  <div>
                    <span class="text-muted-foreground">Diff:</span>
                    <span class="ml-1 font-mono font-medium {isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                      {Math.abs(totalDebit - totalCredit).toFixed(2)}
                    </span>
                  </div>
                </div>
              {:else}
                <ExchangeEntryForm
                  currencies={accountStore.currencies}
                  accountNames={accountNames}
                  bind:fromCurrency bind:toCurrency
                  bind:fromAmount bind:toAmount
                  bind:fromAccount bind:toAccount
                />
              {/if}
            </section>
          </Tabs.Root>
        </form>
      {/if}
    </div>

    <Dialog.Footer class="px-6 pb-6 pt-2 border-t">
      <Button variant="outline" type="button" onclick={() => { if (isDirty) { confirmDiscardOpen = true; return; } open = false; onclose?.(); }}>{m.btn_cancel()}</Button>
      <Button type="submit" form="journal-entry-form" disabled={!canPost}>
        {#if submitting}
          {mode === "edit" ? m.state_saving() : m.state_posting()}
        {:else}
          {mode === "edit" ? m.btn_save_changes() : m.btn_post_entry()}
        {/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>

  {#if confirmDiscardOpen}
    <AlertDialog.Root bind:open={confirmDiscardOpen}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/50" />
        <AlertDialog.Content class="fixed top-1/2 left-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 bg-background rounded-lg border p-6 shadow-lg max-w-sm w-full">
          <AlertDialog.Title class="text-lg font-semibold">{m.dialog_discard_changes()}</AlertDialog.Title>
          <AlertDialog.Description class="text-sm text-muted-foreground mt-2">
            {m.dialog_discard_desc()}
          </AlertDialog.Description>
          <div class="flex justify-end gap-2 mt-4">
            <AlertDialog.Cancel
              class="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 border border-input bg-background hover:bg-accent hover:text-accent-foreground"
            >
              {m.btn_keep_editing()}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              class="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onclick={() => { confirmDiscardOpen = false; open = false; onclose?.(); }}
            >
              {m.btn_discard()}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}
</Dialog.Root>
