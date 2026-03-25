<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import Copy from "lucide-svelte/icons/copy";
    import RefreshCw from "lucide-svelte/icons/refresh-cw";
    import Pencil from "lucide-svelte/icons/pencil";
    import Trash2 from "lucide-svelte/icons/trash-2";
    import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
    import type { BlockchainConfig } from "$lib/blockchain-registry.js";
    import ChainIcon from "$lib/components/ChainIcon.svelte";

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

    function mobileShortAddr(a: string): string {
        if (a.length <= 18) return a;
        return `${a.slice(0, 8)}...${a.slice(-6)}`;
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }
</script>

<!-- Mobile row -->
<Table.Row class="sm:hidden">
    <Table.Cell colspan={99} class="py-2 px-3">
        <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="font-mono text-sm truncate">{mobileShortAddr(account.address)}</span>
                    <button onclick={() => copyToClipboard(account.address)} class="shrink-0 text-muted-foreground hover:text-foreground"><Copy class="h-3 w-3" /></button>
                    <Badge variant="secondary" class="gap-1 text-[10px]"><ChainIcon chainName={config.id} size={14} />{config.name}</Badge>
                </div>
                <div class="flex items-baseline gap-x-1.5 mt-0.5 text-xs text-muted-foreground">
                    {#if isEditing}
                        <Input class="h-6 text-xs" value={editingRowLabel}
                            oninput={(e) => onEditLabelChange((e.target as HTMLInputElement).value)}
                            onkeydown={(e) => { if (e.key === "Enter") onSaveEdit(); if (e.key === "Escape") onCancelEdit(); }} />
                    {:else}
                        <span>{account.label}</span>
                    {/if}
                    <span class="ml-auto shrink-0">{account.last_sync ? new Date(account.last_sync).toLocaleDateString() : m.sources_never()}</span>
                </div>
            </div>
            <div class="shrink-0">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                            <Button variant="ghost" size="icon-sm" {...props}><EllipsisVertical class="h-4 w-4" /></Button>
                        {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                        <DropdownMenu.Item disabled={busy} onclick={onSync}><RefreshCw class="mr-2 h-4 w-4" />{m.sources_sync()}</DropdownMenu.Item>
                        <DropdownMenu.Item onclick={() => isEditing ? onCancelEdit() : onStartEdit()}><Pencil class="mr-2 h-4 w-4" />{m.btn_rename()}</DropdownMenu.Item>
                        <DropdownMenu.Item disabled={busy || isEditing} onclick={onRemove}><Trash2 class="mr-2 h-4 w-4" />{m.btn_delete()}</DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>
        </div>
    </Table.Cell>
</Table.Row>

<!-- Desktop row -->
<Table.Row class="hidden sm:table-row">
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
        <Badge variant="secondary" class="gap-1"><ChainIcon chainName={config.id} size={14} />{config.name}</Badge>
    </Table.Cell>
    <Table.Cell>
        <Badge variant="secondary" class="gap-1"><ChainIcon chainName={config.id} size={14} />{config.name}</Badge>
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
