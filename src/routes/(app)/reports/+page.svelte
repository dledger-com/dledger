<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as m from "$paraglide/messages.js";
</script>

<div class="space-y-6">
  <div class="grid gap-4 sm:grid-cols-2">
    <a href="/reports/trial-balance" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_trial_balance()}</Card.Title>
          <Card.Description>{m.report_trial_balance_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/income-statement" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_income_statement()}</Card.Title>
          <Card.Description>{m.report_income_statement_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/balance-sheet" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_balance_sheet()}</Card.Title>
          <Card.Description>{m.report_balance_sheet_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/gain-loss" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_gain_loss()}</Card.Title>
          <Card.Description>{m.report_gain_loss_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/unrealized" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_unrealized()}</Card.Title>
          <Card.Description>{m.report_unrealized_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/budget" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_budget()}</Card.Title>
          <Card.Description>{m.report_budget_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/portfolio" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_portfolio()}</Card.Title>
          <Card.Description>{m.report_portfolio_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/defi" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_defi_positions()}</Card.Title>
          <Card.Description>{m.report_defi_positions_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/protocol-pnl" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_protocol_pnl()}</Card.Title>
          <Card.Description>{m.report_protocol_pnl_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/integrity" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_integrity()}</Card.Title>
          <Card.Description>{m.report_integrity_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/tax" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_tax()}</Card.Title>
          <Card.Description>{m.report_tax_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/tax-fr" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>{m.report_french_crypto_tax()}</Card.Title>
          <Card.Description>{m.report_french_crypto_tax_desc()}</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
  </div>
</div>
