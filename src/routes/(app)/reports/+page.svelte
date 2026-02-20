<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Reports</h1>
    <p class="text-muted-foreground">Generate and view financial reports.</p>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <a href="/reports/trial-balance" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Trial Balance</Card.Title>
          <Card.Description>View all account balances to verify debits equal credits.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/income-statement" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Income Statement</Card.Title>
          <Card.Description>Revenue and expenses for a given period.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/balance-sheet" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Balance Sheet</Card.Title>
          <Card.Description>Assets, liabilities, and equity at a point in time.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/gain-loss" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Gain/Loss Report</Card.Title>
          <Card.Description>Realized capital gains and losses from lot disposals.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/unrealized" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Unrealized Gains/Losses</Card.Title>
          <Card.Description>Unrealized gains on open positions valued at current rates.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/budget" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Budget Report</Card.Title>
          <Card.Description>Compare spending against budget targets.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/portfolio" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Portfolio Overview</Card.Title>
          <Card.Description>Multi-account portfolio view across all tracked wallets.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/defi" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>DeFi Positions</Card.Title>
          <Card.Description>Overview of DeFi protocol positions across lending, borrowing, and rewards.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/protocol-pnl" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Protocol P&L</Card.Title>
          <Card.Description>Revenue and expenses broken down by DeFi protocol.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/integrity" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Data Integrity</Card.Title>
          <Card.Description>Check ledger consistency and detect issues.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
    <a href="/reports/tax" class="block">
      <Card.Root class="transition-colors hover:bg-accent">
        <Card.Header>
          <Card.Title>Tax Report</Card.Title>
          <Card.Description>Tax-relevant summaries and categorisations.</Card.Description>
        </Card.Header>
      </Card.Root>
    </a>
  </div>
</div>
