<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import Copy from "lucide-svelte/icons/copy";
    import RefreshCw from "lucide-svelte/icons/refresh-cw";
    import Pencil from "lucide-svelte/icons/pencil";
    import Trash2 from "lucide-svelte/icons/trash-2";
    import type { BlockchainConfig } from "$lib/blockchain-registry.js";

    let {
        config,
        account,
        syncing = false,
        busy = false,
        editingRowId = null,
        editingRowLabel = "",
        onSync,
        onRemove,
        onStartEdit,
        onCancelEdit,
        onSaveEdit,
        onEditLabelChange,
    }: {
        config: BlockchainConfig;
        account: { id: string; address: string; label: string; last_sync?: string | null };
        syncing?: boolean;
        busy?: boolean;
        editingRowId?: string | null;
        editingRowLabel?: string;
        onSync: () => void;
        onRemove: () => void;
        onStartEdit: () => void;
        onCancelEdit: () => void;
        onSaveEdit: () => void;
        onEditLabelChange: (value: string) => void;
    } = $props();

    const isEditing = $derived(editingRowId === account.id);

    function shortAddr(a: string): string {
        if (a.length <= config.addressSlicePrefix + config.addressSliceSuffix + 3) return a;
        return `${a.slice(0, config.addressSlicePrefix)}...${config.addressSliceSuffix > 0 ? a.slice(-config.addressSliceSuffix) : ""}`;
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }
</script>

<Table.Row>
    <Table.Cell class="font-mono text-sm">
        <div class="flex items-center gap-1">
            <Tooltip.Root>
                <Tooltip.Trigger class="truncate">
                    {shortAddr(account.address)}
                </Tooltip.Trigger>
                <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{account.address}</p></Tooltip.Content>
            </Tooltip.Root>
            <button onclick={() => copyToClipboard(account.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                <Copy class="h-3 w-3" />
            </button>
        </div>
    </Table.Cell>
    <Table.Cell>
        {#if isEditing}
            <Input class="h-7 text-xs" value={editingRowLabel}
                oninput={(e) => onEditLabelChange((e.target as HTMLInputElement).value)}
                onkeydown={(e) => { if (e.key === "Enter") onSaveEdit(); if (e.key === "Escape") onCancelEdit(); }} />
        {:else}
            {account.label}
        {/if}
    </Table.Cell>
    <Table.Cell>
        <Badge variant="secondary">{config.name}</Badge>
    </Table.Cell>
    <Table.Cell>
        <Badge variant="secondary">{config.name}</Badge>
    </Table.Cell>
    <Table.Cell class="text-sm text-muted-foreground">
        {account.last_sync
            ? new Date(account.last_sync).toLocaleDateString()
            : m.sources_never()}
    </Table.Cell>
    <Table.Cell class="text-right">
        <div class="flex justify-end gap-1">
            <Button
                variant="outline"
                size="sm"
                onclick={onSync}
                disabled={busy || isEditing}
            >
                <RefreshCw class="mr-1 h-3 w-3" />
                {syncing ? m.state_syncing() : m.sources_sync()}
            </Button>
            <Button
                variant={isEditing ? "default" : "outline"}
                size="sm"
                onclick={() => isEditing ? onCancelEdit() : onStartEdit()}
                disabled={busy}
            >
                <Pencil class="h-3 w-3" />
            </Button>
            <Button
                variant="outline"
                size="sm"
                onclick={onRemove}
                disabled={busy || isEditing}
            >
                <Trash2 class="h-3 w-3" />
            </Button>
        </div>
    </Table.Cell>
</Table.Row>
