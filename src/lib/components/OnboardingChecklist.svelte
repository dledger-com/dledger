<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Card from "$lib/components/ui/card/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import Check from "lucide-svelte/icons/check";
    import Circle from "lucide-svelte/icons/circle";
    import X from "lucide-svelte/icons/x";

    let {
        hasBaseCurrency = false,
        hasAccounts = false,
        hasSources = false,
        hasTransactions = false,
        onDismiss,
    }: {
        hasBaseCurrency?: boolean;
        hasAccounts?: boolean;
        hasSources?: boolean;
        hasTransactions?: boolean;
        onDismiss: () => void;
    } = $props();

    const steps = $derived([
        { label: m.onboarding_check_currency(), done: hasBaseCurrency, href: "/settings" },
        { label: m.onboarding_check_accounts(), done: hasAccounts, href: "/accounts" },
        { label: m.onboarding_check_source(), done: hasSources, href: "/sources" },
        { label: m.onboarding_check_transactions(), done: hasTransactions, href: "/sources" },
        { label: m.onboarding_check_portfolio(), done: hasTransactions, href: "/" },
    ]);

    const completedCount = $derived(steps.filter(s => s.done).length);
    const progress = $derived(completedCount / steps.length * 100);
    const allDone = $derived(completedCount === steps.length);
</script>

{#if !allDone}
    <Card.Root class="mb-6">
        <Card.Header class="pb-3">
            <div class="flex items-center justify-between">
                <Card.Title class="text-sm">{m.onboarding_checklist_title()}</Card.Title>
                <Button variant="ghost" size="sm" class="h-6 w-6 p-0" onclick={onDismiss}>
                    <X class="h-3 w-3" />
                </Button>
            </div>
            <!-- Progress bar -->
            <div class="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div class="h-full rounded-full bg-primary transition-all duration-500" style="width: {progress}%"></div>
            </div>
            <p class="text-xs text-muted-foreground">{completedCount} / {steps.length}</p>
        </Card.Header>
        <Card.Content class="pb-4">
            <ul class="space-y-2">
                {#each steps as step}
                    <li>
                        <a href={step.href} class="flex items-center gap-2 text-sm rounded-md px-2 py-1 -mx-2 hover:bg-muted transition-colors {step.done ? 'text-muted-foreground' : ''}">
                            {#if step.done}
                                <Check class="h-4 w-4 text-primary shrink-0" />
                                <span class="line-through">{step.label}</span>
                            {:else}
                                <Circle class="h-4 w-4 text-muted-foreground shrink-0" />
                                <span>{step.label}</span>
                            {/if}
                        </a>
                    </li>
                {/each}
            </ul>
        </Card.Content>
    </Card.Root>
{/if}
