<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { FrenchTaxReport, Disposition } from "$lib/utils/french-tax.js";
  import Copy from "lucide-svelte/icons/copy";
  import ChevronLeft from "lucide-svelte/icons/chevron-left";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import Info from "lucide-svelte/icons/info";
  import { toast } from "svelte-sonner";
  import * as m from "$paraglide/messages.js";

  let { report }: { report: FrenchTaxReport } = $props();

  const CESSIONS_PER_PAGE = 5;
  let currentPage = $state(1);

  // Reset to page 1 when the year changes
  $effect(() => {
    report.taxYear;
    currentPage = 1;
  });

  const totalPages = $derived(Math.max(1, Math.ceil(report.dispositions.length / CESSIONS_PER_PAGE)));

  const pageDispositions = $derived(
    report.dispositions.slice((currentPage - 1) * CESSIONS_PER_PAGE, currentPage * CESSIONS_PER_PAGE)
  );

  // Always render 5 columns (pad with nulls if the last page has fewer cessions),
  // matching the printed form's fixed-column layout.
  const cessionSlots = $derived<(Disposition | null)[]>(
    Array.from({ length: CESSIONS_PER_PAGE }, (_, i) => pageDispositions[i] ?? null)
  );

  // Per-cession derived line values. dledger doesn't track fees (l.214) or soultes
  // (l.216, 221, 222) separately, so for typical crypto→fiat the form's l.213, 215,
  // 217, 218 all equal our fiatReceived, and l.220 == l.223 == acquisitionCostBefore.
  interface LineValues {
    date: string;
    l212_V: number;
    l213_grossSale: number;
    l214_fees: number;
    l215_netFees: number;
    l216_soulte: number;
    l217_netSoultes: number;
    l218_netFeesSoultes: number;
    l220_acqTotal: number;
    l221_fractions: number;
    l222_priorSoultes: number;
    l223_netAcq: number;
    pv: number;
  }

  function computeLines(disp: Disposition): LineValues {
    const C = parseFloat(disp.fiatReceived);
    const V = parseFloat(disp.portfolioValue);
    const A = parseFloat(disp.acquisitionCostBefore);
    return {
      date: disp.date,
      l212_V: V,
      l213_grossSale: C,
      l214_fees: 0,
      l215_netFees: C,
      l216_soulte: 0,
      l217_netSoultes: C,
      l218_netFeesSoultes: C,
      l220_acqTotal: A,
      l221_fractions: 0,
      l222_priorSoultes: 0,
      l223_netAcq: A,
      pv: parseFloat(disp.plusValue),
    };
  }

  const pageLines = $derived(
    cessionSlots.map(d => (d ? computeLines(d) : null))
  );

  // A row is dimmed when every cession on this page has 0 (or no value) for it.
  // Helps users skip past the always-zero rows that French crypto traders rarely use.
  function rowAllZero(field: keyof LineValues): boolean {
    return pageLines.every(lv => {
      if (!lv) return true;
      const v = lv[field];
      return typeof v === "number" ? v === 0 : !v;
    });
  }

  // French number formatting: 1 234,56
  const numberFormatter = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  function fmt(v: number): string {
    return numberFormatter.format(v);
  }

  function fmtDate(iso: string): string {
    const [y, mo, d] = iso.split("-");
    return `${d}/${mo}/${y}`;
  }

  // Plain (un-formatted) raw values that copy to the clipboard.
  // For numeric fields we emit the French decimal-comma form so it round-trips
  // into the official online form (or a French-locale spreadsheet) cleanly.
  function rawNumber(v: number): string {
    return v.toFixed(2).replace(".", ",");
  }

  async function copyCell(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} : ${value}`, { duration: 1200 });
  }

  // Global l.224 — total PV across ALL dispositions, not just this page.
  const totalPV = $derived(
    report.dispositions.reduce((sum, d) => sum + parseFloat(d.plusValue), 0)
  );

  // Row definitions: (line number, label, computed-key, tooltip, sign-aware?)
  // Layout helpers — keeping the cell renderer DRY.
  type RowKey = keyof LineValues;

  interface RowDef {
    line: string;
    label: string;
    key: RowKey | "pv-formula";
    tooltip?: string;
    section?: "header" | "cession-price" | "acq-price" | "pv";
  }

  const rows: RowDef[] = [
    { line: "211", label: "Date de la cession", key: "date", section: "header" },
    { line: "212", label: "Valeur globale du portefeuille au moment de la cession", key: "l212_V", section: "header" },
    { line: "213", label: "Prix de cession", key: "l213_grossSale", section: "cession-price" },
    { line: "214", label: "Frais de cession", key: "l214_fees",
      tooltip: "dledger ne suit pas les frais séparément : ils sont déjà inclus dans le prix de cession net importé (l.213). Pour les déclarer séparément, modifiez l'écriture du journal correspondante.",
      section: "cession-price" },
    { line: "215", label: "Prix de cession net des frais (l.213 − l.214)", key: "l215_netFees", section: "cession-price" },
    { line: "216", label: "Soulte reçue ou versée lors de la cession", key: "l216_soulte",
      tooltip: "Non applicable pour les cessions crypto vers fiat (les soultes concernent les échanges avec compensation en espèces).",
      section: "cession-price" },
    { line: "217", label: "Prix de cession net des soultes : (l.213 − l.216) ou (l.213 + l.216)", key: "l217_netSoultes", section: "cession-price" },
    { line: "218", label: "Prix de cession net des frais et soultes : (l.213 − l.214 − l.216) ou (l.213 − l.214 + l.216)", key: "l218_netFeesSoultes", section: "cession-price" },
    { line: "220", label: "Prix total d'acquisition", key: "l220_acqTotal", section: "acq-price" },
    { line: "221", label: "Fractions de capital initial contenues dans le prix total d'acquisition", key: "l221_fractions",
      tooltip: "Concerne les actifs numériques issus d'un capital initial déjà imposé (rare pour les particuliers).",
      section: "acq-price" },
    { line: "222", label: "Soultes reçues en cas d'échanges antérieurs à la cession", key: "l222_priorSoultes",
      tooltip: "Soultes éventuelles reçues lors de précédents échanges crypto vers crypto (rare).",
      section: "acq-price" },
    { line: "223", label: "Prix total d'acquisition net : (l.220 − l.221 − l.222)", key: "l223_netAcq", section: "acq-price" },
    { line: "", label: "Plus-values et moins-values : l.218 − [l.223 × (l.217 / l.212)]", key: "pv-formula", section: "pv" },
  ];

  function valueFor(lv: LineValues | null, key: RowKey | "pv-formula"): { display: string; raw: string; isZero: boolean } {
    if (!lv) return { display: "", raw: "", isZero: true };
    if (key === "date") return { display: fmtDate(lv.date), raw: fmtDate(lv.date), isZero: false };
    if (key === "pv-formula") {
      const sign = lv.pv > 0 ? "+" : lv.pv < 0 ? "" : "";
      return { display: `${sign}${fmt(lv.pv)}`, raw: rawNumber(lv.pv), isZero: lv.pv === 0 };
    }
    const v = lv[key];
    if (typeof v === "number") {
      return { display: fmt(v), raw: rawNumber(v), isZero: v === 0 };
    }
    return { display: String(v), raw: String(v), isZero: false };
  }
</script>

<div class="space-y-4">
  {#if report.dispositions.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.report_french_tax_2086_empty({ year: String(report.taxYear) })}
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Page navigator -->
    {#if totalPages > 1}
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted-foreground">
          Page {currentPage} / {totalPages} — cessions {(currentPage - 1) * CESSIONS_PER_PAGE + 1}–{Math.min(currentPage * CESSIONS_PER_PAGE, report.dispositions.length)} sur {report.dispositions.length}
        </span>
        <div class="flex gap-1">
          <Button variant="outline" size="sm" disabled={currentPage === 1} onclick={() => { currentPage--; }}>
            <ChevronLeft class="h-4 w-4" />
            Précédent
          </Button>
          <Button variant="outline" size="sm" disabled={currentPage === totalPages} onclick={() => { currentPage++; }}>
            Suivant
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>
    {/if}

    <Card.Root>
      <Card.Header class="pb-3">
        <Card.Title class="text-base">2 — Plus-values ou moins-values réalisées directement</Card.Title>
        <Card.Description>
          Saisissez ces valeurs ligne par ligne dans le formulaire 2086 officiel. Cliquez sur une cellule pour copier sa valeur (format français avec virgule décimale).
        </Card.Description>
      </Card.Header>
      <Card.Content class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
          <colgroup>
            <col class="w-12" />
            <col class="w-72" />
            <col span="5" />
          </colgroup>
          <thead>
            <tr class="border-b">
              <th class="text-left text-xs font-medium text-muted-foreground py-2 px-2">Ligne</th>
              <th class="text-left text-xs font-medium text-muted-foreground py-2 px-2">Champ</th>
              {#each cessionSlots as _, i}
                <th class="text-center text-xs font-medium py-2 px-2 border-l">
                  Cession {(currentPage - 1) * CESSIONS_PER_PAGE + i + 1}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as row, rowIdx}
              {@const isAllZero = row.key !== "date" && row.key !== "pv-formula" && rowAllZero(row.key as RowKey)}
              {@const isFormula = row.key === "pv-formula"}
              {@const sectionStart = rowIdx > 0 && rows[rowIdx - 1].section !== row.section}
              <tr class="border-b {isAllZero ? 'opacity-40' : ''} {isFormula ? 'bg-muted/30 font-medium' : ''} {sectionStart ? 'border-t-2 border-t-muted' : ''}">
                <td class="py-1.5 px-2 font-mono text-xs text-muted-foreground align-top">{row.line}</td>
                <td class="py-1.5 px-2 text-xs align-top">
                  <div class="flex items-start gap-1">
                    <span class="leading-tight">{row.label}</span>
                    {#if row.tooltip}
                      <Tooltip.Root>
                        <Tooltip.Trigger class="shrink-0 mt-0.5">
                          <Info class="h-3 w-3 text-muted-foreground" />
                        </Tooltip.Trigger>
                        <Tooltip.Content><p class="text-xs max-w-64">{row.tooltip}</p></Tooltip.Content>
                      </Tooltip.Root>
                    {/if}
                  </div>
                </td>
                {#each pageLines as lv, colIdx}
                  {@const cell = valueFor(lv, row.key)}
                  <td class="py-1.5 px-1 border-l text-right align-top">
                    {#if cell.display}
                      <button
                        type="button"
                        class="group/cell w-full inline-flex items-center justify-end gap-1 font-mono text-xs px-2 py-1 rounded hover:bg-muted/60 transition-colors {isFormula ? (lv && lv.pv >= 0 ? 'text-positive' : 'text-negative') : ''}"
                        onclick={() => copyCell(cell.raw, `Cession ${(currentPage - 1) * CESSIONS_PER_PAGE + colIdx + 1} · l.${row.line || 'PV'}`)}
                        title="Cliquer pour copier"
                      >
                        <Copy class="h-3 w-3 opacity-0 group-hover/cell:opacity-50 transition-opacity" />
                        <span>{cell.display}</span>
                      </button>
                    {:else}
                      <span class="text-muted-foreground/40 text-xs">—</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </Card.Content>
    </Card.Root>

    <!-- l.224 footer total (always global across all pages) -->
    <Card.Root>
      <Card.Content class="py-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="flex items-center gap-3">
            <span class="font-mono text-xs text-muted-foreground">224</span>
            <span class="text-sm">Plus-value ou moins-value globale du déclarant 1</span>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Info class="h-3 w-3 text-muted-foreground" />
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p class="text-xs max-w-64">Somme des plus-values et moins-values de toutes les cessions de l'année (toutes pages confondues).</p>
              </Tooltip.Content>
            </Tooltip.Root>
          </div>
          <button
            type="button"
            class="group/cell inline-flex items-center gap-2 px-3 py-1.5 rounded border hover:bg-muted/60 transition-colors font-mono {totalPV >= 0 ? 'text-positive' : 'text-negative'}"
            onclick={() => copyCell(rawNumber(totalPV), "l.224 (total déclarant 1)")}
            title="Cliquer pour copier"
          >
            <Copy class="h-3 w-3 opacity-0 group-hover/cell:opacity-50 transition-opacity" />
            <span class="text-sm font-medium">
              {totalPV >= 0 ? "+" : ""}{fmt(totalPV)} €
            </span>
          </button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
