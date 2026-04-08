<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import Info from "lucide-svelte/icons/info";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import * as m from "$paraglide/messages.js";

  let { report }: { report: FrenchTaxReport } = $props();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const totalFiat = $derived(parseFloat(report.totalFiatReceived));

  type DispSortKey = "date" | "description" | "crypto" | "fiat" | "portfolio" | "acqCost" | "costFraction" | "plusValue";
  const sortDisp = createSortState<DispSortKey>();
  const dispAccessors: Record<DispSortKey, (d: any) => string | number | null> = {
    date: (d) => d.date,
    description: (d) => d.description,
    crypto: (d) => d.cryptoCurrencies.join(","),
    fiat: (d) => parseFloat(d.fiatReceived),
    portfolio: (d) => parseFloat(d.portfolioValue),
    acqCost: (d) => parseFloat(d.acquisitionCostBefore),
    costFraction: (d) => parseFloat(d.costFraction),
    plusValue: (d) => parseFloat(d.plusValue),
  };

  type AcqSortKey = "date" | "description" | "crypto" | "fiatSpent";
  const sortAcq = createSortState<AcqSortKey>();
  const acqAccessors: Record<AcqSortKey, (a: any) => string | number | null> = {
    date: (a) => a.date,
    description: (a) => a.description,
    crypto: (a) => a.cryptoCurrencies.join(","),
    fiatSpent: (a) => parseFloat(a.fiatSpent),
  };
</script>

<div class="space-y-6">
  {#if report.dispositions.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>{m.report_french_tax_2086_section_title()}</Card.Title>
        <Card.Description>{m.report_french_tax_2086_section_desc()}</Card.Description>
      </Card.Header>
      <div class="overflow-x-auto">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="w-10">#</Table.Head>
              <SortableHeader active={sortDisp.key === "date"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("date")}>
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    {m.label_date()} <span class="text-muted-foreground text-[10px]">(211)</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_211()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
              <SortableHeader active={sortDisp.key === "description"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("description")} class="hidden sm:table-cell">{m.label_description()}</SortableHeader>
              <SortableHeader active={sortDisp.key === "crypto"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("crypto")}>{m.label_crypto()}</SortableHeader>
              <SortableHeader active={sortDisp.key === "fiat"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("fiat")} class="text-right">
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    C <span class="text-muted-foreground text-[10px]">(217-218)</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_217_218()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
              <SortableHeader active={sortDisp.key === "portfolio"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("portfolio")} class="text-right hidden md:table-cell">
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    V <span class="text-muted-foreground text-[10px]">(212)</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_212()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
              <SortableHeader active={sortDisp.key === "acqCost"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("acqCost")} class="text-right hidden md:table-cell">
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    A <span class="text-muted-foreground text-[10px]">(220-223)</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_220_223()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
              <SortableHeader active={sortDisp.key === "costFraction"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("costFraction")} class="text-right hidden lg:table-cell">
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    A*C/V
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_acv()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
              <SortableHeader active={sortDisp.key === "plusValue"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("plusValue")} class="text-right">
                <Tooltip.Root>
                  <Tooltip.Trigger class="inline-flex items-center gap-1">
                    PV <span class="text-muted-foreground text-[10px]">(224)</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p class="text-xs max-w-48">{m.report_french_tax_2086_tooltip_224()}</p></Tooltip.Content>
                </Tooltip.Root>
              </SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedDisp = sortDisp.key && sortDisp.direction ? sortItems(report.dispositions, dispAccessors[sortDisp.key], sortDisp.direction) : report.dispositions}
            {#each sortedDisp as d, i (d.entryId)}
              {@const pv = parseFloat(d.plusValue)}
              <Table.Row>
                <Table.Cell class="font-mono text-muted-foreground">{i + 1}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{d.date}</Table.Cell>
                <Table.Cell class="hidden sm:table-cell max-w-48 truncate">{d.description}</Table.Cell>
                <Table.Cell>
                  {#each d.cryptoCurrencies as c}
                    <Badge variant="outline" class="mr-1">{c}</Badge>
                  {/each}
                </Table.Cell>
                <Table.Cell class="text-right font-mono">{formatCurrency(d.fiatReceived, "EUR")}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden md:table-cell">{formatCurrency(d.portfolioValue, "EUR")}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden md:table-cell">{formatCurrency(d.acquisitionCostBefore, "EUR")}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden lg:table-cell">{formatCurrency(d.costFraction, "EUR")}</Table.Cell>
                <Table.Cell class="text-right font-mono {pv >= 0 ? 'text-positive' : 'text-negative'}">
                  {pv >= 0 ? "+" : ""}{formatCurrency(pv, "EUR")}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={4} class="font-medium">{m.label_total()}</Table.Cell>
              <Table.Cell class="text-right font-mono font-medium">{formatCurrency(totalFiat, "EUR")}</Table.Cell>
              <Table.Cell class="hidden md:table-cell"></Table.Cell>
              <Table.Cell class="hidden md:table-cell"></Table.Cell>
              <Table.Cell class="hidden lg:table-cell"></Table.Cell>
              <Table.Cell class="text-right font-mono font-medium {totalPV >= 0 ? 'text-positive' : 'text-negative'}">
                {totalPV >= 0 ? "+" : ""}{formatCurrency(totalPV, "EUR")}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </div>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.report_french_tax_2086_empty({ year: String(report.taxYear) })}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Acquisitions Reference (collapsible) -->
  {#if report.acquisitions.length > 0}
    <Collapsible.Root>
      <Card.Root>
        <Collapsible.Trigger class="w-full">
          <Card.Header class="flex flex-row items-center justify-between">
            <div>
              <Card.Title>{m.report_french_tax_2086_acquisitions_title()}</Card.Title>
              <Card.Description>{m.report_french_tax_2086_acquisitions_desc()}</Card.Description>
            </div>
            <ChevronDown class="h-4 w-4 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
          </Card.Header>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <SortableHeader active={sortAcq.key === "date"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("date")}>{m.label_date()}</SortableHeader>
                  <SortableHeader active={sortAcq.key === "description"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("description")} class="hidden sm:table-cell">{m.label_description()}</SortableHeader>
                  <SortableHeader active={sortAcq.key === "crypto"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("crypto")}>{m.label_crypto()}</SortableHeader>
                  <SortableHeader active={sortAcq.key === "fiatSpent"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("fiatSpent")} class="text-right">{m.report_french_tax_2086_col_fiat_spent()}</SortableHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {@const sortedAcq = sortAcq.key && sortAcq.direction ? sortItems(report.acquisitions, acqAccessors[sortAcq.key], sortAcq.direction) : report.acquisitions}
                {#each sortedAcq as a (a.entryId)}
                  <Table.Row>
                    <Table.Cell class="text-muted-foreground">{a.date}</Table.Cell>
                    <Table.Cell class="hidden sm:table-cell max-w-48 truncate">{a.description}</Table.Cell>
                    <Table.Cell>
                      {#each a.cryptoCurrencies as c}
                        <Badge variant="outline" class="mr-1">{c}</Badge>
                      {/each}
                    </Table.Cell>
                    <Table.Cell class="text-right font-mono">{formatCurrency(a.fiatSpent, "EUR")}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        </Collapsible.Content>
      </Card.Root>
    </Collapsible.Root>
  {/if}
</div>
