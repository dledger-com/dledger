<script lang="ts">
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
  import type { ExchangeId } from "$lib/cex/types.js";
  import { getAllCexAdapters } from "$lib/cex/index.js";
  import ExchangeIcon from "$lib/components/ExchangeIcon.svelte";
  import ChainIcon from "$lib/components/ChainIcon.svelte";
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
    onSelectCosmos,
    onSelectPolkadot,
    onSelectDoge,
    onSelectLtc,
    onSelectBch,
    onSelectXrp,
    onSelectTron,
    onSelectStellar,
    onSelectBittensor,
    onSelectHedera,
    onSelectNear,
    onSelectAlgorand,
    onSelectKaspa,
    onSelectZcash,
    onSelectStacks,
    onSelectCardano,
    onSelectMonero,
    onSelectBitshares,
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
    onSelectCosmos?: (prefillAddress?: string) => void;
    onSelectPolkadot?: (prefillAddress?: string) => void;
    onSelectDoge?: (prefillAddress?: string) => void;
    onSelectLtc?: (prefillAddress?: string) => void;
    onSelectBch?: (prefillAddress?: string) => void;
    onSelectXrp?: (prefillAddress?: string) => void;
    onSelectTron?: (prefillAddress?: string) => void;
    onSelectStellar?: (prefillAddress?: string) => void;
    onSelectBittensor?: (prefillAddress?: string) => void;
    onSelectHedera?: (prefillAddress?: string) => void;
    onSelectNear?: (prefillAddress?: string) => void;
    onSelectAlgorand?: (prefillAddress?: string) => void;
    onSelectKaspa?: (prefillAddress?: string) => void;
    onSelectZcash?: (prefillAddress?: string) => void;
    onSelectStacks?: (prefillAddress?: string) => void;
    onSelectCardano?: (prefillAddress?: string) => void;
    onSelectMonero?: (prefillAddress?: string) => void;
    onSelectBitshares?: (prefillAddress?: string) => void;
    disabled?: boolean;
  } = $props();

  let open = $state(false);
  let search = $state("");

  const EXCHANGES: { id: ExchangeId; name: string }[] = getAllCexAdapters()
    .map((a) => ({ id: a.exchangeId, name: a.exchangeName }))
    .sort((a, b) => a.name.localeCompare(b.name));

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

  const detectedCosmosAddress = $derived.by(() => {
    const s = search.trim();
    return /^cosmos1[02-9ac-hj-np-z]{38}$/.test(s) ? s : null;
  });

  const detectedPolkadotAddress = $derived.by(() => {
    const s = search.trim();
    return /^1[1-9A-HJ-NP-Za-km-z]{45,47}$/.test(s) ? s : null;
  });

  const detectedDogeAddress = $derived.by(() => {
    const s = search.trim();
    return /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(s) ? s : null;
  });

  const detectedXrpAddress = $derived.by(() => {
    const s = search.trim();
    return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s) ? s : null;
  });

  const detectedTronAddress = $derived.by(() => {
    const s = search.trim();
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) ? s : null;
  });

  const detectedStellarAddress = $derived.by(() => {
    const s = search.trim();
    return /^G[A-Z2-7]{55}$/.test(s) ? s : null;
  });

  const detectedHederaAddress = $derived.by(() => {
    const s = search.trim();
    return /^0\.0\.\d+$/.test(s) ? s : null;
  });

  const detectedAlgorandAddress = $derived.by(() => {
    const s = search.trim();
    return /^[A-Z2-7]{58}$/.test(s) ? s : null;
  });

  const detectedKaspaAddress = $derived.by(() => {
    const s = search.trim();
    return /^kaspa:[a-z0-9]{61,63}$/.test(s) ? s : null;
  });

  const detectedZcashAddress = $derived.by(() => {
    const s = search.trim();
    return /^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(s) ? s : null;
  });

  const detectedStacksAddress = $derived.by(() => {
    const s = search.trim();
    return /^SP[0-9A-Z]{28,38}$/.test(s) ? s : null;
  });

  const detectedBchAddress = $derived.by(() => {
    const s = search.trim();
    return /^(bitcoincash:)?[qp][a-z0-9]{41}$/.test(s) ? s : null;
  });

  const detectedCardanoAddress = $derived.by(() => {
    const s = search.trim();
    return /^addr1[0-9a-z]{53,}$/.test(s) ? s : null;
  });

  const detectedMoneroAddress = $derived.by(() => {
    const s = search.trim();
    return /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(s) ? s : null;
  });

  const detectedBitsharesAccount = $derived.by(() => {
    const s = search.trim();
    return /^[a-z][a-z0-9.-]{2,62}$/.test(s) ? s : null;
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

  function selectCosmos(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectCosmos?.(prefillAddress);
  }

  function selectPolkadot(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectPolkadot?.(prefillAddress);
  }

  function selectDoge(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectDoge?.(prefillAddress);
  }

  function selectLtc(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectLtc?.(prefillAddress);
  }

  function selectBch(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectBch?.(prefillAddress);
  }

  function selectXrp(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectXrp?.(prefillAddress);
  }

  function selectTron(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectTron?.(prefillAddress);
  }

  function selectStellar(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectStellar?.(prefillAddress);
  }

  function selectBittensor(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectBittensor?.(prefillAddress);
  }

  function selectHedera(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectHedera?.(prefillAddress);
  }

  function selectNear(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectNear?.(prefillAddress);
  }

  function selectAlgorand(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectAlgorand?.(prefillAddress);
  }

  function selectKaspa(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectKaspa?.(prefillAddress);
  }

  function selectZcash(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectZcash?.(prefillAddress);
  }

  function selectStacks(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectStacks?.(prefillAddress);
  }

  function selectCardano(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectCardano?.(prefillAddress);
  }

  function selectMonero(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectMonero?.(prefillAddress);
  }

  function selectBitshares(prefillAddress?: string) {
    open = false;
    search = "";
    onSelectBitshares?.(prefillAddress);
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
        {#if detectedCosmosAddress}
          <Command.Group heading="Detected Cosmos Address">
            <Command.Item value="detected-cosmos-{detectedCosmosAddress}" keywords={["cosmos", "atom"]} onSelect={() => selectCosmos(detectedCosmosAddress)} class="font-mono text-xs">
              Add {detectedCosmosAddress.slice(0, 12)}...{detectedCosmosAddress.slice(-4)} as Cosmos address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedPolkadotAddress}
          <Command.Group heading="Detected Polkadot Address">
            <Command.Item value="detected-polkadot-{detectedPolkadotAddress}" keywords={["polkadot", "dot"]} onSelect={() => selectPolkadot(detectedPolkadotAddress)} class="font-mono text-xs">
              Add {detectedPolkadotAddress.slice(0, 8)}...{detectedPolkadotAddress.slice(-4)} as Polkadot address
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
        {#if detectedDogeAddress}
          <Command.Group heading="Detected Dogecoin Address">
            <Command.Item value="detected-doge-{detectedDogeAddress}" keywords={["dogecoin", "doge"]} onSelect={() => selectDoge(detectedDogeAddress)} class="font-mono text-xs">
              Add {detectedDogeAddress.slice(0, 8)}...{detectedDogeAddress.slice(-4)} as Dogecoin address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedXrpAddress}
          <Command.Group heading="Detected XRP Address">
            <Command.Item value="detected-xrp-{detectedXrpAddress}" keywords={["xrp", "ripple"]} onSelect={() => selectXrp(detectedXrpAddress)} class="font-mono text-xs">
              Add {detectedXrpAddress.slice(0, 8)}...{detectedXrpAddress.slice(-4)} as XRP address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedTronAddress}
          <Command.Group heading="Detected TRON Address">
            <Command.Item value="detected-tron-{detectedTronAddress}" keywords={["tron", "trx"]} onSelect={() => selectTron(detectedTronAddress)} class="font-mono text-xs">
              Add {detectedTronAddress.slice(0, 8)}...{detectedTronAddress.slice(-4)} as TRON address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedStellarAddress}
          <Command.Group heading="Detected Stellar Address">
            <Command.Item value="detected-stellar-{detectedStellarAddress}" keywords={["stellar", "xlm"]} onSelect={() => selectStellar(detectedStellarAddress)} class="font-mono text-xs">
              Add {detectedStellarAddress.slice(0, 8)}...{detectedStellarAddress.slice(-4)} as Stellar address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedHederaAddress}
          <Command.Group heading="Detected Hedera Address">
            <Command.Item value="detected-hedera-{detectedHederaAddress}" keywords={["hedera", "hbar"]} onSelect={() => selectHedera(detectedHederaAddress)} class="font-mono text-xs">
              Add {detectedHederaAddress} as Hedera account
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedAlgorandAddress}
          <Command.Group heading="Detected Algorand Address">
            <Command.Item value="detected-algorand-{detectedAlgorandAddress}" keywords={["algorand", "algo"]} onSelect={() => selectAlgorand(detectedAlgorandAddress)} class="font-mono text-xs">
              Add {detectedAlgorandAddress.slice(0, 8)}...{detectedAlgorandAddress.slice(-4)} as Algorand address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedKaspaAddress}
          <Command.Group heading="Detected Kaspa Address">
            <Command.Item value="detected-kaspa-{detectedKaspaAddress}" keywords={["kaspa", "kas"]} onSelect={() => selectKaspa(detectedKaspaAddress)} class="font-mono text-xs">
              Add {detectedKaspaAddress.slice(0, 12)}...{detectedKaspaAddress.slice(-4)} as Kaspa address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedZcashAddress}
          <Command.Group heading="Detected Zcash Address">
            <Command.Item value="detected-zcash-{detectedZcashAddress}" keywords={["zcash", "zec"]} onSelect={() => selectZcash(detectedZcashAddress)} class="font-mono text-xs">
              Add {detectedZcashAddress.slice(0, 8)}...{detectedZcashAddress.slice(-4)} as Zcash address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedStacksAddress}
          <Command.Group heading="Detected Stacks Address">
            <Command.Item value="detected-stacks-{detectedStacksAddress}" keywords={["stacks", "stx"]} onSelect={() => selectStacks(detectedStacksAddress)} class="font-mono text-xs">
              Add {detectedStacksAddress.slice(0, 8)}...{detectedStacksAddress.slice(-4)} as Stacks address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedBchAddress}
          <Command.Group heading="Detected Bitcoin Cash Address">
            <Command.Item value="detected-bch-{detectedBchAddress}" keywords={["bitcoin cash", "bch"]} onSelect={() => selectBch(detectedBchAddress)} class="font-mono text-xs">
              Add {detectedBchAddress.slice(0, 12)}...{detectedBchAddress.slice(-4)} as Bitcoin Cash address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedCardanoAddress}
          <Command.Group heading="Detected Cardano Address">
            <Command.Item value="detected-cardano-{detectedCardanoAddress}" keywords={["cardano", "ada"]} onSelect={() => selectCardano(detectedCardanoAddress)} class="font-mono text-xs">
              Add {detectedCardanoAddress.slice(0, 10)}...{detectedCardanoAddress.slice(-4)} as Cardano address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedMoneroAddress}
          <Command.Group heading="Detected Monero Address">
            <Command.Item value="detected-monero-{detectedMoneroAddress}" keywords={["monero", "xmr"]} onSelect={() => selectMonero(detectedMoneroAddress)} class="font-mono text-xs">
              Add {detectedMoneroAddress.slice(0, 8)}...{detectedMoneroAddress.slice(-4)} as Monero address
            </Command.Item>
          </Command.Group>
        {/if}
        {#if detectedBitsharesAccount}
          <Command.Group heading="Detected Bitshares Account">
            <Command.Item value="detected-bitshares-{detectedBitsharesAccount}" keywords={["bitshares", "bts"]} onSelect={() => selectBitshares(detectedBitsharesAccount)} class="font-mono text-xs">
              Add "{detectedBitsharesAccount}" as Bitshares account
            </Command.Item>
          </Command.Group>
        {/if}
        <Command.Group heading="Blockchain">
          {#if onSelectAlgorand}
            <Command.Item value="Algorand" keywords={["algorand", "algo"]} onSelect={() => selectAlgorand()}>
              <ChainIcon chainName="algorand" size={16} />Algorand
            </Command.Item>
          {/if}
          {#if onSelectAptos}
            <Command.Item value="Aptos" keywords={["aptos", "apt", "move"]} onSelect={() => selectAptos()}>
              <ChainIcon chainName="aptos" size={16} />Aptos
            </Command.Item>
          {/if}
          {#if onSelectBitcoin}
            <Command.Item value="Bitcoin" keywords={["bitcoin", "btc", "xpub", "ypub", "zpub"]} onSelect={() => selectBitcoin()}>
              <ChainIcon chainName="bitcoin" size={16} />Bitcoin
            </Command.Item>
          {/if}
          {#if onSelectBch}
            <Command.Item value="Bitcoin Cash" keywords={["bitcoin cash", "bch"]} onSelect={() => selectBch()}>
              <ChainIcon chainName="bch" size={16} />Bitcoin Cash
            </Command.Item>
          {/if}
          {#if onSelectBittensor}
            <Command.Item value="Bittensor" keywords={["bittensor", "tao", "substrate"]} onSelect={() => selectBittensor()}>
              <ChainIcon chainName="bittensor" size={16} />Bittensor
            </Command.Item>
          {/if}
          {#if onSelectBitshares}
            <Command.Item value="Bitshares" keywords={["bitshares", "bts", "dex", "graphene"]} onSelect={() => selectBitshares()}>
              <ChainIcon chainName="bitshares" size={16} />Bitshares
            </Command.Item>
          {/if}
          {#if onSelectCardano}
            <Command.Item value="Cardano" keywords={["cardano", "ada"]} onSelect={() => selectCardano()}>
              <ChainIcon chainName="cardano" size={16} />Cardano
            </Command.Item>
          {/if}
          {#if onSelectCosmos}
            <Command.Item value="Cosmos" keywords={["cosmos", "atom", "ibc"]} onSelect={() => selectCosmos()}>
              <ChainIcon chainName="cosmos" size={16} />Cosmos
            </Command.Item>
          {/if}
          {#if onSelectDoge}
            <Command.Item value="Dogecoin" keywords={["dogecoin", "doge"]} onSelect={() => selectDoge()}>
              <ChainIcon chainName="doge" size={16} />Dogecoin
            </Command.Item>
          {/if}
          <Command.Item value="EVM" keywords={chainKeywords} onSelect={() => selectBlockchain()}>
            <ChainIcon chainId={1} size={16} />EVM (Ethereum, Arbitrum, Base...)
          </Command.Item>
          {#if onSelectHedera}
            <Command.Item value="Hedera" keywords={["hedera", "hbar"]} onSelect={() => selectHedera()}>
              <ChainIcon chainName="hedera" size={16} />Hedera
            </Command.Item>
          {/if}
          {#if onSelectHyperliquid}
            <Command.Item value="Hyperliquid" keywords={["hyperliquid", "hl", "perp", "futures", "dex"]} onSelect={() => selectHyperliquid()}>
              <ChainIcon chainName="hl" size={16} />Hyperliquid
            </Command.Item>
          {/if}
          {#if onSelectKaspa}
            <Command.Item value="Kaspa" keywords={["kaspa", "kas"]} onSelect={() => selectKaspa()}>
              <ChainIcon chainName="kaspa" size={16} />Kaspa
            </Command.Item>
          {/if}
          {#if onSelectLtc}
            <Command.Item value="Litecoin" keywords={["litecoin", "ltc"]} onSelect={() => selectLtc()}>
              <ChainIcon chainName="ltc" size={16} />Litecoin
            </Command.Item>
          {/if}
          {#if onSelectMonero}
            <Command.Item value="Monero" keywords={["monero", "xmr", "privacy"]} onSelect={() => selectMonero()}>
              <ChainIcon chainName="xmr" size={16} />Monero
            </Command.Item>
          {/if}
          {#if onSelectNear}
            <Command.Item value="NEAR" keywords={["near", "near protocol"]} onSelect={() => selectNear()}>
              <ChainIcon chainName="near" size={16} />NEAR
            </Command.Item>
          {/if}
          {#if onSelectPolkadot}
            <Command.Item value="Polkadot" keywords={["polkadot", "dot", "substrate"]} onSelect={() => selectPolkadot()}>
              <ChainIcon chainName="polkadot" size={16} />Polkadot
            </Command.Item>
          {/if}
          {#if onSelectSolana}
            <Command.Item value="Solana" keywords={["solana", "sol", "phantom", "solflare"]} onSelect={() => selectSolana()}>
              <ChainIcon chainName="solana" size={16} />Solana
            </Command.Item>
          {/if}
          {#if onSelectStacks}
            <Command.Item value="Stacks" keywords={["stacks", "stx", "bitcoin"]} onSelect={() => selectStacks()}>
              <ChainIcon chainName="stacks" size={16} />Stacks
            </Command.Item>
          {/if}
          {#if onSelectStellar}
            <Command.Item value="Stellar" keywords={["stellar", "xlm"]} onSelect={() => selectStellar()}>
              <ChainIcon chainName="stellar" size={16} />Stellar
            </Command.Item>
          {/if}
          {#if onSelectSui}
            <Command.Item value="Sui" keywords={["sui", "move"]} onSelect={() => selectSui()}>
              <ChainIcon chainName="sui" size={16} />Sui
            </Command.Item>
          {/if}
          {#if onSelectTezos}
            <Command.Item value="Tezos" keywords={["tezos", "xtz", "tz1"]} onSelect={() => selectTezos()}>
              <ChainIcon chainName="tezos" size={16} />Tezos
            </Command.Item>
          {/if}
          {#if onSelectTon}
            <Command.Item value="TON" keywords={["ton", "toncoin", "telegram"]} onSelect={() => selectTon()}>
              <ChainIcon chainName="ton" size={16} />TON
            </Command.Item>
          {/if}
          {#if onSelectTron}
            <Command.Item value="TRON" keywords={["tron", "trx"]} onSelect={() => selectTron()}>
              <ChainIcon chainName="tron" size={16} />TRON
            </Command.Item>
          {/if}
          {#if onSelectXrp}
            <Command.Item value="XRP" keywords={["xrp", "ripple", "xrpl"]} onSelect={() => selectXrp()}>
              <ChainIcon chainName="xrp" size={16} />XRP
            </Command.Item>
          {/if}
          {#if onSelectZcash}
            <Command.Item value="Zcash" keywords={["zcash", "zec"]} onSelect={() => selectZcash()}>
              <ChainIcon chainName="zcash" size={16} />Zcash
            </Command.Item>
          {/if}
        </Command.Group>
        <Command.Group heading="Exchanges">
          {#each EXCHANGES as exchange}
            <Command.Item
              value={exchange.name}
              onSelect={() => selectCex(exchange.id)}
            >
              <ExchangeIcon exchangeId={exchange.id} size={16} />{exchange.name}
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
