<script lang="ts">
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { cn } from "$lib/utils.js";
  import * as m from "$paraglide/messages.js";

  let {
    value,
    accounts,
    onchange,
    variant = "link",
    placeholder = "",
    class: className,
  }: {
    value: string;
    accounts: string[];
    onchange: (value: string) => void;
    variant?: "link" | "input";
    placeholder?: string;
    class?: string;
  } = $props();

  let open = $state(false);
  let search = $state("");

  const ACCOUNT_TYPES = ["Asset", "Liability", "Equity", "Revenue", "Expense"] as const;

  function topLevel(path: string): string {
    const seg = path.split(":")[0];
    if (seg === "Assets") return "Asset";
    if (seg === "Liabilities") return "Liability";
    if (seg === "Income") return "Revenue";
    if (seg === "Expenses") return "Expense";
    if (seg === "Equity") return "Equity";
    return "Other";
  }

  let groupedAccounts = $derived.by(() => {
    const groups = new Map<string, string[]>();
    for (const type of ACCOUNT_TYPES) groups.set(type, []);
    groups.set("Other", []);
    for (const acct of accounts) {
      const type = topLevel(acct);
      groups.get(type)!.push(acct);
    }
    // Return only non-empty groups
    return [...groups.entries()].filter(([, accts]) => accts.length > 0);
  });

  function select(acct: string) {
    onchange(acct);
    open = false;
    search = "";
  }
</script>

<Popover.Root bind:open onOpenChange={(v) => { if (!v) search = ""; }}>
  <Popover.Trigger
    class={cn(
      variant === "input"
        ? "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono text-left truncate cursor-pointer hover:border-foreground/30"
        : "font-mono text-muted-foreground truncate max-w-[160px] text-left text-xs hover:underline hover:text-foreground cursor-pointer bg-transparent border-none p-0 inline-block",
      !value && variant === "input" && "text-muted-foreground",
      className,
    )}
  >
    {value || placeholder}
  </Popover.Trigger>
  <Popover.Content class="w-[280px] max-w-[calc(100vw-2rem)] p-0" align="start">
    <Command.Root shouldFilter={true}>
      <Command.Input placeholder={m.placeholder_search_accounts()} bind:value={search} />
      <Command.List class="max-h-[200px]">
        <Command.Empty>{m.empty_no_matching_account()}</Command.Empty>
        {#each groupedAccounts as [type, accts]}
          <Command.Group heading={type}>
            {#each accts as acct}
              <Command.Item value={acct} onSelect={() => select(acct)} class="font-mono text-xs">
                {acct}
              </Command.Item>
            {/each}
          </Command.Group>
        {/each}
        {#if search && !accounts.includes(search)}
          <Command.Group heading="New">
            <Command.Item value={search} onSelect={() => select(search)} class="font-mono text-xs">
              Use "{search}"
            </Command.Item>
          </Command.Group>
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
