<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as m from "$paraglide/messages.js";

  const groups = $derived([
    {
      label: m.report_group_accounting(),
      items: [
        { href: "/reports/trial-balance", title: m.report_trial_balance(), desc: m.report_trial_balance_desc() },
        { href: "/reports/income-statement", title: m.report_income_statement(), desc: m.report_income_statement_desc() },
        { href: "/reports/balance-sheet", title: m.report_balance_sheet(), desc: m.report_balance_sheet_desc() },
        { href: "/reports/budget", title: m.report_budget(), desc: m.report_budget_desc() },
      ],
    },
    {
      label: m.report_group_investments(),
      items: [
        { href: "/reports/gain-loss", title: m.report_gain_loss(), desc: m.report_gain_loss_desc() },
        { href: "/reports/unrealized", title: m.report_unrealized(), desc: m.report_unrealized_desc() },
        { href: "/reports/portfolio", title: m.report_portfolio(), desc: m.report_portfolio_desc() },
      ],
    },
    {
      label: m.report_group_crypto(),
      items: [
        { href: "/reports/defi", title: m.report_defi_positions(), desc: m.report_defi_positions_desc() },
        { href: "/reports/protocol-pnl", title: m.report_protocol_pnl(), desc: m.report_protocol_pnl_desc() },
      ],
    },
    {
      label: m.report_group_tax(),
      items: [
        { href: "/reports/tax", title: m.report_tax(), desc: m.report_tax_desc() },
        { href: "/reports/tax-fr", title: m.report_french_crypto_tax(), desc: m.report_french_crypto_tax_desc() },
        { href: "/reports/integrity", title: m.report_integrity(), desc: m.report_integrity_desc() },
      ],
    },
  ]);
</script>

<div class="space-y-8">
  {#each groups as group}
    <section>
      <h2 class="text-sm font-medium text-muted-foreground mb-3">{group.label}</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each group.items as item}
          <a href={item.href} class="block">
            <Card.Root class="transition-colors hover:bg-accent">
              <Card.Header>
                <Card.Title>{item.title}</Card.Title>
                <Card.Description>{item.desc}</Card.Description>
              </Card.Header>
            </Card.Root>
          </a>
        {/each}
      </div>
    </section>
  {/each}
</div>
