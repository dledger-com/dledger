<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";

  let {
    report,
    taxYear,
    hasSavedReport,
    foreignAccountCount,
    checklist = {},
    onChecklistChange,
  }: {
    report: FrenchTaxReport;
    taxYear: number;
    hasSavedReport: boolean;
    foreignAccountCount: number;
    checklist?: Record<string, boolean>;
    onChecklistChange?: (checklist: Record<string, boolean>) => void;
  } = $props();

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
  const activeBox = $derived(box3AN > 0 ? "3AN" : "3BN");
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));

  let form2086Done = $state(checklist.form2086 ?? false);
  let form2042cDone = $state(checklist.form2042c ?? false);
  let form3916bisDone = $state(checklist.form3916bis ?? false);
  let csvDownloaded = $state(checklist.csv ?? false);
  let acqCostNoted = $state(checklist.acqCost ?? false);

  // Re-sync when checklist prop changes (e.g. year switch)
  $effect(() => {
    form2086Done = checklist.form2086 ?? false;
    form2042cDone = checklist.form2042c ?? false;
    form3916bisDone = checklist.form3916bis ?? false;
    csvDownloaded = checklist.csv ?? false;
    acqCostNoted = checklist.acqCost ?? false;
  });

  const items = $derived([
    { label: `Report generated for ${taxYear}`, checked: hasSavedReport, auto: true },
    {
      label: `Form 2086 filled (${report.dispositions.length} disposition${report.dispositions.length !== 1 ? "s" : ""})`,
      checked: form2086Done,
      auto: false,
      key: "form2086" as const,
      skip: report.dispositions.length === 0,
    },
    {
      label: `Form 2042 C — box ${activeBox} filled`,
      checked: form2042cDone,
      auto: false,
      key: "form2042c" as const,
      skip: box3AN === 0 && box3BN === 0,
    },
    {
      label: `Form 3916-bis filed (${foreignAccountCount} foreign account${foreignAccountCount !== 1 ? "s" : ""})`,
      checked: form3916bisDone,
      auto: false,
      key: "form3916bis" as const,
      skip: foreignAccountCount === 0,
    },
    { label: "CSV backup downloaded", checked: csvDownloaded, auto: false, key: "csv" as const },
    {
      label: `Acquisition cost noted for next year: ${formatCurrency(finalA, "EUR")}`,
      checked: acqCostNoted,
      auto: false,
      key: "acqCost" as const,
    },
  ]);

  const activeItems = $derived(items.filter((it) => !("skip" in it) || !it.skip));
  const completedCount = $derived(activeItems.filter((it) => it.checked).length);
  const totalCount = $derived(activeItems.length);
  const progressPct = $derived(totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0);

  function toggle(key: string) {
    switch (key) {
      case "form2086": form2086Done = !form2086Done; break;
      case "form2042c": form2042cDone = !form2042cDone; break;
      case "form3916bis": form3916bisDone = !form3916bisDone; break;
      case "csv": csvDownloaded = !csvDownloaded; break;
      case "acqCost": acqCostNoted = !acqCostNoted; break;
    }
    onChecklistChange?.({
      form2086: form2086Done,
      form2042c: form2042cDone,
      form3916bis: form3916bisDone,
      csv: csvDownloaded,
      acqCost: acqCostNoted,
    });
  }
</script>

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Declaration Checklist — {taxYear}</Card.Title>
      <Card.Description>{completedCount}/{totalCount} completed</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- Progress bar -->
      <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          class="h-full rounded-full transition-[width] duration-200 {progressPct === 100 ? 'bg-green-500' : 'bg-primary'}"
          style="width: {progressPct}%"
        ></div>
      </div>

      <!-- Checklist items -->
      <ul class="space-y-2">
        {#each activeItems as item}
          <li class="flex items-center gap-3">
            {#if item.auto}
              <div class="flex h-5 w-5 items-center justify-center rounded border {item.checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input'}">
                {#if item.checked}
                  <svg class="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                {/if}
              </div>
              <span class="text-sm {item.checked ? 'text-muted-foreground line-through' : ''}">{item.label}</span>
              {#if item.checked}
                <span class="text-xs text-muted-foreground">(auto)</span>
              {/if}
            {:else}
              <button
                class="flex h-5 w-5 items-center justify-center rounded border cursor-pointer {item.checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input hover:border-primary/50'}"
                onclick={() => "key" in item && item.key && toggle(item.key)}
              >
                {#if item.checked}
                  <svg class="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                {/if}
              </button>
              <span class="text-sm {item.checked ? 'text-muted-foreground line-through' : ''}">{item.label}</span>
            {/if}
          </li>
        {/each}
      </ul>

      {#if progressPct === 100}
        <div class="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200 text-center">
          All done! Your {taxYear} crypto tax declaration is complete.
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
