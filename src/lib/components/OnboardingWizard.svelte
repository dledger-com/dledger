<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import * as Select from "$lib/components/ui/select/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import { getBackend } from "$lib/backend.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { createDefaultAccounts, DEFAULT_ACCOUNTS, type DefaultAccountSet } from "$lib/accounts/defaults.js";
    import { invalidate } from "$lib/data/invalidation.js";
    import { goto } from "$app/navigation";
    import ChevronRight from "lucide-svelte/icons/chevron-right";
    import ChevronLeft from "lucide-svelte/icons/chevron-left";
    import Upload from "lucide-svelte/icons/upload";
    import Globe from "lucide-svelte/icons/globe";
    import Wallet from "lucide-svelte/icons/wallet";
    import Check from "lucide-svelte/icons/check";
    import { importDrop } from "$lib/data/import-drop.svelte.js";
    import { getFiatFlagUrl } from "$lib/data/coin-icons.svelte.js";
    import { COMMON_CURRENCIES } from "$lib/data/common-currencies.js";

    let {
        open = $bindable(true),
        onComplete,
    }: {
        open?: boolean;
        onComplete: () => void;
    } = $props();

    const settings = new SettingsStore();
    let step = $state(0);
    let currency = $state(settings.currency || "EUR");
    let preset = $state<DefaultAccountSet>("standard");
    let accountsCreated = $state(false);
    let sourceAdded = $state(false);

    const STEPS = [
        m.onboarding_step_welcome(),
        m.onboarding_step_source(),
        m.onboarding_step_done(),
    ];

    async function handleNext() {
        if (step === 0) {
            // Save currency
            settings.update({ currency });
            // Create accounts if not yet done
            if (!accountsCreated) {
                try {
                    await createDefaultAccounts(getBackend(), preset);
                    accountsCreated = true;
                    invalidate("accounts");
                } catch { /* may already exist */ }
            }
            step = 1;
        } else if (step === 1) {
            step = 2;
        } else {
            // Done
            onComplete();
            open = false;
        }
    }

    function handleBack() {
        if (step > 0) step--;
    }

    function handleSkipSource() {
        step = 2;
    }

    function handleFinish() {
        onComplete();
        open = false;
    }

    function handleImportFile() {
        // Trigger file picker via the global import drop system
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".csv,.tsv,.ofx,.qfx,.qbo,.pdf,.ledger,.beancount,.journal,.hledger,.dat,.zip,.gz";
        input.multiple = true;
        input.onchange = async () => {
            if (input.files && input.files.length > 0) {
                await importDrop.routeFiles(Array.from(input.files));
                sourceAdded = true;
            }
        };
        input.click();
    }

    function navigateToSources() {
        open = false;
        onComplete();
        goto("/sources");
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="max-w-lg">
        <!-- Step indicator -->
        <div class="flex justify-center gap-3 mb-6">
            {#each STEPS as label, i}
                <div class="flex items-center gap-2">
                    <div class="flex items-center justify-center h-6 w-6 rounded-full text-xs font-medium {i < step ? 'bg-primary text-primary-foreground' : i === step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}">
                        {#if i < step}
                            <Check class="h-3 w-3" />
                        {:else}
                            {i + 1}
                        {/if}
                    </div>
                    <span class="text-xs {i === step ? 'font-medium' : 'text-muted-foreground'} hidden sm:inline">{label}</span>
                    {#if i < STEPS.length - 1}
                        <ChevronRight class="h-3 w-3 text-muted-foreground hidden sm:inline" />
                    {/if}
                </div>
            {/each}
        </div>

        {#if step === 0}
            <!-- Step 1: Welcome + Config -->
            <div class="space-y-6">
                <div class="text-center space-y-2">
                    <h2 class="text-xl font-semibold">{m.onboarding_welcome()}</h2>
                    <p class="text-sm text-muted-foreground">{m.onboarding_welcome_desc()}</p>
                </div>

                <div class="space-y-4">
                    <div class="space-y-2">
                        <label class="text-sm font-medium">{m.onboarding_base_currency()}</label>
                        <p class="text-xs text-muted-foreground">{m.onboarding_base_currency_desc()}</p>
                        <Select.Root type="single" value={currency} onValueChange={(v) => { if (v) currency = v; }}>
                            <Select.Trigger class="w-full">
                                {@const cur = COMMON_CURRENCIES.find(c => c.code === currency)}
                                {@const flagUrl = getFiatFlagUrl(currency)}
                                <span class="inline-flex items-center gap-2">
                                    {#if flagUrl}<img src={flagUrl} alt="" class="size-4 rounded-full" />{/if}
                                    {cur ? `${cur.code} — ${cur.name}` : currency}
                                </span>
                            </Select.Trigger>
                            <Select.Content>
                                {#each COMMON_CURRENCIES as c}
                                    {@const flagUrl = getFiatFlagUrl(c.code)}
                                    <Select.Item value={c.code}>
                                        <span class="inline-flex items-center gap-2">
                                            {#if flagUrl}<img src={flagUrl} alt="" class="size-4 rounded-full" />{/if}
                                            {c.code} — {c.name}
                                        </span>
                                    </Select.Item>
                                {/each}
                            </Select.Content>
                        </Select.Root>
                    </div>

                    <div class="space-y-2">
                        <label class="text-sm font-medium">{m.onboarding_account_preset()}</label>
                        <p class="text-xs text-muted-foreground">{m.onboarding_account_preset_desc()}</p>
                        <div class="grid grid-cols-3 gap-2">
                            {#each [["minimal", m.onboarding_preset_minimal()], ["standard", m.onboarding_preset_standard()], ["comprehensive", m.onboarding_preset_comprehensive()]] as [value, label]}
                                <button
                                    class="rounded-lg border p-3 text-center text-sm transition-colors {preset === value ? 'border-primary bg-primary/5 font-medium' : 'hover:bg-muted'}"
                                    onclick={() => preset = value as DefaultAccountSet}
                                >
                                    {label}
                                    <span class="block text-xs text-muted-foreground">{DEFAULT_ACCOUNTS[value as DefaultAccountSet].length}</span>
                                </button>
                            {/each}
                        </div>
                        <!-- Account tree preview -->
                        <div class="max-h-48 overflow-y-auto rounded border bg-muted/30 p-3 text-xs font-mono space-y-0.5">
                            {#each DEFAULT_ACCOUNTS[preset] as account}
                                {@const depth = account.full_name.split(":").length - 1}
                                {@const leaf = account.full_name.split(":").pop()}
                                <div style="padding-left: {depth * 12}px" class="{account.is_postable ? '' : 'font-semibold text-muted-foreground'}">
                                    {leaf}
                                </div>
                            {/each}
                        </div>
                    </div>
                </div>

                <div class="flex justify-end">
                    <Button onclick={handleNext}>
                        {m.onboarding_step_source()}
                        <ChevronRight class="ml-1 h-4 w-4" />
                    </Button>
                </div>
            </div>

        {:else if step === 1}
            <!-- Step 2: Add Source -->
            <div class="space-y-6">
                <div class="text-center space-y-2">
                    <h2 class="text-xl font-semibold">{m.onboarding_add_source()}</h2>
                    <p class="text-sm text-muted-foreground">{m.onboarding_add_source_desc()}</p>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <button
                        class="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-muted transition-colors"
                        onclick={navigateToSources}
                    >
                        <Wallet class="h-6 w-6 text-muted-foreground" />
                        <span class="text-sm font-medium">{m.onboarding_exchanges()}</span>
                        <span class="text-xs text-muted-foreground text-center">API</span>
                    </button>
                    <button
                        class="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-muted transition-colors"
                        onclick={navigateToSources}
                    >
                        <Globe class="h-6 w-6 text-muted-foreground" />
                        <span class="text-sm font-medium">{m.onboarding_blockchains()}</span>
                        <span class="text-xs text-muted-foreground text-center">EVM, BTC, SOL...</span>
                    </button>
                    <button
                        class="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-muted transition-colors"
                        onclick={handleImportFile}
                    >
                        <Upload class="h-6 w-6 text-muted-foreground" />
                        <span class="text-sm font-medium">{m.onboarding_file_import()}</span>
                        <span class="text-xs text-muted-foreground text-center">CSV, OFX, PDF</span>
                    </button>
                </div>

                <div class="flex items-center justify-between">
                    <Button variant="ghost" onclick={handleBack}>
                        <ChevronLeft class="mr-1 h-4 w-4" />
                        {m.onboarding_step_welcome()}
                    </Button>
                    <Button variant="ghost" onclick={handleSkipSource}>
                        {m.onboarding_skip_source()}
                        <ChevronRight class="ml-1 h-4 w-4" />
                    </Button>
                </div>
            </div>

        {:else}
            <!-- Step 3: Done -->
            <div class="space-y-6">
                <div class="text-center space-y-2">
                    <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                        <Check class="h-6 w-6 text-primary" />
                    </div>
                    <h2 class="text-xl font-semibold">{m.onboarding_done_title()}</h2>
                    <p class="text-sm text-muted-foreground">{m.onboarding_done_desc()}</p>
                </div>

                <div class="flex justify-center">
                    <Button onclick={handleFinish}>
                        {m.onboarding_go_dashboard()}
                    </Button>
                </div>
            </div>
        {/if}
    </Dialog.Content>
</Dialog.Root>
