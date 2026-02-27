<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { getBackend, type RecurringTemplate, type TemplateLineItem } from "$lib/backend.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { generateDueEntries, countDueTemplates } from "$lib/utils/recurring.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import type { Account } from "$lib/types/index.js";
  import Plus from "lucide-svelte/icons/plus";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Play from "lucide-svelte/icons/play";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";

  type RecurringSortKey = "description" | "frequency" | "nextDate" | "active";
  const sort = createSortState<RecurringSortKey>();
  const recurringAccessors: Record<RecurringSortKey, (t: RecurringTemplate) => string | number> = {
    description: (t) => t.description,
    frequency: (t) => t.frequency,
    nextDate: (t) => t.next_date,
    active: (t) => t.is_active ? 1 : 0,
  };

  let templates = $state<RecurringTemplate[]>([]);
  let accounts = $state<Account[]>([]);
  let dueCount = $state(0);
  let generating = $state(false);

  // New template form
  let showForm = $state(false);
  let newDescription = $state("");
  let newFrequency = $state<RecurringTemplate["frequency"]>("monthly");
  let newInterval = $state(1);
  let newNextDate = $state(new Date().toISOString().slice(0, 10));
  let newEndDate = $state("");
  let newLineItems = $state<TemplateLineItem[]>([
    { account_id: "", currency: "USD", amount: "" },
    { account_id: "", currency: "USD", amount: "" },
  ]);
  let adding = $state(false);
  let searchTerm = $state("");

  const filteredTemplates = $derived.by(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return templates;
    return templates.filter(
      (t) =>
        t.description.toLowerCase().includes(term) ||
        t.frequency.toLowerCase().includes(term),
    );
  });

  async function loadTemplates() {
    try {
      templates = await getBackend().listRecurringTemplates();
      dueCount = await countDueTemplates(getBackend());
    } catch (err) {
      toast.error(`Failed to load templates: ${err}`);
    }
  }

  async function loadAccounts() {
    try {
      accounts = await getBackend().listAccounts();
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadTemplates();
    loadAccounts();
  });

  const postableAccounts = $derived(
    accounts
      .filter((a) => a.is_postable)
      .map((a) => a.full_name)
      .sort(),
  );

  function addLineItem() {
    newLineItems = [...newLineItems, { account_id: "", currency: "USD", amount: "" }];
  }

  function removeLineItem(index: number) {
    newLineItems = newLineItems.filter((_, i) => i !== index);
  }

  async function handleAdd() {
    if (!newDescription.trim()) {
      toast.error("Description is required");
      return;
    }
    const validItems = newLineItems.filter((li) => li.account_id && li.amount);
    if (validItems.length < 2) {
      toast.error("At least 2 line items are required");
      return;
    }
    adding = true;
    try {
      await getBackend().createRecurringTemplate({
        id: uuidv7(),
        description: newDescription.trim(),
        frequency: newFrequency,
        interval: newInterval,
        next_date: newNextDate,
        end_date: newEndDate || null,
        is_active: true,
        line_items: validItems,
        created_at: new Date().toISOString(),
      });
      newDescription = "";
      newNextDate = new Date().toISOString().slice(0, 10);
      newEndDate = "";
      newLineItems = [
        { account_id: "", currency: "USD", amount: "" },
        { account_id: "", currency: "USD", amount: "" },
      ];
      showForm = false;
      await loadTemplates();
      toast.success("Template created");
    } catch (err) {
      toast.error(String(err));
    } finally {
      adding = false;
    }
  }

  async function handleToggleActive(template: RecurringTemplate) {
    try {
      await getBackend().updateRecurringTemplate({
        ...template,
        is_active: !template.is_active,
      });
      await loadTemplates();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(id: string) {
    try {
      await getBackend().deleteRecurringTemplate(id);
      await loadTemplates();
      toast.success("Template deleted");
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleGenerate() {
    generating = true;
    try {
      const count = await generateDueEntries(getBackend());
      if (count > 0) {
        toast.success(`Generated ${count} ${count === 1 ? "entry" : "entries"}`);
      } else {
        toast.info("No entries due");
      }
      await loadTemplates();
    } catch (err) {
      toast.error(String(err));
    } finally {
      generating = false;
    }
  }
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Recurring Transactions</h1>
      <p class="text-muted-foreground">
        Automate repeating journal entries.
      </p>
    </div>
    <ListFilter bind:value={searchTerm} placeholder="Filter templates..." />
    <div class="flex gap-2">
      {#if dueCount > 0}
        <Button onclick={handleGenerate} disabled={generating}>
          <Play class="mr-1 h-4 w-4" />
          {generating ? "Generating..." : `Generate ${dueCount} Due`}
        </Button>
      {/if}
      <Button variant="outline" onclick={() => { showForm = !showForm; }}>
        {showForm ? "Cancel" : "New Template"}
      </Button>
    </div>
  </div>

  {#if showForm}
    <Card.Root>
      <Card.Header>
        <Card.Title>New Recurring Template</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex-1 min-w-[200px] space-y-1">
            <label for="rec-desc" class="text-xs font-medium">Description</label>
            <Input id="rec-desc" placeholder="Monthly rent" bind:value={newDescription} />
          </div>
          <div class="space-y-1 w-32">
            <label for="rec-freq" class="text-xs font-medium">Frequency</label>
            <select
              id="rec-freq"
              bind:value={newFrequency}
              class="flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div class="space-y-1 w-20">
            <label for="rec-interval" class="text-xs font-medium">Every</label>
            <Input id="rec-interval" type="number" min="1" bind:value={newInterval} />
          </div>
        </div>
        <div class="flex flex-wrap items-end gap-3">
          <div class="space-y-1">
            <label for="rec-next" class="text-xs font-medium">Next Date</label>
            <Input id="rec-next" type="date" bind:value={newNextDate} class="w-40" />
          </div>
          <div class="space-y-1">
            <label for="rec-end" class="text-xs font-medium">End Date (optional)</label>
            <Input id="rec-end" type="date" bind:value={newEndDate} class="w-40" />
          </div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium">Line Items</p>
            <Button variant="outline" size="sm" onclick={addLineItem}>
              <Plus class="mr-1 h-3 w-3" /> Add Line
            </Button>
          </div>
          {#each newLineItems as item, i}
            <div class="flex items-end gap-2">
              <div class="flex-1 min-w-[180px] space-y-1">
                <label class="text-xs text-muted-foreground">Account</label>
                <Input placeholder="Expenses:Rent" bind:value={item.account_id} list="acct-suggestions" />
              </div>
              <div class="w-20 space-y-1">
                <label class="text-xs text-muted-foreground">Currency</label>
                <Input bind:value={item.currency} />
              </div>
              <div class="w-28 space-y-1">
                <label class="text-xs text-muted-foreground">Amount</label>
                <Input type="text" placeholder="0.00" bind:value={item.amount} />
              </div>
              {#if newLineItems.length > 2}
                <Button variant="outline" size="sm" onclick={() => removeLineItem(i)}>
                  <Trash2 class="h-3 w-3" />
                </Button>
              {/if}
            </div>
          {/each}
          <datalist id="acct-suggestions">
            {#each postableAccounts as name}
              <option value={name}></option>
            {/each}
          </datalist>
        </div>

        <Button onclick={handleAdd} disabled={adding || !newDescription.trim()}>
          {adding ? "Creating..." : "Create Template"}
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if filteredTemplates.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>Templates ({filteredTemplates.length})</Card.Title>
      </Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={sort.key === "description"} direction={sort.direction} onclick={() => sort.toggle("description")}>Description</SortableHeader>
            <SortableHeader active={sort.key === "frequency"} direction={sort.direction} onclick={() => sort.toggle("frequency")}>Frequency</SortableHeader>
            <SortableHeader active={sort.key === "nextDate"} direction={sort.direction} onclick={() => sort.toggle("nextDate")}>Next Date</SortableHeader>
            <SortableHeader active={sort.key === "active"} direction={sort.direction} onclick={() => sort.toggle("active")}>Active</SortableHeader>
            <Table.Head class="text-right">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const sorted = sort.key && sort.direction ? sortItems(filteredTemplates, recurringAccessors[sort.key], sort.direction) : filteredTemplates}
          {#each sorted as template (template.id)}
            <Table.Row class={!template.is_active ? "opacity-60" : ""}>
              <Table.Cell>
                <div>
                  <span class="font-medium">{template.description}</span>
                  <div class="text-xs text-muted-foreground">
                    {template.line_items.length} items: {template.line_items.map(li => `${li.account_id} ${formatCurrency(li.amount, li.currency)}`).join(", ")}
                  </div>
                </div>
              </Table.Cell>
              <Table.Cell>
                <Badge variant="secondary">
                  {template.interval > 1 ? `Every ${template.interval} ` : ""}{template.frequency}
                </Badge>
              </Table.Cell>
              <Table.Cell class="text-muted-foreground">
                {template.next_date}
                {#if template.end_date}
                  <span class="text-xs"> (until {template.end_date})</span>
                {/if}
              </Table.Cell>
              <Table.Cell>
                <Switch
                  checked={template.is_active}
                  onCheckedChange={() => handleToggleActive(template)}
                />
              </Table.Cell>
              <Table.Cell class="text-right">
                <Button size="sm" variant="outline" onclick={() => handleDelete(template.id)}>
                  <Trash2 class="h-3 w-3" />
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {:else if templates.length > 0 && searchTerm}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No templates match "{searchTerm}".
        </p>
      </Card.Content>
    </Card.Root>
  {:else if !showForm}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No recurring templates yet. Create one to automate repeating transactions.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
