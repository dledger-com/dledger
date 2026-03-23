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
    onSelectBitcoin,
    onSelectSolana,
    onSelectHyperliquid,
    onSelectSui,
    onSelectAptos,
    onSelectTon,
    onSelectTezos,
    disabled = false,
  }: {
    onSelectCex: (exchangeId: ExchangeId) => void;
    onSelectBlockchain: (prefillAddress?: string) => void;
    onSelectBitcoin?: (prefillInput?: string) => void;
    onSelectSolana?: (prefillAddress?: string) => void;
    onSelectHyperliquid?: (prefillAddress?: string) => void;
    onSelectSui?: (prefillAddress?: string) => void;
    onSelectAptos?: (prefillAddress?: string) => void;
    onSelectTon?: (prefillAddress?: string) => void;
    onSelectTezos?: (prefillAddress?: string) => void;
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
    { id: "volet", name: "Volet" },
  ];

  const chainKeywords = SUPPORTED_CHAINS.map((c) => c.name.toLowerCase());

  const detectedAddress = $derived.by(() => {
    const s = search.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(s) ? s : null;
  });

  const detectedBtcInput = $derived.by(() => {
    const s = search.trim();
    if (/^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[qp][a-z0-9]{38,58})$/.test(s))
      return { type: "address" as const, display: s };
    if (/^[xyztuvXYZTUV]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(s))
      return { type: "xpub" as const, display: s };
    return null;
  });

  // Move-based chains (Sui/Aptos): 0x + 64 hex chars (vs EVM's 40)
  const detectedMoveAddress = $derived.by(() => {
    const s = search.trim();
    return /^0x[a-fA-F0-9]{64}$/.test(s) ? s : null;
  });

  const detectedTonAddress = $derived.by(() => {
    const s = search.trim();
    if (/^[UE]Q[A-Za-z0-9_\-\/\+]{44,46}=?=?$/.test(s)) return s;
    if (/^-?[0-9]+:[0-9a-fA-F]{64}$/.test(s)) return s;
    return null;
  });

  const detectedTezosAddress = $derived.by(() => {
    const s = search.trim();
    return /^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) ? s : null;
  });

  const detectedSolAddress = $derived.by(() => {
    const s = search.trim();
    // Solana addresses: Base58, 32-44 chars, no 0/O/I/l
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !detectedBtcInput && !detectedAddress) return s;
    return null;
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

  function selectBitcoin(prefillInput?: string) {
    open = false;
    search = "";
    onSelectBitcoin?.(prefillInput);
  }

  function selectSolana(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectSolana?.(prefillAddress);
  }

  function selectHyperliquid(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectHyperliquid?.(prefillAddress);
  }

  function selectSui(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectSui?.(prefillAddress);
  }

  function selectAptos(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectAptos?.(prefillAddress);
  }

  function selectTon(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectTon?.(prefillAddress);
  }

  function selectTezos(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectTezos?.(prefillAddress);
  }
</script>

<Popover.Root bind:open onOpenChange={(v) => { if (!v) search = ""; }}>
  <Popover.Trigger {disabled}>
    <Button variant="outline" class="w-full justify-between" {disabled}>
      Search exchanges or paste address...
      <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  </Popover.Trigger>
  <Popover.Content class="w-[360px] max-w-[calc(100vw-2rem)] p-0" align="start">
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
            {#if onSelectHyperliquid}
              <Command.Item
                value="detected-hl-{detectedAddress}"
                keywords={["hyperliquid", "hl", "perp", "futures"]}
                onSelect={() => selectHyperliquid(detectedAddress)}
                class="font-mono text-xs"
              >
                Add {detectedAddress.slice(0, 6)}...{detectedAddress.slice(-4)} as Hyperliquid account
              </Command.Item>
            {/if}
          </Command.Group>
        {/if}
        {#if detectedMoveAddress}
          <Command.Group heading="Detected Move Address">
            {#if onSelectSui}
              <Command.Item
                value="detected-sui-{detectedMoveAddress}"
                keywords={["sui", "move"]}
                onSelect={() => selectSui(detectedMoveAddress)}
                class="font-mono text-xs"
              >
                Add {detectedMoveAddress.slice(0, 6)}...{detectedMoveAddress.slice(-4)} as Sui address
              </Command.Item>
            {/if}
            {#if onSelectAptos}
              <Command.Item
                value="detected-aptos-{detectedMoveAddress}"
                keywords={["aptos", "apt", "move"]}
                onSelect={() => selectAptos(detectedMoveAddress)}
                class="font-mono text-xs"
              >
                Add {detectedMoveAddress.slice(0, 6)}...{detectedMoveAddress.slice(-4)} as Aptos address
              </Command.Item>
            {/if}
          </Command.Group>
        {/if}
        {#if detectedTezosAddress}
          <Command.Group heading="Detected Tezos Address">
            <Command.Item value="detected-tezos-{detectedTezosAddress}" keywords={["tezos", "xtz"]} onSelect={() => selectTezos(detectedTezosAddress)} class="font-mono text-xs">
              Add {detectedTezosAddress.slice(0, 8)}...{detectedTezosAddress.slice(-4)} as Tezos address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedTonAddress}
          <Command.Group heading="Detected TON Address">
            <Command.Item value="detected-ton-{detectedTonAddress}" keywords={["ton", "toncoin"]} onSelect={() => selectTon(detectedTonAddress)} class="font-mono text-xs">
              Add {detectedTonAddress.slice(0, 8)}...{detectedTonAddress.slice(-4)} as TON address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedBtcInput}
          <Command.Group heading="Detected Bitcoin Input">
            <Command.Item
              value="detected-btc-{detectedBtcInput.display}"
              keywords={["bitcoin", "btc", "address", "xpub"]}
              onSelect={() => selectBitcoin(detectedBtcInput!.display)}
              class="font-mono text-xs"
            >
              Add {detectedBtcInput.display.slice(0, 8)}...{detectedBtcInput.display.slice(-4)} as Bitcoin {detectedBtcInput.type === "xpub" ? "HD wallet" : "address"}
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedSolAddress}
          <Command.Group heading="Detected Solana Address">
            <Command.Item
              value="detected-sol-{detectedSolAddress}"
              keywords={["solana", "sol", "address"]}
              onSelect={() => selectSolana(detectedSolAddress)}
              class="font-mono text-xs"
            >
              Add {detectedSolAddress.slice(0, 8)}...{detectedSolAddress.slice(-4)} as Solana address
            </Command.Item>
          </Command.Group>
        {/if}
        <Command.Group heading="Blockchain">
          {#if onSelectAptos}
            <Command.Item
              value="Aptos"
              keywords={["aptos", "apt", "move"]}
              onSelect={() => selectAptos()}
            >
              Aptos
            </Command.Item>
          {/if}
          {#if onSelectBitcoin}
            <Command.Item
              value="Bitcoin"
              keywords={["bitcoin", "btc", "xpub", "ypub", "zpub"]}
              onSelect={() => selectBitcoin()}
            >
              Bitcoin
            </Command.Item>
          {/if}
          <Command.Item
            value="EVM"
            keywords={chainKeywords}
            onSelect={() => selectBlockchain()}
          >
            EVM (Ethereum, Arbitrum, Base...)
          </Command.Item>
          {#if onSelectHyperliquid}
            <Command.Item
              value="Hyperliquid"
              keywords={["hyperliquid", "hl", "perp", "futures", "dex"]}
              onSelect={() => selectHyperliquid()}
            >
              Hyperliquid
            </Command.Item>
          {/if}
          {#if onSelectSolana}
            <Command.Item
              value="Solana"
              keywords={["solana", "sol", "phantom", "solflare"]}
              onSelect={() => selectSolana()}
            >
              Solana
            </Command.Item>
          {/if}
          {#if onSelectSui}
            <Command.Item
              value="Sui"
              keywords={["sui", "move"]}
              onSelect={() => selectSui()}
            >
              Sui
            </Command.Item>
          {/if}
          {#if onSelectTezos}
            <Command.Item
              value="Tezos"
              keywords={["tezos", "xtz", "tz1"]}
              onSelect={() => selectTezos()}
            >
              Tezos
            </Command.Item>
          {/if}
          {#if onSelectTon}
            <Command.Item
              value="TON"
              keywords={["ton", "toncoin", "telegram"]}
              onSelect={() => selectTon()}
            >
              TON
            </Command.Item>
          {/if}
        </Command.Group>
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
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
