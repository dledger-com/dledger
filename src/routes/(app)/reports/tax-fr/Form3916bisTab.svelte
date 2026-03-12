<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { ExchangeAccount } from "$lib/cex/types.js";
  import {
    INSTITUTION_REGISTRY,
    requiresDeclaration,
    getInstitution,
    type InstitutionInfo,
  } from "$lib/cex/institution-registry.js";
  import { exportForm3916bisCsv } from "$lib/utils/csv-export.js";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import Download from "lucide-svelte/icons/download";
  import Info from "lucide-svelte/icons/info";
  import ChevronDown from "lucide-svelte/icons/chevron-down";

  let {
    exchangeAccounts,
    taxYear,
  }: {
    exchangeAccounts: ExchangeAccount[];
    taxYear: number;
  } = $props();

  const foreignAccounts = $derived(
    exchangeAccounts.filter((a) => requiresDeclaration(a.exchange, taxYear)),
  );
  const exemptAccounts = $derived(
    exchangeAccounts.filter((a) => !requiresDeclaration(a.exchange, taxYear)),
  );

  /** Track which rows have expanded address detail */
  let expandedRows = $state<Set<string>>(new Set());

  function toggleRow(id: string) {
    const next = new Set(expandedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedRows = next;
  }

  /** All non-CEX institutions from the registry (CSV/PDF/bank presets) */
  const cexIds = new Set<string>(exchangeAccounts.map((a) => a.exchange));
  const otherInstitutions = $derived(
    Object.entries(INSTITUTION_REGISTRY)
      .filter(([id, info]) => !cexIds.has(id) && !info.nonCustodial)
      // Deduplicate entries sharing the same legal entity (e.g. n26/pdf-n26)
      .filter(([id, info], _i, arr) => {
        const first = arr.find(([, other]) => other.legalEntity === info.legalEntity);
        return first ? first[0] === id : true;
      }),
  );

  let showReferenceTable = $state(false);
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
            <Card.Description>{foreignAccounts.length} account{foreignAccounts.length > 1 ? "s" : ""} to declare on Form 3916-bis for {taxYear}</Card.Description>
          </div>
          <Button variant="outline" size="sm" onclick={() => exportForm3916bisCsv(exchangeAccounts, taxYear)}>
            <Download class="mr-1 h-4 w-4" />
            CSV
          </Button>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Legal Entity</Table.Head>
                <Table.Head>Label</Table.Head>
                <Table.Head>Country</Table.Head>
                <Table.Head>URL</Table.Head>
                <Table.Head class="text-right">Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each foreignAccounts as account (account.id)}
                {@const info = getInstitution(account.exchange)}
                {@const expanded = expandedRows.has(account.id)}
                <Table.Row class="cursor-pointer" onclick={() => toggleRow(account.id)}>
                  <Table.Cell class="font-medium">
                    <div class="flex items-center gap-1">
                      <ChevronDown class="h-3 w-3 text-muted-foreground transition-transform {expanded ? '' : '-rotate-90'}" />
                      {info?.legalEntity || account.exchange}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-muted-foreground">{account.label}</Table.Cell>
                  <Table.Cell>{info?.country ?? "Unknown"}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{info?.url ?? ""}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Badge variant="destructive">Must declare</Badge>
                    {#if info?.closedDate}
                      <Badge variant="outline" class="ml-1">Closed</Badge>
                    {/if}
                  </Table.Cell>
                </Table.Row>
                {#if expanded && info?.address}
                  <Table.Row>
                    <Table.Cell colspan={5} class="bg-muted/30 py-2 pl-8 text-sm text-muted-foreground">
                      <span class="font-medium">Address:</span> {info.address}
                      {#if info.note}
                        <span class="ml-3 text-xs opacity-70">— {info.note}</span>
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/if}
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Root>
    {/if}

    <!-- French / exempt accounts -->
    {#if exemptAccounts.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Exempt Platforms</Card.Title>
          <Card.Description>No 3916-bis declaration required for {taxYear}.</Card.Description>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Legal Entity</Table.Head>
                <Table.Head>Label</Table.Head>
                <Table.Head>Country</Table.Head>
                <Table.Head class="text-right">Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each exemptAccounts as account (account.id)}
                {@const info = getInstitution(account.exchange)}
                <Table.Row>
                  <Table.Cell class="font-medium">{info?.legalEntity || account.exchange}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{account.label}</Table.Cell>
                  <Table.Cell>{info?.country ?? "Unknown"}</Table.Cell>
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

  <!-- Reference: other known institutions -->
  <Card.Root>
    <Card.Header>
      <div class="flex items-center justify-between">
        <div>
          <Card.Title class="text-sm">Other Known Institutions</Card.Title>
          <Card.Description>Platforms supported via CSV/PDF import — look up details for manual declaration.</Card.Description>
        </div>
        <Button variant="ghost" size="sm" onclick={() => showReferenceTable = !showReferenceTable}>
          <ChevronDown class="h-4 w-4 transition-transform {showReferenceTable ? '' : '-rotate-90'}" />
          {showReferenceTable ? "Hide" : "Show"}
        </Button>
      </div>
    </Card.Header>
    {#if showReferenceTable}
      <div class="overflow-x-auto">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Legal Entity</Table.Head>
              <Table.Head>Address</Table.Head>
              <Table.Head>Country</Table.Head>
              <Table.Head>URL</Table.Head>
              <Table.Head class="text-right">Status ({taxYear})</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each otherInstitutions as [id, info] (id)}
              <Table.Row>
                <Table.Cell class="font-medium">
                  {info.legalEntity || id}
                  {#if info.note}
                    <span class="block text-xs text-muted-foreground">{info.note}</span>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-sm text-muted-foreground max-w-xs">{info.address || "—"}</Table.Cell>
                <Table.Cell>{info.country || "—"}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{info.url || "—"}</Table.Cell>
                <Table.Cell class="text-right">
                  {#if info.nonCustodial}
                    <Badge variant="outline">Non-custodial</Badge>
                  {:else if requiresDeclaration(id, taxYear)}
                    <Badge variant="destructive">Foreign</Badge>
                  {:else}
                    <Badge variant="secondary">French — exempt</Badge>
                  {/if}
                  {#if info.closedDate}
                    <Badge variant="outline" class="ml-1">Closed</Badge>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    {/if}
  </Card.Root>

  <!-- Foreign bank reminder -->
  <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
    <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    <p class="text-muted-foreground">
      Foreign bank accounts holding crypto (e.g., N26, Revolut) may also require a 3916-bis declaration if the bank is headquartered outside France.
      Self-custody wallets (hardware wallets, Metamask, etc.) do <strong>not</strong> need to be declared.
    </p>
  </div>
</div>
