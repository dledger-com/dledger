<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import type { ExchangeAccount } from "$lib/cex/types.js";
  import Info from "lucide-svelte/icons/info";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import * as m from "$paraglide/messages.js";

  let expandedCurrencies = $state(new Set<string>());

  let {
    report,
    taxYear,
    foreignAccountCount,
    debugMode = false,
  }: {
    report: FrenchTaxReport;
    taxYear: number;
    foreignAccountCount: number;
    debugMode?: boolean;
  } = $props();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const totalFiat = $derived(parseFloat(report.totalFiatReceived));
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));
  const yearEndV = $derived(parseFloat(report.yearEndPortfolioValue));
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
</script>

<div class="space-y-6">
  <!-- Skipped dispositions banner -->
  {#if report.skippedDispositionCount > 0}
    <div class="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
      <AlertTriangle class="h-4 w-4 shrink-0 mt-0.5" />
      <div>
        <p class="font-medium">
          {report.skippedDispositionCount === 1
            ? m.report_french_tax_skipped_one()
            : m.report_french_tax_skipped_other({ count: String(report.skippedDispositionCount) })}
        </p>
        <p class="mt-1 text-yellow-700 dark:text-yellow-300">
          {m.report_french_tax_opening_balance_hint()}
        </p>
      </div>
    </div>
  {/if}

  <!-- Declaration Roadmap -->
  <Card.Root>
    <Card.Header class="pb-3">
      <Card.Title class="text-base">{m.report_french_tax_declaration_roadmap()}</Card.Title>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- Form 2086 -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">2086</Badge>
          <span class="font-medium text-sm">{m.report_french_tax_form_2086_card_title()}</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          {m.report_french_tax_form_2086_path()}
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if report.dispositions.length > 0}
            {report.dispositions.length === 1
              ? m.report_french_tax_disp_to_transcribe_one()
              : m.report_french_tax_disp_to_transcribe_other({ count: String(report.dispositions.length) })}
            <span class="text-muted-foreground">{m.report_french_tax_see_form_2086_tab()}</span>
          {:else}
            {m.report_french_tax_no_disp_nothing_to_fill()}
          {/if}
        </p>
      </div>

      <!-- Form 2042 C -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">2042 C</Badge>
          <span class="font-medium text-sm">{m.report_french_tax_form_2042c_card_title()}</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          {m.report_french_tax_where_box({ box: box3AN > 0 ? "3AN" : "3BN" })}
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if box3AN > 0}
            {m.report_french_tax_amount_gain({ amount: formatCurrency(report.box3AN, "EUR") })}
          {:else if box3BN > 0}
            {m.report_french_tax_amount_loss({ amount: formatCurrency(report.box3BN, "EUR") })}
          {:else}
            {m.report_french_tax_no_amount_to_report()}
          {/if}
        </p>
      </div>

      <!-- Form 3916-bis -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">3916-bis</Badge>
          <span class="font-medium text-sm">{m.report_french_tax_form_3916bis_card_title()}</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          {m.report_french_tax_form_3916bis_path()}
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if foreignAccountCount > 0}
            {foreignAccountCount === 1
              ? m.report_french_tax_account_to_declare_one()
              : m.report_french_tax_account_to_declare_other({ count: String(foreignAccountCount) })}
            <span class="text-muted-foreground">{m.report_french_tax_see_form_3916bis_tab()}</span>
          {:else}
            {m.report_french_tax_no_foreign_accounts_configured()}
          {/if}
        </p>
        <div class="flex items-center gap-1.5 ml-[3.25rem] text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle class="h-3 w-3 shrink-0" />
          <span>{m.report_french_tax_penalty_undeclared_short()}</span>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Summary Metrics -->
  <div class="grid gap-4 sm:grid-cols-2">
    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>{m.report_french_tax_total_plus_value()}</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">{m.report_french_tax_total_pv_tooltip({ year: String(taxYear) })}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl {totalPV >= 0 ? 'text-positive' : 'text-negative'}">
          {totalPV >= 0 ? "+" : ""}{formatCurrency(totalPV, "EUR")}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>{m.report_french_tax_total_fiat_received()}</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">{m.report_french_tax_total_fiat_tooltip()}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(totalFiat, "EUR")}</Card.Title>
      </Card.Header>
      <Card.Content class="pt-0">
        {#if report.isExempt}
          <Badge variant="secondary">{m.report_french_tax_exempt_305_badge()}</Badge>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>{m.report_french_tax_final_acq_cost()}</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">{m.report_french_tax_final_acq_tooltip({ year: String(taxYear) })}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(finalA, "EUR")}</Card.Title>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>{m.report_french_tax_portfolio_dec31()}</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">{m.report_french_tax_portfolio_tooltip()}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(yearEndV, "EUR")}</Card.Title>
      </Card.Header>
    </Card.Root>
  </div>

  <!-- PFU Rate Note -->
  <div class="text-xs text-muted-foreground">
    {#if taxYear >= 2025}
      {m.report_french_tax_pfu_note_2025_plus()}
    {:else}
      {m.report_french_tax_pfu_note_pre_2025()}
      {m.report_french_tax_pfu_at_30({ amount: formatCurrency(report.taxDuePFU30, "EUR") })}
    {/if}
    {#if taxYear < 2025}
      {m.report_french_tax_pfu_at_314({ amount: formatCurrency(report.taxDuePFU314, "EUR") })}
    {:else}
      {m.report_french_tax_pfu_at_30({ amount: formatCurrency(report.taxDuePFU30, "EUR") })}
    {/if}
  </div>

  <!-- Debug: Computation Details -->
  {#if debugMode}
    <Card.Root>
      <Card.Header class="pb-2">
        <Card.Title class="text-base">{m.report_french_tax_computation_details()}</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-muted-foreground">{m.report_french_tax_entries_processed()}</dt>
          <dd class="font-mono">{report.entriesProcessed}</dd>
          <dt class="text-muted-foreground">{m.report_french_tax_pre_year_acq()}</dt>
          <dd class="font-mono">{report.preYearAcquisitionCount} ({formatCurrency(report.preYearAcquisitionTotal, "EUR")})</dd>
          <dt class="text-muted-foreground">{m.report_french_tax_pre_year_disp()}</dt>
          <dd class="font-mono">{report.preYearDispositionCount} ({formatCurrency(report.preYearDispositionTotal, "EUR")})</dd>
          <dt class="text-muted-foreground">{m.report_french_tax_in_year_acq()}</dt>
          <dd class="font-mono">{report.acquisitions.length}</dd>
          <dt class="text-muted-foreground">{m.report_french_tax_in_year_disp()}</dt>
          <dd class="font-mono">{report.dispositions.length}</dd>
        </dl>

        <!-- Year-end crypto holdings (aggregated by currency) -->
        {#if report.yearEndCryptoHoldings && report.yearEndCryptoHoldings.length > 0}
          <div class="mt-4">
            <h4 class="text-sm font-medium mb-2">{m.report_french_tax_yearend_holdings()}</h4>
            <div class="max-h-64 overflow-y-auto rounded border">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-muted">
                  <tr>
                    <th class="text-left px-2 py-1 font-medium">{m.label_currency()}</th>
                    <th class="text-right px-2 py-1 font-medium">{m.label_net_amount()}</th>
                    <th class="text-right px-2 py-1 font-medium">{m.label_accounts()}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each report.yearEndCryptoHoldings as h}
                    {@const isNeg = parseFloat(h.amount) < 0}
                    {@const hasMultiple = h.accounts.length > 1}
                    {@const expanded = expandedCurrencies.has(h.currency)}
                    <tr class="border-t {isNeg ? 'bg-red-50 dark:bg-red-950/20' : ''}">
                      <td class="px-2 py-1 font-mono">
                        {#if hasMultiple}
                          <button
                            class="flex items-center gap-1 hover:underline"
                            onclick={() => {
                              const next = new Set(expandedCurrencies);
                              if (next.has(h.currency)) next.delete(h.currency);
                              else next.add(h.currency);
                              expandedCurrencies = next;
                            }}
                          >
                            <ChevronRight class="h-3 w-3 transition-transform {expanded ? 'rotate-90' : ''}" />
                            {h.currency}
                          </button>
                        {:else}
                          {h.currency}
                        {/if}
                      </td>
                      <td class="px-2 py-1 font-mono text-right {isNeg ? 'text-negative font-semibold' : ''}">{h.amount}</td>
                      <td class="px-2 py-1 text-right text-muted-foreground">{h.accounts.length}</td>
                    </tr>
                    {#if expanded}
                      {#each h.accounts as acct}
                        <tr class="border-t border-dashed bg-muted/30">
                          <td class="px-2 py-0.5 pl-6 text-xs text-muted-foreground truncate max-w-64" title={acct.name}>{acct.name}</td>
                          <td class="px-2 py-0.5 font-mono text-xs text-right {parseFloat(acct.amount) < 0 ? 'text-negative' : 'text-muted-foreground'}">{acct.amount}</td>
                          <td></td>
                        </tr>
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {:else if report.yearEndCryptoHoldings}
          <p class="mt-4 text-sm text-muted-foreground">{m.report_french_tax_no_yearend_holdings()}</p>
        {/if}

        <!-- Pre-year disposition samples -->
        {#if report.preYearDispositionSamples && report.preYearDispositionSamples.length > 0}
          <div class="mt-4">
            <h4 class="text-sm font-medium mb-2">{m.report_french_tax_pre_year_samples({ count: String(report.preYearDispositionSamples.length) })}</h4>
            <div class="max-h-64 overflow-y-auto rounded border">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-muted">
                  <tr>
                    <th class="text-left px-2 py-1 font-medium">{m.label_date()}</th>
                    <th class="text-left px-2 py-1 font-medium">{m.label_description()}</th>
                    <th class="text-right px-2 py-1 font-medium">{m.report_french_tax_col_fiat_received()}</th>
                    <th class="text-left px-2 py-1 font-medium">{m.label_crypto()}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each report.preYearDispositionSamples as s}
                    <tr class="border-t">
                      <td class="px-2 py-1 font-mono whitespace-nowrap">{s.date}</td>
                      <td class="px-2 py-1 truncate max-w-48" title={s.description}>{s.description}</td>
                      <td class="px-2 py-1 font-mono text-right whitespace-nowrap">{formatCurrency(s.fiatReceived, "EUR")}</td>
                      <td class="px-2 py-1 font-mono">{s.cryptoCurrencies.join(", ")}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Warnings -->
  {#if report.warnings.length > 0}
    <Card.Root>
      <Card.Header>
        <div class="flex items-center gap-2">
          <AlertTriangle class="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <Card.Title>{m.label_warnings()}</Card.Title>
        </div>
      </Card.Header>
      <Card.Content>
        <ul class="space-y-1 text-sm text-muted-foreground">
          {#each report.warnings as w}
            <li>{w}</li>
          {/each}
        </ul>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
