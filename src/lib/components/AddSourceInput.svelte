<script lang="ts">
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
  import type { ExchangeId } from "$lib/cex/types.js";
  import { SUPPORTED_CHAINS } from "$lib/types/index.js";

  let {
    onSelectCex,
    onSelectBlockchain,
    disabled = false,
  }: {
    onSelectCex: (exchangeId: ExchangeId) => void;
    onSelectBlockchain: (prefillAddress?: string) => void;
    disabled?: boolean;
  } = $props();

  let open = $state(false);
  let search = $state("");

  const EXCHANGES: { id: ExchangeId; name: string }[] = [
    { id: "binance", name: "Binance" },
    { id: "bitstamp", name: "Bitstamp" },
    { id: "bybit", name: "Bybit" },
    { id: "coinbase", name: "Coinbase" },
    { id: "cryptocom", name: "Crypto.com" },
    { id: "kraken", name: "Kraken" },
    { id: "okx", name: "OKX" },
  ];

  const chainKeywords = SUPPORTED_CHAINS.map((c) => c.name.toLowerCase());

  const detectedAddress = $derived.by(() => {
    const s = search.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(s) ? s : null;
  });

  function selectCex(id: ExchangeId) {
    open = false;
    search = "";
    onSelectCex(id);
  }

  function selectBlockchain(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectBlockchain(prefillAddress);
  }
</script>

<Popover.Root bind:open onOpenChange={(v) => { if (!v) search = ""; }}>
  <Popover.Trigger {disabled}>
    <Button variant="outline" class="w-full justify-between" {disabled}>
      Search exchanges or paste address...
      <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  </Popover.Trigger>
  <Popover.Content class="w-[360px] p-0" align="start">
    <Command.Root shouldFilter={true}>
      <Command.Input placeholder="Search exchanges or paste address..." bind:value={search} />
      <Command.List class="max-h-[280px]">
        <Command.Empty>No matching source</Command.Empty>
        {#if detectedAddress}
          <Command.Group heading="Detected Address">
            <Command.Item
              value="detected-{detectedAddress}"
              keywords={["evm", "ethereum", "address", "blockchain"]}
              onSelect={() => selectBlockchain(detectedAddress)}
              class="font-mono text-xs"
            >
              Add {detectedAddress.slice(0, 6)}...{detectedAddress.slice(-4)} as EVM address
            </Command.Item>
          </Command.Group>
        {/if}
        <Command.Group heading="Exchanges">
          {#each EXCHANGES as exchange}
            <Command.Item
              value={exchange.name}
              onSelect={() => selectCex(exchange.id)}
            >
              {exchange.name}
            </Command.Item>
          {/each}
        </Command.Group>
        <Command.Group heading="Blockchain">
          <Command.Item
            value="EVM Address"
            keywords={chainKeywords}
            onSelect={() => selectBlockchain()}
          >
            EVM Address
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
