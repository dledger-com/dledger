<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { getBackend } from "$lib/backend.js";
  import { computeDefiPositions } from "$lib/utils/defi-positions.js";
  import type { ProtocolSummary } from "$lib/utils/defi-positions.js";

  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let protocols = $state<ProtocolSummary[]>([]);
  let error = $state<string | null>(null);

  async function generate() {
    loading = true;
    error = null;
    protocols = [];
    try {
      protocols = await computeDefiPositions(
        getBackend(),
        settings.currency,
        asOf,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(generate);

  let hasPositions = $derived(protocols.length > 0);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">DeFi Positions</h1>
    <p class="text-muted-foreground">Overview of DeFi protocol positions across lending, borrowing, and rewards.</p>
  </div>

  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">As of Date</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? "Loading..." : "Generate"}
    </Button>
  </div>

  {#if loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if !hasPositions}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No DeFi positions found. Import transactions from DeFi protocols to see positions here.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    {#each protocols as proto}
      {@const hasSupplies = proto.supplies.length > 0}
      {@const hasBorrows = proto.borrows.length > 0}
      {@const hasRewards = proto.rewards.length > 0}
      <Card.Root>
        <Card.Header>
          <div class="flex items-center justify-between">
            <Card.Title>{proto.displayName}</Card.Title>
            {#if proto.totalBaseValue !== undefined}
              {@const total = parseFloat(proto.totalBaseValue)}
              <span class="text-lg font-semibold {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                {formatCurrency(total, settings.currency)}
              </span>
            {/if}
          </div>
        </Card.Header>
        <Card.Content class="space-y-4">
          {#if hasSupplies}
            <div>
              <h3 class="text-sm font-medium text-muted-foreground mb-2">Supplies</h3>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Currency</Table.Head>
                    <Table.Head>Account</Table.Head>
                    <Table.Head class="text-right">Balance</Table.Head>
                    {#if proto.supplies.some((p) => p.baseValue !== undefined)}
                      <Table.Head class="text-right">Value ({settings.currency})</Table.Head>
                    {/if}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each proto.supplies as pos}
                    <Table.Row>
                      <Table.Cell>
                        <Badge variant="outline">{pos.currency}</Badge>
                      </Table.Cell>
                      <Table.Cell class="text-sm">{pos.account}</Table.Cell>
                      <Table.Cell class="text-right font-mono">{pos.balance}</Table.Cell>
                      {#if proto.supplies.some((p) => p.baseValue !== undefined)}
                        <Table.Cell class="text-right font-mono">
                          {pos.baseValue !== undefined ? formatCurrency(parseFloat(pos.baseValue), settings.currency) : "-"}
                        </Table.Cell>
                      {/if}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}

          {#if hasBorrows}
            <div>
              <h3 class="text-sm font-medium text-muted-foreground mb-2">Borrows</h3>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Currency</Table.Head>
                    <Table.Head>Account</Table.Head>
                    <Table.Head class="text-right">Balance</Table.Head>
                    {#if proto.borrows.some((p) => p.baseValue !== undefined)}
                      <Table.Head class="text-right">Value ({settings.currency})</Table.Head>
                    {/if}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each proto.borrows as pos}
                    <Table.Row>
                      <Table.Cell>
                        <Badge variant="outline">{pos.currency}</Badge>
                      </Table.Cell>
                      <Table.Cell class="text-sm">{pos.account}</Table.Cell>
                      <Table.Cell class="text-right font-mono text-red-600 dark:text-red-400">{pos.balance}</Table.Cell>
                      {#if proto.borrows.some((p) => p.baseValue !== undefined)}
                        <Table.Cell class="text-right font-mono text-red-600 dark:text-red-400">
                          {pos.baseValue !== undefined ? formatCurrency(parseFloat(pos.baseValue), settings.currency) : "-"}
                        </Table.Cell>
                      {/if}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}

          {#if hasRewards}
            <div>
              <h3 class="text-sm font-medium text-muted-foreground mb-2">Rewards</h3>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Currency</Table.Head>
                    <Table.Head>Account</Table.Head>
                    <Table.Head class="text-right">Balance</Table.Head>
                    {#if proto.rewards.some((p) => p.baseValue !== undefined)}
                      <Table.Head class="text-right">Value ({settings.currency})</Table.Head>
                    {/if}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each proto.rewards as pos}
                    <Table.Row>
                      <Table.Cell>
                        <Badge variant="outline">{pos.currency}</Badge>
                      </Table.Cell>
                      <Table.Cell class="text-sm">{pos.account}</Table.Cell>
                      <Table.Cell class="text-right font-mono text-green-600 dark:text-green-400">{pos.balance}</Table.Cell>
                      {#if proto.rewards.some((p) => p.baseValue !== undefined)}
                        <Table.Cell class="text-right font-mono text-green-600 dark:text-green-400">
                          {pos.baseValue !== undefined ? formatCurrency(parseFloat(pos.baseValue), settings.currency) : "-"}
                        </Table.Cell>
                      {/if}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>
