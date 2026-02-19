<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Tax Report</h1>
    <p class="text-muted-foreground">French tax report (Formulaire 2086 &amp; 3916-bis).</p>
  </div>

  <Card.Root>
    <Card.Content class="py-8 space-y-4">
      <p class="text-sm text-muted-foreground text-center">
        Tax report generation is not yet available. For capital gains reporting, see the Gain/Loss Report.
      </p>
      <div class="flex justify-center">
        <Button variant="outline" href="/reports/gain-loss">View Gain/Loss Report</Button>
      </div>
    </Card.Content>
  </Card.Root>
</div>
