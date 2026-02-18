<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import { formatCurrency } from "$lib/utils/format.js";
    import type { ConvertedSummary } from "$lib/utils/currency-convert.js";

    let { summary, label }: { summary: ConvertedSummary; label: string } =
        $props();
</script>

<Dialog.Root>
    <Dialog.Trigger>
        <Badge
            class="cursor-pointer font-mono text-xs ml-1 bg-orange-100 text-orange-600 dark:text-orange-400"
            >dbg</Badge
        >
    </Dialog.Trigger>
    <Dialog.Content class="max-w-fit">
        <Dialog.Header>
            <Dialog.Title>Conversion Breakdown: {label}</Dialog.Title>
            <Dialog.Description>
                How each currency contributes to the converted total in {summary.baseCurrency}.
            </Dialog.Description>
        </Dialog.Header>
        <Table.Root>
            <Table.Header>
                <Table.Row>
                    <Table.Head>Currency</Table.Head>
                    <Table.Head class="text-right">Amount</Table.Head>
                    <Table.Head class="text-right">Rate</Table.Head>
                    <Table.Head class="text-right">Base Amount</Table.Head>
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {#each summary.converted as entry}
                    <Table.Row>
                        <Table.Cell class="font-mono"
                            >{entry.currency}</Table.Cell
                        >
                        <Table.Cell class="text-right font-mono"
                            >{formatCurrency(
                                entry.amount,
                                entry.currency,
                            )}</Table.Cell
                        >
                        <Table.Cell class="text-right font-mono"
                            >{entry.rate === 1
                                ? "1"
                                : entry.rate.toFixed(6)}</Table.Cell
                        >
                        <Table.Cell class="text-right font-mono"
                            >{formatCurrency(
                                entry.baseAmount,
                                summary.baseCurrency,
                            )}</Table.Cell
                        >
                    </Table.Row>
                {/each}
                {#if summary.unconverted.length > 0}
                    <Table.Row>
                        <Table.Cell
                            colspan={4}
                            class="text-xs font-medium text-muted-foreground pt-4"
                            >Unconverted (excluded)</Table.Cell
                        >
                    </Table.Row>
                    {#each summary.unconverted as entry}
                        <Table.Row class="text-muted-foreground">
                            <Table.Cell class="font-mono"
                                >{entry.currency}</Table.Cell
                            >
                            <Table.Cell class="text-right font-mono"
                                >{formatCurrency(
                                    entry.amount,
                                    entry.currency,
                                )}</Table.Cell
                            >
                            <Table.Cell class="text-right font-mono"
                                >&mdash;</Table.Cell
                            >
                            <Table.Cell class="text-right text-xs italic"
                                >(excluded)</Table.Cell
                            >
                        </Table.Row>
                    {/each}
                {/if}
            </Table.Body>
            <Table.Footer>
                <Table.Row class="font-bold">
                    <Table.Cell colspan={3} class="text-right">Total</Table.Cell
                    >
                    <Table.Cell class="text-right font-mono"
                        >{formatCurrency(
                            summary.total,
                            summary.baseCurrency,
                        )}</Table.Cell
                    >
                </Table.Row>
            </Table.Footer>
        </Table.Root>
    </Dialog.Content>
</Dialog.Root>
