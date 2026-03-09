<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { ExchangeAccount, ExchangeId } from "$lib/cex/types.js";
  import { exportForm3916bisCsv } from "$lib/utils/csv-export.js";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import Download from "lucide-svelte/icons/download";
  import Info from "lucide-svelte/icons/info";

  let { exchangeAccounts }: { exchangeAccounts: ExchangeAccount[] } = $props();

  const EXCHANGE_COUNTRIES: Record<ExchangeId, { name: string; country: string; foreign: boolean }> = {
    kraken: { name: "Kraken", country: "United States", foreign: true },
    binance: { name: "Binance", country: "Cayman Islands", foreign: true },
    coinbase: { name: "Coinbase", country: "United States", foreign: true },
    bybit: { name: "Bybit", country: "UAE", foreign: true },
    okx: { name: "OKX", country: "Seychelles", foreign: true },
    bitstamp: { name: "Bitstamp", country: "Luxembourg", foreign: true },
    cryptocom: { name: "Crypto.com", country: "Singapore", foreign: true },
    volet: { name: "Volet", country: "France", foreign: false },
  };

  const foreignAccounts = $derived(
    exchangeAccounts.filter((a) => EXCHANGE_COUNTRIES[a.exchange]?.foreign !== false),
  );
  const frenchAccounts = $derived(
    exchangeAccounts.filter((a) => EXCHANGE_COUNTRIES[a.exchange]?.foreign === false),
  );

  function getInfo(exchange: ExchangeId) {
    return EXCHANGE_COUNTRIES[exchange] ?? { name: exchange, country: "Unknown", foreign: true };
  }
</script>

<div class="space-y-6">
  <!-- Penalty warning -->
  <div class="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
    <AlertTriangle class="h-4 w-4 shrink-0 mt-0.5" />
    <div>
      <p class="font-medium">750&#8239;EUR penalty per undeclared foreign account (1,500&#8239;EUR if balance exceeds 50,000&#8239;EUR)</p>
      <p class="mt-1 text-yellow-700 dark:text-yellow-300">
        With DAC8 in effect since January 2026, platforms report automatically — omissions are easily detected.
      </p>
    </div>
  </div>

  {#if exchangeAccounts.length === 0}
    <!-- Empty state -->
    <Card.Root>
      <Card.Content class="py-8 text-center space-y-2">
        <p class="text-sm font-medium">No exchange accounts configured</p>
        <p class="text-sm text-muted-foreground max-w-md mx-auto">
          If you have accounts on foreign platforms (Binance, Coinbase, Kraken, etc.), you must declare them on Form 3916-bis.
          Add exchange accounts in <strong>Sources</strong> to track them here.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Foreign accounts table -->
    {#if foreignAccounts.length > 0}
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between">
          <div>
            <Card.Title>Foreign Exchange Accounts</Card.Title>
            <Card.Description>{foreignAccounts.length} account{foreignAccounts.length > 1 ? "s" : ""} to declare on Form 3916-bis</Card.Description>
          </div>
          <Button variant="outline" size="sm" onclick={() => exportForm3916bisCsv(exchangeAccounts)}>
            <Download class="mr-1 h-4 w-4" />
            CSV
          </Button>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Platform</Table.Head>
                <Table.Head>Label</Table.Head>
                <Table.Head>Country</Table.Head>
                <Table.Head class="text-right">Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each foreignAccounts as account (account.id)}
                {@const info = getInfo(account.exchange)}
                <Table.Row>
                  <Table.Cell class="font-medium">{info.name}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{account.label}</Table.Cell>
                  <Table.Cell>{info.country}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Badge variant="destructive">Must declare</Badge>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Root>
    {/if}

    <!-- French accounts -->
    {#if frenchAccounts.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>French Platforms</Card.Title>
          <Card.Description>No 3916-bis declaration required for these accounts.</Card.Description>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Platform</Table.Head>
                <Table.Head>Label</Table.Head>
                <Table.Head>Country</Table.Head>
                <Table.Head class="text-right">Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each frenchAccounts as account (account.id)}
                {@const info = getInfo(account.exchange)}
                <Table.Row>
                  <Table.Cell class="font-medium">{info.name}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{account.label}</Table.Cell>
                  <Table.Cell>{info.country}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Badge variant="secondary">French — exempt</Badge>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Root>
    {/if}
  {/if}

  <!-- Foreign bank reminder -->
  <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
    <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    <p class="text-muted-foreground">
      Foreign bank accounts holding crypto (e.g., N26, Revolut) may also require a 3916-bis declaration if the bank is headquartered outside France.
      Self-custody wallets (hardware wallets, Metamask, etc.) do <strong>not</strong> need to be declared.
    </p>
  </div>
</div>
