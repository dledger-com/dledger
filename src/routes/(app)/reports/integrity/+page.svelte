<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { getBackend } from "$lib/backend.js";
  import { runIntegrityChecks, type IntegrityIssue } from "$lib/utils/integrity-check.js";

  let running = $state(false);
  let issues = $state<IntegrityIssue[] | null>(null);

  const errors = $derived(issues?.filter((i) => i.severity === "error") ?? []);
  const warnings = $derived(issues?.filter((i) => i.severity === "warning") ?? []);

  async function runChecks() {
    running = true;
    try {
      const backend = getBackend();
      issues = await runIntegrityChecks(backend);
    } catch (e) {
      issues = [{
        severity: "error",
        category: "System",
        message: `Integrity check failed: ${e instanceof Error ? e.message : String(e)}`,
      }];
    } finally {
      running = false;
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Data Integrity Check</h1>
      <p class="text-muted-foreground">Verify ledger consistency and detect issues.</p>
    </div>
    <Button onclick={runChecks} disabled={running}>
      {running ? "Running..." : "Run Checks"}
    </Button>
  </div>

  {#if running}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-8 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if issues !== null}
    {#if issues.length === 0}
      <Card.Root class="border-green-200 dark:border-green-800">
        <Card.Content class="py-8">
          <div class="text-center space-y-2">
            <p class="text-lg font-medium text-green-600 dark:text-green-400">All checks passed</p>
            <p class="text-sm text-muted-foreground">No issues detected in your ledger data.</p>
          </div>
        </Card.Content>
      </Card.Root>
    {:else}
      <!-- Summary -->
      <div class="flex gap-4">
        {#if errors.length > 0}
          <Card.Root class="flex-1 border-red-200 dark:border-red-800">
            <Card.Header>
              <Card.Description>Errors</Card.Description>
              <Card.Title class="text-2xl text-red-600 dark:text-red-400">{errors.length}</Card.Title>
            </Card.Header>
          </Card.Root>
        {/if}
        {#if warnings.length > 0}
          <Card.Root class="flex-1 border-yellow-200 dark:border-yellow-800">
            <Card.Header>
              <Card.Description>Warnings</Card.Description>
              <Card.Title class="text-2xl text-yellow-600 dark:text-yellow-400">{warnings.length}</Card.Title>
            </Card.Header>
          </Card.Root>
        {/if}
      </div>

      <!-- Errors -->
      {#if errors.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title class="text-red-600 dark:text-red-400">Errors</Card.Title>
          </Card.Header>
          <Card.Content>
            <div class="space-y-3">
              {#each errors as issue}
                <div class="flex items-start gap-3 p-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20">
                  <Badge variant="destructive" class="shrink-0">{issue.category}</Badge>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm">{issue.message}</p>
                    {#if issue.entityType && issue.entityId}
                      <a href="/{issue.entityType === 'journal_entry' ? 'journal' : 'accounts'}/{issue.entityId}"
                         class="text-xs text-muted-foreground hover:underline mt-1 block">
                        View {issue.entityType}
                      </a>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

      <!-- Warnings -->
      {#if warnings.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title class="text-yellow-600 dark:text-yellow-400">Warnings</Card.Title>
          </Card.Header>
          <Card.Content>
            <div class="space-y-3">
              {#each warnings as issue}
                <div class="flex items-start gap-3 p-3 rounded-md border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950/20">
                  <Badge variant="outline" class="shrink-0">{issue.category}</Badge>
                  <p class="text-sm flex-1">{issue.message}</p>
                </div>
              {/each}
            </div>
          </Card.Content>
        </Card.Root>
      {/if}
    {/if}
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          Click "Run Checks" to verify your ledger data integrity.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
