<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
  import Check from "lucide-svelte/icons/check";
  import { cn } from "$lib/utils.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import type { Account, JournalEntry } from "$lib/types/index.js";
  import {
    postOpeningBalanceEntry,
    entryCostEUR,
    invalidateFrenchTaxChainFromYear,
  } from "$lib/utils/opening-balance.js";
  import { invalidate } from "$lib/data/invalidation.js";

  type Props = {
    open: boolean;
    /** Pre-fill costEUR (used by the migration banner from the legacy setting). */
    prefillCostEUR?: string;
    /** Editing an existing opening-balance entry. When set, the form is pre-populated
     *  from this entry; on submit the old entry is voided and a new one posted. */
    editingEntry?: { entry: JournalEntry; quantity: string; currency: string; accountId: string } | null;
    onClose: () => void;
    onSaved: () => void;
  };

  let { open = $bindable(), prefillCostEUR, editingEntry, onClose, onSaved }: Props = $props();

  let allAccounts = $state<Account[]>([]);
  let assetAccounts = $derived(allAccounts.filter(a => a.account_type === "asset" && a.is_postable && !a.is_archived));

  let formDate = $state("");
  let formAccountId = $state<string | null>(null);
  let formCurrency = $state("");
  let formQuantity = $state("");
  let formCostEUR = $state("");
  let formNote = $state("");
  let accountPopoverOpen = $state(false);
  let saving = $state(false);

  // Populate / reset form whenever the dialog opens.
  $effect(() => {
    if (!open) return;
    // Async-load accounts once per open
    getBackend().listAccounts().then(accs => { allAccounts = accs; });

    if (editingEntry) {
      formDate = editingEntry.entry.date;
      formAccountId = editingEntry.accountId;
      formCurrency = editingEntry.currency;
      formQuantity = editingEntry.quantity;
      formCostEUR = entryCostEUR(editingEntry.entry);
      try {
        const data = JSON.parse(editingEntry.entry.description_data || "{}");
        formNote = data.note ?? "";
      } catch { formNote = ""; }
    } else {
      // Default to Dec 31 of the year before today.
      const y = new Date().getFullYear() - 1;
      formDate = `${y}-12-31`;
      formAccountId = null;
      formCurrency = "";
      formQuantity = "";
      formCostEUR = prefillCostEUR ?? "";
      formNote = "";
    }
  });

  const selectedAccountName = $derived(
    assetAccounts.find(a => a.id === formAccountId)?.full_name ?? "Select an asset account…"
  );

  // When account is picked and currency is blank, try to infer from the account name
  // (e.g., "Assets:Crypto:Coinbase:BTC" → "BTC").
  $effect(() => {
    if (formAccountId && !formCurrency.trim()) {
      const acc = assetAccounts.find(a => a.id === formAccountId);
      if (acc) {
        const last = acc.full_name.split(":").at(-1) ?? "";
        if (/^[A-Z0-9]{2,10}$/.test(last)) formCurrency = last;
      }
    }
  });

  const canSubmit = $derived(
    formDate.trim() !== "" &&
    formAccountId !== null &&
    formCurrency.trim() !== "" &&
    formQuantity.trim() !== "" &&
    !isNaN(parseFloat(formQuantity)) &&
    parseFloat(formQuantity) !== 0
  );

  async function handleSubmit() {
    if (!canSubmit) return;
    saving = true;
    try {
      const backend = getBackend();
      // For edits: void the old entry first. Chain invalidation must use the LOWER
      // of (old date, new date) so moves to an earlier year are caught.
      if (editingEntry) {
        const oldDate = editingEntry.entry.date;
        const newDate = formDate;
        const earlier = oldDate < newDate ? oldDate : newDate;
        await backend.voidJournalEntry(editingEntry.entry.id);
        await invalidateFrenchTaxChainFromYear(backend, earlier);
      }

      await postOpeningBalanceEntry(backend, {
        date: formDate,
        positions: [{
          accountId: formAccountId!,
          currency: formCurrency.trim().toUpperCase(),
          quantity: formQuantity.trim(),
        }],
        costEUR: formCostEUR.trim() || undefined,
        note: formNote.trim() || undefined,
      });

      invalidate("journal", "accounts", "reports");
      toast.success(editingEntry ? "Opening balance updated" : "Opening balance added");
      onSaved();
      open = false;
    } catch (e) {
      toast.error(`Failed to save opening balance: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      saving = false;
    }
  }

</script>

<Dialog.Root bind:open onOpenChange={(v) => { if (!v) onClose(); }}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{editingEntry ? "Edit opening balance" : "Add pre-dledger acquisition"}</Dialog.Title>
      <Dialog.Description>
        Record a crypto position you held before dledger started tracking, with the EUR cost you paid for it.
        This entry appears in your journal and contributes to column A on form 2086.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3 py-2">
      <div class="space-y-1">
        <label for="ob-date" class="text-xs font-medium">Acquisition date</label>
        <Input id="ob-date" type="date" bind:value={formDate} class="w-44" />
        <p class="text-xs text-muted-foreground">Use a date before your first tracked transaction (e.g., Dec 31 of the year before).</p>
      </div>

      <div class="space-y-1">
        <label class="text-xs font-medium" for="ob-account-trigger">Asset account</label>
        <Popover.Root bind:open={accountPopoverOpen}>
          <Popover.Trigger>
            <Button id="ob-account-trigger" variant="outline" class="w-full justify-between font-normal">
              <span class="truncate">{selectedAccountName}</span>
              <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </Popover.Trigger>
          <Popover.Content class="w-[400px] p-0">
            <Command.Root>
              <Command.Input placeholder="Search asset accounts…" />
              <Command.List>
                <Command.Empty>No asset accounts found.</Command.Empty>
                <Command.Group>
                  {#each assetAccounts as acc (acc.id)}
                    <Command.Item
                      value={acc.full_name}
                      onSelect={() => { formAccountId = acc.id; accountPopoverOpen = false; }}
                    >
                      <Check class={cn("mr-2 h-4 w-4", formAccountId === acc.id ? "opacity-100" : "opacity-0")} />
                      <span class="font-mono text-xs">{acc.full_name}</span>
                    </Command.Item>
                  {/each}
                </Command.Group>
              </Command.List>
            </Command.Root>
          </Popover.Content>
        </Popover.Root>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="ob-currency" class="text-xs font-medium">Currency</label>
          <Input id="ob-currency" type="text" bind:value={formCurrency} placeholder="BTC" autocomplete="off" />
        </div>
        <div class="space-y-1">
          <label for="ob-quantity" class="text-xs font-medium">Quantity</label>
          <Input id="ob-quantity" type="text" bind:value={formQuantity} placeholder="0.5" autocomplete="off" />
        </div>
      </div>

      <div class="space-y-1">
        <label for="ob-cost" class="text-xs font-medium">Cost basis (EUR)</label>
        <Input id="ob-cost" type="text" bind:value={formCostEUR} placeholder="10000" autocomplete="off" />
        <p class="text-xs text-muted-foreground">
          Total EUR you spent acquiring this position. Leave empty for a pure pad (no tax cost basis declared).
        </p>
      </div>

      <div class="space-y-1">
        <label for="ob-note" class="text-xs font-medium">Note (optional)</label>
        <Input id="ob-note" type="text" bind:value={formNote} placeholder="Bought on Coinbase in 2017" autocomplete="off" />
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => { open = false; onClose(); }}>Cancel</Button>
      <Button disabled={!canSubmit || saving} onclick={handleSubmit}>
        {saving ? "Saving…" : (editingEntry ? "Save changes" : "Add opening balance")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
