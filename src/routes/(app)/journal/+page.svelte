<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";
    import * as m from "$paraglide/messages.js";
    import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
    import { page } from "$app/state";
    import { goto, pushState, replaceState } from "$app/navigation";
    import * as Card from "$lib/components/ui/card/index.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import { Skeleton } from "$lib/components/ui/skeleton/index.js";
    import { JournalStore } from "$lib/data/journal.svelte.js";
    import { onInvalidate } from "$lib/data/invalidation.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { formatCurrency } from "$lib/utils/format.js";
    import { convertBalances } from "$lib/utils/currency-convert.js";
    import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
    import type {
        CurrencyBalance,
        JournalEntry,
        LineItem,
    } from "$lib/types/index.js";
    import { filterHiddenEntries } from "$lib/utils/currency-filter.js";
    import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
    import { getBackend } from "$lib/backend.js";
    import { toast } from "svelte-sonner";
    import Loader from "lucide-svelte/icons/loader";
    import ArrowUp from "lucide-svelte/icons/arrow-up";
    import {
        derivePositionLabel,
        type JournalSortKey,
    } from "$lib/utils/scroll-position.js";
    import { scaleSqrt } from "d3-scale";
    import {
        chooseGranularity,
        bucketKey,
        bucketStartDate,
        dateToBucketDate,
        formatXAxisLabel,
        formatTooltipHeader,
        type ChartGranularity,
    } from "$lib/utils/chart-granularity.js";
    import {
        mainCounterparty as mainCounterpartyUtil,
        mainCounterpartyShort as mainCounterpartyShortUtil,
        mainCounterpartyFull as mainCounterpartyFullUtil,
        entryAmountDisplay as entryAmountDisplayUtil,
        entryAmountParts as entryAmountPartsUtil,
        amountColorClass as amountColorClassUtil,
        type AmountDirection,
        type AmountPart,
    } from "$lib/utils/journal-display.js";

    import MatchDialog from "$lib/components/MatchDialog.svelte";
    import ReinterpretPreviewDialog from "$lib/components/ReinterpretPreviewDialog.svelte";
    import { extractAllCandidates } from "$lib/matching/extract.js";
    import { findMatches } from "$lib/matching/score.js";
    import type { MatchCandidate } from "$lib/matching/types.js";
    import type { Account } from "$lib/types/index.js";
    import { findReinterpretCandidates, type ReinterpretCandidate } from "$lib/reinterpret.js";

    import ListFilter from "$lib/components/ListFilter.svelte";
    import TagDisplay from "$lib/components/TagDisplay.svelte";
    import LinkDisplay from "$lib/components/LinkDisplay.svelte";
    import { parseTags, TAGS_META_KEY, NOTE_META_KEY } from "$lib/utils/tags.js";
    import StickyNote from "lucide-svelte/icons/sticky-note";
    import { formatExtension, type LedgerFormat } from "$lib/ledger-format.js";
    import { exportLedger } from "$lib/browser-ledger-file.js";
    import SortableHeader from "$lib/components/SortableHeader.svelte";
    import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
    import type { TransactionFilter } from "$lib/types/index.js";
    import { createVirtualizer } from "$lib/utils/virtual.svelte.js";
    import JournalEntryDrawer from "$lib/components/JournalEntryDrawer.svelte";
    import JournalEntryDialog from "$lib/components/JournalEntryDialog.svelte";
    import SourceIcon from "$lib/components/SourceIcon.svelte";
    import CoinIcon from "$lib/components/CoinIcon.svelte";

    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
    import * as Popover from "$lib/components/ui/popover/index.js";
    import * as ButtonGroup from "$lib/components/ui/button-group/index.js";
    import { serializeTags } from "$lib/utils/tags.js";
    import TagInput from "$lib/components/TagInput.svelte";
    import LinkInput from "$lib/components/LinkInput.svelte";
    import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
    import Plus from "lucide-svelte/icons/plus";
    import X from "lucide-svelte/icons/x";
    import Check from "lucide-svelte/icons/check";
    import Tag from "lucide-svelte/icons/tag";
    import Link2 from "lucide-svelte/icons/link-2";
    import SlidersHorizontal from "lucide-svelte/icons/sliders-horizontal";
    import Separator from "$lib/components/ui/separator/separator.svelte";
    import { Checkbox } from "$lib/components/ui/checkbox/index.js";
    import SearchIcon from "lucide-svelte/icons/search";
    import Filter from "lucide-svelte/icons/filter";
    import { createSvelteTable } from "$lib/components/ui/data-table/data-table.svelte.js";
    import {
        type ColumnDef,
        getCoreRowModel,
        type RowSelectionState,
        type VisibilityState,
    } from "@tanstack/table-core";
    import { invalidate } from "$lib/data/invalidation.js";

    const granularityLabel: Record<ChartGranularity, () => string> = {
        day: () => m.date_day(),
        week: () => m.date_week(),
        month: () => m.date_month(),
        quarter: () => m.date_quarter(),
        year: () => m.date_year(),
    };

    const store = new JournalStore();
    const settings = new SettingsStore();
    let loadController: AbortController | undefined;

    // ── Journal Entry Drawer (view) & Dialog (new/edit) ──
    let drawerOpen = $state(false);
    let drawerEntryId = $state<string | null>(null);

    let dialogOpen = $state(false);
    let dialogMode = $state<"new" | "edit">("new");
    let dialogEntryId = $state<string | null>(null);

    function openEntryDrawer(mode: "view" | "new" | "edit", entryId?: string) {
        if (mode === "view") {
            drawerEntryId = entryId ?? null;
            drawerOpen = true;
            if (entryId) {
                const url = new URL(window.location.href);
                if (url.searchParams.get("entry") !== entryId) {
                    url.searchParams.set("entry", entryId);
                    pushState(url, {});
                }
            }
        } else {
            dialogMode = mode;
            dialogEntryId = entryId ?? null;
            dialogOpen = true;
        }
    }

    function closeEntryDrawer() {
        drawerOpen = false;
        drawerEntryId = null;
        const url = new URL(window.location.href);
        if (url.searchParams.has("entry")) {
            url.searchParams.delete("entry");
            replaceState(url, {});
        }
    }

    // Handle initial page load + browser back/forward for drawer URL state
    onMount(() => {
        const entryId = new URL(window.location.href).searchParams.get("entry");
        if (entryId) {
            drawerEntryId = entryId;
            drawerOpen = true;
        }
        function handlePopstate() {
            const id = new URL(window.location.href).searchParams.get("entry");
            if (id && !drawerOpen) {
                drawerEntryId = id;
                drawerOpen = true;
            } else if (!id && drawerOpen) {
                drawerOpen = false;
                drawerEntryId = null;
            }
        }
        window.addEventListener("popstate", handlePopstate);
        return () => window.removeEventListener("popstate", handlePopstate);
    });

    /** Helper to get line items for an entry from the store cache */
    function getItems(entryId: string): LineItem[] {
        return store.lineItemCache.get(entryId) ?? [];
    }

    // Reload when journal data changes elsewhere (imports, cross-tab)
    const unsubJournal = onInvalidate("journal", () => {
        store.loadAll();
        // Refresh account map + tag/link options (new accounts/tags/links may have been added via import)
        const b = getBackend();
        b.listAccounts().then((accounts) => {
            accountOptions = accounts
                .filter((a: Account) => !a.is_archived)
                .map((a: Account) => ({ value: a.id, label: a.full_name }))
                .sort((a: { label: string }, b: { label: string }) =>
                    a.label.localeCompare(b.label),
                );
            const map = new Map<string, string>();
            for (const a of accounts) map.set(a.id, a.full_name);
            accountIdToName = map;
        });
        tagOptionsLoading = true;
        linkOptionsLoading = true;
        b.getAllTagValues().then((tags) => {
            tagOptions = tags.map((t) => ({ value: t, label: t }));
            tagOptionsLoading = false;
        });
        b.getAllLinkNames().then((links) => {
            linkOptions = links.map((l) => ({ value: l, label: l }));
            linkOptionsLoading = false;
        });
    });
    onDestroy(() => {
        loadController?.abort();
        unsubJournal();
        clearTopBarActions();
    });

    // Register page actions in the TopBar
    $effect(() => {
        // Read reactive deps so $effect re-runs when they change
        const _fm = findingMatches;
        const _dd = detectingDuplicates;
        const _ri = reinterpreting;
        setTopBarActions([
            { type: 'button', label: m.journal_new_entry(), onclick: () => openEntryDrawer("new"), fab: true, fabIcon: Plus },
            {
                type: 'menu',
                items: [
                    { label: m.journal_analysis(), header: true },
                    { label: '', separator: true },
                    {
                        label: _fm ? m.journal_finding() : m.journal_find_matches(),
                        disabled: _fm,
                        onclick: handleFindMatches,
                    },
                    {
                        label: _dd ? m.journal_detecting() : m.journal_detect_duplicates(),
                        disabled: _dd,
                        onclick: handleDetectDuplicates,
                    },
                    {
                        label: _ri ? m.journal_reinterpreting() : m.journal_reinterpret(),
                        disabled: _ri,
                        onclick: handleReinterpret,
                    },
                    { label: '', separator: true },
                    { label: m.btn_export(), header: true },
                    { label: '', separator: true },
                    { label: 'Beancount (.beancount)', onclick: () => handleExport('beancount') },
                    { label: 'hledger (.journal)', onclick: () => handleExport('hledger') },
                    { label: 'ledger (.ledger)', onclick: () => handleExport('ledger') },
                ],
            },
        ]);
    });

    // Load faceted filter options (deferred to avoid blocking initial render)
    $effect(() => {
        const backend = getBackend();
        setTimeout(() => {
            backend.listAccounts().then((accounts) => {
                accountOptions = accounts
                    .filter((a: Account) => !a.is_archived)
                    .map((a: Account) => ({ value: a.id, label: a.full_name }))
                    .sort((a: { label: string }, b: { label: string }) =>
                        a.label.localeCompare(b.label),
                    );
                const map = new Map<string, string>();
                for (const a of accounts) map.set(a.id, a.full_name);
                accountIdToName = map;
                accountOptionsLoading = false;
            });
            backend.getAllTagValues().then((tags) => {
                tagOptions = tags.map((t) => ({ value: t, label: t }));
                tagOptionsLoading = false;
            });
            backend.getAllLinkNames().then((links) => {
                linkOptions = links.map((l) => ({ value: l, label: l }));
                linkOptionsLoading = false;
            });
        }, 0);
    });

    let showChart = $state(settings.settings.journalShowChart !== false);
    let journalShowSourceIcons = $state(settings.settings.journalShowSourceIcons ?? true);
    let journalShowCurrencyIcons = $state(settings.settings.journalShowCurrencyIcons ?? true);
    let exporting = $state(false);
    let detectingDuplicates = $state(false);
    let searchTerm = $state(page.url?.searchParams.get("q") ?? "");
    let showDuplicates = $state(false);

    // Faceted filters
    let selectedAccounts = $state<Set<string>>(new Set());
    let selectedTags = $state<Set<string>>(new Set());
    let selectedLinks = $state<Set<string>>(new Set());
    let accountOptions = $state<{ value: string; label: string }[]>([]);
    let accountIdToName = $state(new Map<string, string>());
    let tagOptions = $state<{ value: string; label: string }[]>([]);
    let linkOptions = $state<{ value: string; label: string }[]>([]);
    let accountOptionsLoading = $state(true);
    let tagOptionsLoading = $state(true);
    let linkOptionsLoading = $state(true);
    const hasFacetedFilters = $derived(
        selectedAccounts.size > 0 ||
            selectedTags.size > 0 ||
            selectedLinks.size > 0,
    );
    let filterTab = $state<"account" | "tags" | "links">("account");
    let accountSearch = $state("");
    let tagSearch = $state("");
    let linkSearch = $state("");
    let filterPopoverOpen = $state(false);
    const totalFilterCount = $derived(
        selectedAccounts.size + selectedTags.size + selectedLinks.size,
    );
    const filteredAccountOptions = $derived(
        accountSearch
            ? accountOptions.filter((o) => o.label.toLowerCase().includes(accountSearch.toLowerCase()))
            : accountOptions,
    );
    const filteredTagOptions = $derived(
        tagSearch
            ? tagOptions.filter((o) => o.label.toLowerCase().includes(tagSearch.toLowerCase()))
            : tagOptions,
    );
    const filteredLinkOptions = $derived(
        linkSearch
            ? linkOptions.filter((o) => o.label.toLowerCase().includes(linkSearch.toLowerCase()))
            : linkOptions,
    );
    function toggleFilterValue(value: string) {
        if (filterTab === "account") {
            const next = new Set(selectedAccounts);
            next.has(value) ? next.delete(value) : next.add(value);
            selectedAccounts = next;
        } else if (filterTab === "tags") {
            const next = new Set(selectedTags);
            next.has(value) ? next.delete(value) : next.add(value);
            selectedTags = next;
        } else {
            const next = new Set(selectedLinks);
            next.has(value) ? next.delete(value) : next.add(value);
            selectedLinks = next;
        }
    }
    function clearActiveFilter() {
        if (filterTab === "account") selectedAccounts = new Set();
        else if (filterTab === "tags") selectedTags = new Set();
        else selectedLinks = new Set();
    }
    let accountInputRef = $state<HTMLInputElement | null>(null);
    let tagInputRef = $state<HTMLInputElement | null>(null);
    let linkInputRef = $state<HTMLInputElement | null>(null);

    function switchFilterTab(tab: "account" | "tags" | "links") {
        filterTab = tab;
        tick().then(() => {
            if (tab === "account") accountInputRef?.focus();
            else if (tab === "tags") tagInputRef?.focus();
            else linkInputRef?.focus();
        });
    }

    // TanStack Table state
    type JournalRow = JournalEntry;

    const columns: ColumnDef<JournalRow>[] = [
        { id: "select", enableSorting: false, enableHiding: false },
        { id: "date", header: m.label_date(), enableHiding: true },
        { id: "description", header: m.label_description(), enableHiding: true },
        { id: "account", header: m.label_account(), enableHiding: true },
        { id: "amount", header: m.label_amount(), enableHiding: true },
    ];

    let rowSelection = $state<RowSelectionState>({});
    let columnVisibility = $state<VisibilityState>(settings.settings.journalColumnVisibility ?? {});

    // Sync searchTerm back to URL so back button works
    $effect(() => {
        const url = new URL(page.url);
        if (searchTerm) {
            url.searchParams.set("q", searchTerm);
        } else {
            url.searchParams.delete("q");
        }
        if (url.toString() !== page.url.toString()) {
            replaceState(url, {});
        }
    });

    // Parse comma-separated OR groups, each with space-separated AND tokens (#tag, ^link, text)
    interface SearchGroup {
        tags: string[];
        links: string[];
        text: string;
    }

    const searchFilters = $derived.by(() => {
        const rawGroups = searchTerm
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean);
        if (rawGroups.length === 0)
            return { groups: [] as SearchGroup[], backendText: "" };
        const groups: SearchGroup[] = rawGroups.map((group) => {
            const tokens = group.split(/\s+/);
            const tags: string[] = [];
            const links: string[] = [];
            const rest: string[] = [];
            for (const t of tokens) {
                if (t.startsWith("#") && t.length > 1)
                    tags.push(t.slice(1).toLowerCase());
                else if (t.startsWith("^") && t.length > 1)
                    links.push(t.slice(1).toLowerCase());
                else rest.push(t);
            }
            return { tags, links, text: rest.join(" ") };
        });
        // Single group: backend can handle text search. Multiple groups: fetch all, filter client-side.
        const backendText = groups.length === 1 ? groups[0].text : "";
        return { groups, backendText };
    });

    const sort = createSortState<JournalSortKey>();

    interface DuplicateGroup {
        confidence: "likely" | "possible";
        entries: [JournalEntry, LineItem[]][];
    }

    let duplicateGroups = $state<DuplicateGroup[]>([]);
    let findingMatches = $state(false);
    let showMatches = $state(false);
    let matchCandidates = $state<MatchCandidate[]>([]);
    let matchAccountMap = $state<Map<string, Account>>(new Map());
    let reinterpreting = $state(false);
    let showReinterpret = $state(false);
    let reinterpretCandidates = $state<ReinterpretCandidate[]>([]);

    function findDuplicateGroups(
        entries: [JournalEntry, LineItem[]][],
    ): DuplicateGroup[] {
        // O(n): bucket by "date|amounts-fingerprint"
        const buckets = new Map<string, [JournalEntry, LineItem[]][]>();
        for (const pair of entries) {
            const [entry, items] = pair;
            const fingerprint = items
                .map((it) => `${it.amount}:${it.currency}`)
                .sort()
                .join(",");
            const key = `${entry.date}|${fingerprint}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = [];
                buckets.set(key, bucket);
            }
            bucket.push(pair);
        }

        // Collect buckets with 2+ entries
        const groups: DuplicateGroup[] = [];
        for (const bucket of buckets.values()) {
            if (bucket.length < 2) continue;
            const isLikely = bucket.every(
                ([e]) => e.description === bucket[0][0].description,
            );
            groups.push({
                confidence: isLikely ? "likely" : "possible",
                entries: bucket,
            });
        }
        return groups;
    }

    // Debounced backend search (initial load fires immediately)
    let debounceTimer: ReturnType<typeof setTimeout>;
    let initialLoad = true;
    $effect(() => {
        const { groups, backendText } = searchFilters;
        const orderBy = sort.key !== "amount" && sort.key !== "account" ? sort.key : null;
        const orderDir = sort.direction;
        const accountFilter = selectedAccounts;
        const tagFilter = selectedTags;
        const linkFilter = selectedLinks;
        const showHidden = settings.showHidden;
        clearTimeout(debounceTimer);

        const doLoad = () => {
            // Cancel previous in-flight load
            loadController?.abort();
            loadController = new AbortController();
            const signal = loadController.signal;

            const filter: TransactionFilter = {};
            if (backendText) filter.description_search = backendText;
            if (orderBy && orderDir) {
                filter.order_by = orderBy;
                filter.order_direction = orderDir;
            }

            // Single group: pass tags/links to backend for SQL-level filtering
            if (groups.length === 1) {
                if (groups[0].tags.length > 0)
                    filter.tag_filters = groups[0].tags;
                if (groups[0].links.length > 0)
                    filter.link_filters = groups[0].links;
            }

            // Faceted filters
            if (accountFilter.size > 0) filter.account_ids = [...accountFilter];
            if (tagFilter.size > 0) filter.tag_filters_or = [...tagFilter];
            if (linkFilter.size > 0) filter.link_filters_or = [...linkFilter];

            // Filter hidden currencies in SQL instead of client-side
            if (!showHidden) {
                filter.exclude_hidden_currencies = true;
            }

            store.load(filter, signal).then(() => {
                if (!signal.aborted) virtualizer.scrollToOffset(0);
            });
        };

        // Skip backend query for short plain-text searches (1-2 chars) that are
        // unlikely to be intentional. Empty string (reload all) and pure #tag/^link
        // filters (where backendText is "") still fire.
        const skipSearch = backendText.length > 0 && backendText.length < 3;

        if (initialLoad) {
            initialLoad = false;
            if (!skipSearch) doLoad();
        } else if (!skipSearch) {
            debounceTimer = setTimeout(doLoad, 300);
        }
        return () => clearTimeout(debounceTimer);
    });

    function totalDebits(items: { amount: string }[]): number {
        return items.reduce((sum, i) => {
            const n = parseFloat(i.amount);
            return n > 0 ? sum + n : sum;
        }, 0);
    }

    function formatDebitTotal(items: { amount: string; currency: string }[]): string {
        const map = new Map<string, number>();
        for (const item of items) {
            const n = parseFloat(item.amount);
            if (n > 0) map.set(item.currency, (map.get(item.currency) ?? 0) + n);
        }
        const byCode = [...map].map(([currency, amount]) => ({ currency, amount: String(amount) }));
        if (byCode.length === 0) return formatCurrency(0, settings.currency);
        return byCode.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
    }

    function mainCounterpartyShort(items: LineItem[]): string {
        return mainCounterpartyShortUtil(items, accountIdToName);
    }

    function mainCounterparty(items: LineItem[]): string {
        return mainCounterpartyUtil(items, accountIdToName);
    }

    function mainCounterpartyFull(items: LineItem[]): string {
        return mainCounterpartyFullUtil(items, accountIdToName);
    }

    function amountColorClass(dir: AmountDirection): string {
        return amountColorClassUtil(dir);
    }

    function entryAmountParts(items: LineItem[]): { isTrade: boolean; debits: CurrencyBalance[] } {
        return entryAmountPartsUtil(items, accountIdToName);
    }

    function barBgColor(dir: AmountDirection): string {
        if (dir === "income") return "rgba(34, 197, 94, 0.15)";
        if (dir === "expense") return "rgba(239, 68, 68, 0.15)";
        return "rgba(156, 163, 175, 0.12)";
    }

    type BarSegment = { direction: AmountDirection; amount: number };

    function entryBarSegments(items: LineItem[]): BarSegment[] {
        const { isTrade, debits } = entryAmountParts(items);

        if (isTrade) {
            const total = debits.reduce(
                (s, d) => s + Math.abs(Number(d.amount)),
                0,
            );
            return [{ direction: "default", amount: total }];
        }

        let hasIncome = false,
            hasExpense = false,
            hasEquity = false;
        for (const item of items) {
            const name = accountIdToName.get(item.account_id) ?? "";
            if (name.startsWith("Equity:") || name === "Equity")
                hasEquity = true;
            else if (name.startsWith("Income:") || name === "Income")
                hasIncome = true;
            else if (name.startsWith("Expenses:") || name === "Expenses")
                hasExpense = true;
        }

        const isMixed = (hasEquity || hasIncome) && hasExpense;
        if (!isMixed) {
            const dir: AmountDirection = hasIncome
                ? "income"
                : hasExpense
                  ? "expense"
                  : "default";
            const total = debits.reduce(
                (s, d) => s + Math.abs(Number(d.amount)),
                0,
            );
            return [{ direction: dir, amount: total }];
        }

        // Mixed: split expense amounts from the rest
        const expenseByCode = new Map<string, number>();
        for (const item of items) {
            const name = accountIdToName.get(item.account_id) ?? "";
            if (name.startsWith("Expenses:") || name === "Expenses") {
                const n = parseFloat(item.amount);
                if (n > 0)
                    expenseByCode.set(
                        item.currency,
                        (expenseByCode.get(item.currency) ?? 0) + n,
                    );
            }
        }
        let expenseTotal = 0;
        for (const v of expenseByCode.values()) expenseTotal += v;

        let mainTotal = 0;
        for (const d of debits) {
            const total = Math.abs(Number(d.amount));
            const exp = expenseByCode.get(d.currency) ?? 0;
            mainTotal += total - exp;
        }

        const segments: BarSegment[] = [];
        const mainDir: AmountDirection = hasIncome ? "income" : "default";
        if (mainTotal > 0)
            segments.push({ direction: mainDir, amount: mainTotal });
        if (expenseTotal > 0)
            segments.push({ direction: "expense", amount: expenseTotal });
        return segments;
    }

    function entryBarAmount(items: LineItem[]): number {
        return entryBarSegments(items).reduce((s, seg) => s + seg.amount, 0);
    }

    function barGradientFromSegments(
        segments: BarSegment[],
        maxAmount: number,
    ): string {
        if (settings.settings.journalAmountBars === false) return "";
        if (maxAmount <= 0 || segments.length === 0) return "";

        // Single segment: solid color bar
        if (segments.length === 1) {
            const pct = Math.min(
                (segments[0].amount / maxAmount) * 66.67,
                66.67,
            );
            if (pct <= 0) return "";
            const color = barBgColor(segments[0].direction);
            return `--bar-bg: ${color}; --bar-width: ${pct.toFixed(1)}%`;
        }

        // Multiple segments: sized bar with internal gradient (no transparent)
        const sorted = [...segments].sort((a, b) => a.amount - b.amount);
        let totalPct = 0;
        for (const seg of sorted) {
            const pct = Math.min(
                (seg.amount / maxAmount) * 66.67,
                66.67 - totalPct,
            );
            if (pct <= 0) continue;
            totalPct += pct;
        }
        if (totalPct <= 0) return "";
        // Build gradient with stops normalized to 0-100% within the bar
        const colorStops: string[] = [];
        let pos = 0;
        for (const seg of sorted) {
            const pct = Math.min(
                (seg.amount / maxAmount) * 66.67,
                66.67 - pos,
            );
            if (pct <= 0) continue;
            const color = barBgColor(seg.direction);
            const startNorm = ((pos / totalPct) * 100).toFixed(1);
            const endNorm = (((pos + pct) / totalPct) * 100).toFixed(1);
            colorStops.push(`${color} ${startNorm}% ${endNorm}%`);
            pos += pct;
        }
        const gradient = `linear-gradient(to right, ${colorStops.join(", ")})`;
        return `--bar-bg: ${gradient}; --bar-width: ${totalPct.toFixed(1)}%`;
    }

    function barGradient(items: LineItem[], maxAmount: number): string {
        return barGradientFromSegments(entryBarSegments(items), maxAmount);
    }

    function entryAmountDisplay(items: LineItem[]): AmountPart[] {
        return entryAmountDisplayUtil(items, accountIdToName);
    }

    // Metadata state — declared before displayEntries to avoid TDZ
    let entryTags = $state<Map<string, string[]>>(new Map());
    let entryLinks = $state<Map<string, string[]>>(new Map());
    let entryNotes = $state<Map<string, string>>(new Map());

    // Post-filter: OR across comma-separated groups, AND within each group
    const displayEntries = $derived.by((): JournalEntry[] => {
        const { groups } = searchFilters;
        if (groups.length === 0) return store.entries;
        const single = groups.length === 1;
        // Single group: tags/links already filtered by backend SQL, no client-side filtering needed
        if (
            single &&
            groups[0].tags.length === 0 &&
            groups[0].links.length === 0
        )
            return store.entries;
        if (single) return store.entries;
        // Multi-group: client-side OR filtering across groups
        return store.entries.filter((entry) => {
            return groups.some(({ tags, links, text }) => {
                if (text) {
                    const lower = text.toLowerCase();
                    const matchesDesc = entry.description.toLowerCase().includes(lower);
                    const matchesNote = entryNotes.get(entry.id)?.toLowerCase().includes(lower);
                    if (!matchesDesc && !matchesNote) return false;
                }
                if (tags.length > 0) {
                    const eTags = entryTags.get(entry.id);
                    if (
                        !eTags ||
                        !tags.every((t) =>
                            eTags.some((et) => et.toLowerCase() === t),
                        )
                    )
                        return false;
                }
                if (links.length > 0) {
                    const eLinks = entryLinks.get(entry.id);
                    if (
                        !eLinks ||
                        !links.every((l) =>
                            eLinks.some((el) => el.toLowerCase() === l),
                        )
                    )
                        return false;
                }
                return true;
            });
        });
    });

    // Sorted entries — needed in script block for virtualizer count
    const sortedEntries = $derived.by((): JournalEntry[] => {
        if (sort.key === "amount" && sort.direction)
            return sortItems(
                displayEntries,
                (entry: JournalEntry) => totalDebits(getItems(entry.id)),
                sort.direction,
            );
        if (sort.key === "account" && sort.direction)
            return sortItems(
                displayEntries,
                (entry: JournalEntry) => mainCounterparty(getItems(entry.id)),
                sort.direction,
            );
        return displayEntries;
    });

    // TanStack Table instance
    const table = createSvelteTable({
        get data() {
            return sortedEntries;
        },
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.id,
        state: {
            get rowSelection() {
                return rowSelection;
            },
            get columnVisibility() {
                return columnVisibility;
            },
        },
        onRowSelectionChange: (updater) => {
            rowSelection =
                typeof updater === "function" ? updater(rowSelection) : updater;
        },
        onColumnVisibilityChange: (updater) => {
            columnVisibility =
                typeof updater === "function"
                    ? updater(columnVisibility)
                    : updater;
            settings.update({ journalColumnVisibility: columnVisibility });
        },
        enableRowSelection: (row) => row.original.status !== "voided",
    });

    const visibleColCount = $derived(table.getVisibleLeafColumns().length);
    const selectedCount = $derived(
        table.getFilteredSelectedRowModel().rows.length,
    );
    function clearSelection() {
        rowSelection = {};
    }

    // Clear selection when filters/sort change
    $effect(() => {
        void searchTerm;
        void selectedAccounts;
        void selectedTags;
        void selectedLinks;
        void sort.key;
        void sort.direction;
        rowSelection = {};
    });

    let batchVoiding = $state(false);

    let batchTagOpen = $state(false);
    let batchTags = $state<string[]>([]);
    let batchTagMode = $state<"add" | "remove">("add");
    let batchTagBusy = $state(false);

    let batchLinkOpen = $state(false);
    let batchLinks = $state<string[]>([]);
    let batchLinkMode = $state<"add" | "remove">("add");
    let batchLinkBusy = $state(false);

    // Reset batch arrays when popovers close
    $effect(() => {
        if (!batchTagOpen) batchTags = [];
    });
    $effect(() => {
        if (!batchLinkOpen) batchLinks = [];
    });

    async function handleBatchVoid() {
        batchVoiding = true;
        try {
            const selectedRows = table.getFilteredSelectedRowModel().rows;
            const ids = selectedRows
                .map((r) => r.original)
                .filter((e) => e.status !== "voided")
                .map((e) => e.id);
            let success = 0;
            let failed = 0;
            const backend = getBackend();
            for (const id of ids) {
                try {
                    await backend.voidJournalEntry(id);
                    success++;
                } catch {
                    failed++;
                }
            }
            await store.load();
            invalidate("journal", "reports");
            if (failed === 0) {
                toast.success(
                    m.toast_entries_voided({ count: success }),
                );
            } else {
                toast.warning(m.toast_entries_voided_partial({ success, failed }));
            }
        } catch (err) {
            toast.error(String(err));
        } finally {
            batchVoiding = false;
            clearSelection();
        }
    }

    async function handleBatchTag() {
        if (batchTags.length === 0) return;
        batchTagBusy = true;
        try {
            const selectedRows = table.getFilteredSelectedRowModel().rows;
            const ids = selectedRows.map((r) => r.original.id);
            const backend = getBackend();
            let changed = 0;
            for (const id of ids) {
                const meta = await backend.getMetadata(id);
                const existing = parseTags(meta[TAGS_META_KEY]);
                let modified = false;
                for (const tag of batchTags) {
                    const has = existing.includes(tag);
                    if (batchTagMode === "add" && !has) {
                        existing.push(tag);
                        modified = true;
                    } else if (batchTagMode === "remove" && has) {
                        const idx = existing.indexOf(tag);
                        if (idx >= 0) {
                            existing.splice(idx, 1);
                            modified = true;
                        }
                    }
                }
                if (modified) {
                    await backend.setMetadata(id, {
                        [TAGS_META_KEY]: serializeTags(existing),
                    });
                    changed++;
                }
            }
            await store.load();
            invalidate("journal");
            backend.getAllTagValues().then((tags) => {
                tagOptions = tags.map((t) => ({ value: t, label: t }));
            });
            entryTags = new Map();
            toast.success(
                m.toast_batch_tags_updated({ count: changed, tags: batchTags.length, mode: batchTagMode }),
            );
            batchTags = [];
            batchTagOpen = false;
        } catch (err) {
            toast.error(String(err));
        } finally {
            batchTagBusy = false;
        }
    }

    async function handleBatchLink() {
        if (batchLinks.length === 0) return;
        batchLinkBusy = true;
        try {
            const selectedRows = table.getFilteredSelectedRowModel().rows;
            const ids = selectedRows.map((r) => r.original.id);
            const backend = getBackend();
            let changed = 0;
            for (const id of ids) {
                const existing = await backend.getEntryLinks(id);
                let modified = false;
                for (const link of batchLinks) {
                    const has = existing.includes(link);
                    if (batchLinkMode === "add" && !has) {
                        existing.push(link);
                        modified = true;
                    } else if (batchLinkMode === "remove" && has) {
                        const idx = existing.indexOf(link);
                        if (idx >= 0) {
                            existing.splice(idx, 1);
                            modified = true;
                        }
                    }
                }
                if (modified) {
                    await backend.setEntryLinks(id, existing);
                    changed++;
                }
            }
            await store.load();
            invalidate("journal");
            backend.getAllLinkNames().then((ls) => {
                linkOptions = ls.map((l) => ({ value: l, label: l }));
            });
            entryLinks = new Map();
            toast.success(
                m.toast_batch_links_updated({ count: changed, links: batchLinks.length, mode: batchLinkMode }),
            );
            batchLinks = [];
            batchLinkOpen = false;
        } catch (err) {
            toast.error(String(err));
        } finally {
            batchLinkBusy = false;
        }
    }

    // Mobile layout detection for virtual row height
    let isMobileLayout = $state(false);
    $effect(() => {
        const mq = window.matchMedia("(max-width: 639px)");
        isMobileLayout = mq.matches;
        const handler = (e: MediaQueryListEvent) => {
            isMobileLayout = e.matches;
        };
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    });

    let multiSelectMode = $state(false);

    // Exit multi-select when all rows deselected
    $effect(() => {
        if (selectedCount === 0 && multiSelectMode) multiSelectMode = false;
    });
    // Exit multi-select when switching to desktop
    $effect(() => {
        if (!isMobileLayout) multiSelectMode = false;
    });

    function createLongPressHandlers(
        entryId: string,
        row: ReturnType<typeof table.getRowModel>["rows"][number],
    ) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let startX = 0;
        let startY = 0;
        let fired = false;

        return {
            onpointerdown(e: PointerEvent) {
                if (!isMobileLayout) return;
                startX = e.clientX;
                startY = e.clientY;
                fired = false;
                timer = setTimeout(() => {
                    fired = true;
                    multiSelectMode = true;
                    if (!row.getIsSelected()) row.toggleSelected(true);
                    navigator.vibrate?.(50);
                }, 500);
            },
            onpointermove(e: PointerEvent) {
                if (!timer) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (dx * dx + dy * dy > 100) {
                    // >10px movement
                    clearTimeout(timer);
                    timer = null;
                }
            },
            onpointerup() {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (fired) return; // long-press already handled
                if (!isMobileLayout) return;
                if (multiSelectMode) {
                    row.toggleSelected(!row.getIsSelected());
                } else {
                    openEntryDrawer("view", entryId);
                }
            },
            onpointercancel() {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            },
        };
    }

    function percentile95(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * 0.95);
        return sorted[Math.min(idx, sorted.length - 1)];
    }

    // Hover tracking for chart rule line
    let hoveredEntryDate = $state<string | null>(null);

    // Virtual scrolling
    let scrollEl = $state<HTMLDivElement | null>(null);

    const virtualizer = createVirtualizer(() => ({
        count: sortedEntries.length,
        getScrollElement: () => scrollEl,
        estimateSize: () => (isMobileLayout ? 56 : 44),
        overscan: 10,
    }));

    // Remeasure when multiSelectMode toggles (checkbox column changes row width)
    $effect(() => {
        void multiSelectMode;
        virtualizer.measure();
    });

    const virtualItems = $derived(
        virtualizer
            .getVirtualItems()
            .filter((row) => row.index < sortedEntries.length),
    );
    let maxEntryAmount = $derived.by(() => {
        const amounts: number[] = [];
        for (const vi of virtualItems) {
            const entry = sortedEntries[vi.index];
            if (!entry) continue;
            const segments = convertedBarSegments.get(entry.id);
            const a = segments
                ? segments.reduce((s, seg) => s + seg.amount, 0)
                : entryBarAmount(getItems(entry.id));
            amounts.push(a);
        }
        return percentile95(amounts);
    });
    const totalSize = $derived(virtualizer.getTotalSize());
    const paddingTop = $derived(
        virtualItems.length > 0 ? virtualItems[0].start : 0,
    );
    const paddingBottom = $derived(
        virtualItems.length > 0
            ? totalSize - virtualItems[virtualItems.length - 1].end
            : 0,
    );

    // Scroll position indicators
    const isScrolledDown = $derived(
        virtualItems.length > 0 && virtualItems[0].index > 0,
    );

    const positionLabel = $derived(
        derivePositionLabel(
            sortedEntries,
            virtualItems[0]?.index ?? 0,
            virtualItems[virtualItems.length - 1]?.index ?? 0,
            sort.key,
            sort.direction,
            formatDebitTotal,
            getItems,
        ),
    );

    // --- Daily income/expense bar chart ---
    // Lazy-load chart dependencies
    let BarChart_imported = $state<
        typeof import("layerchart").BarChart | null
    >(null);
    let Rule_imported = $state<typeof import("layerchart").Rule | null>(null);

    $effect(() => {
        import("layerchart").then((lc) => {
            BarChart_imported = lc.BarChart;
            Rule_imported = lc.Rule;
        });
    });

    // Aggregate income/expense from displayEntries, bucketed by adaptive granularity
    type ChartDatum = { date: Date; income: number; expense: number; other: number };

    const MIN_BAR_STEP = 6;

    let manualGranularity: ChartGranularity | null = $state(settings.settings.journalChartGranularity ?? null);

    const autoGranularity: ChartGranularity = $derived.by(() => {
        const entries = displayEntries;
        if (entries.length === 0) return "day";
        const dates = new Set<string>();
        for (const e of entries) dates.add(e.date);
        const sorted = [...dates].sort();
        const first = new Date(sorted[0] + "T00:00:00");
        const last = new Date(sorted[sorted.length - 1] + "T00:00:00");
        const spanDays = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86400000));
        const maxBars = chartContainerWidth > 0 ? Math.floor(chartContainerWidth / MIN_BAR_STEP) : 200;
        return chooseGranularity(spanDays, dates.size, maxBars);
    });
    const effectiveGranularity: ChartGranularity = $derived(manualGranularity ?? autoGranularity);

    function buildChartDataFromAgg(rows: { date: string; income: number; expense: number }[], granularity: ChartGranularity): ChartDatum[] {
        const map = new Map<string, ChartDatum>();
        for (const row of rows) {
            const key = bucketKey(row.date, granularity);
            let rec = map.get(key);
            if (!rec) {
                rec = { date: bucketStartDate(key, granularity), income: 0, expense: 0, other: 0 };
                map.set(key, rec);
            }
            rec.income += row.income;
            rec.expense += row.expense;
        }
        return [...map.values()].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
        );
    }

    let rawChartData = $state<ChartDatum[]>([]);
    let convertedChartData = $state<ChartDatum[] | null>(null);
    const chartData = $derived(convertedChartData ?? rawChartData);
    const chartYMax = $derived.by(() => {
        const totals = chartData.map(d => d.income + d.expense);
        return percentile95(totals);
    });

    let chartConversionGen = 0;
    $effect(() => {
        const entries = displayEntries;
        const granularity = effectiveGranularity;
        const { groups, backendText } = searchFilters;

        // Stay in sync with table: skip chart update for short plain-text searches
        const skipSearch = backendText.length > 0 && backendText.length < 3;
        if (skipSearch) return;

        convertedChartData = null;
        rawChartData = [];
        if (entries.length === 0) return;
        const gen = ++chartConversionGen;
        const backend = getBackend();
        if (backend.getJournalChartAggregation) {
            // Build the same filter used for the current load
            const filter: TransactionFilter = {};
            if (backendText) filter.description_search = backendText;
            if (groups.length === 1) {
                if (groups[0].tags.length > 0) filter.tag_filters = groups[0].tags;
                if (groups[0].links.length > 0) filter.link_filters = groups[0].links;
            }
            if (selectedAccounts.size > 0) filter.account_ids = [...selectedAccounts];
            if (selectedTags.size > 0) filter.tag_filters_or = [...selectedTags];
            if (selectedLinks.size > 0) filter.link_filters_or = [...selectedLinks];
            if (!settings.showHidden) filter.exclude_hidden_currencies = true;

            backend.getJournalChartAggregation(filter).then(rows => {
                if (gen !== chartConversionGen) return;
                rawChartData = buildChartDataFromAgg(rows, granularity);
            });
        }
    });

    // Current scroll date bucketed (for chart highlight band start)
    const currentChartBucketDate = $derived.by(() => {
        const dateStr = sortedEntries[virtualItems[0]?.index]?.date;
        return dateStr ? dateToBucketDate(dateStr, effectiveGranularity) : null;
    });

    // Last visible date bucketed (for chart highlight band end)
    const lastChartBucketDate = $derived.by(() => {
        const dateStr = sortedEntries[virtualItems[virtualItems.length - 1]?.index]?.date;
        return dateStr ? dateToBucketDate(dateStr, effectiveGranularity) : null;
    });

    // Hovered entry date bucketed (for chart cursor rule)
    const hoveredChartBucketDate = $derived.by(() => {
        return hoveredEntryDate ? dateToBucketDate(hoveredEntryDate, effectiveGranularity) : null;
    });

    // Chart date pill label derived from visible bucket dates
    const chartDateLabel = $derived.by(() => {
        if (!currentChartBucketDate || !lastChartBucketDate) return null;
        const g = effectiveGranularity;
        const start = formatTooltipHeader(lastChartBucketDate, g);
        const end = formatTooltipHeader(currentChartBucketDate, g);
        return start === end ? start : `${start} – ${end}`;
    });

    // Scroll journal to a given date
    function scrollToDate(target: Date) {
        // Find closest date in sortedEntries
        let bestIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < sortedEntries.length; i++) {
            const d = sortedEntries[i].date;
            const diff = Math.abs(
                new Date(d + "T00:00:00").getTime() - target.getTime(),
            );
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        virtualizer.scrollToIndex(bestIdx, { align: "start" });
    }

    // Chart drag-to-scroll state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chartContext = $state<any>(null);
    let isDragging = $state(false);
    let chartContainerWidth = $state(0);
    let cachedChartRect: DOMRect | null = null;

    const BAND_PADDING = 0.15;

    const computedXRange: [number, number] = $derived([0, chartContainerWidth]);

    function handleChartPointer(e: PointerEvent) {
        if (!chartContext || !isDragging) return;
        const rect = cachedChartRect ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left - (chartContext.padding?.left ?? 0);
        const xScale = chartContext.xScale;
        if (!xScale || typeof xScale.domain !== "function") return;
        const domain = xScale.domain() as Date[];
        const step = xScale.step?.() ?? 0;
        let closest: Date | null = null;
        let bestDist = Infinity;
        for (const d of domain) {
            const bandCenter = (xScale(d) ?? 0) + step / 2;
            const dist = Math.abs(x - bandCenter);
            if (dist < bestDist) {
                bestDist = dist;
                closest = d;
            }
        }
        if (closest) scrollToDate(closest);
    }

    let showPill = $state(false);
    let pillTimer: ReturnType<typeof setTimeout>;
    $effect(() => {
        void virtualItems; // subscribe to scroll changes
        if (!isScrolledDown) {
            showPill = false;
            return;
        }
        showPill = true;
        clearTimeout(pillTimer);
        pillTimer = setTimeout(() => {
            showPill = false;
        }, 1500);
        return () => clearTimeout(pillTimer);
    });

    // Derive visible entry IDs (used by converted totals + viewport line item loading)
    const visibleEntryIds = $derived(
        virtualizer
            .getVirtualItems()
            .map((item) => sortedEntries[item.index]?.id)
            .filter(Boolean),
    );

    // Viewport-driven line item loading
    let lineItemDebounce: ReturnType<typeof setTimeout>;
    $effect(() => {
        const items = virtualizer.getVirtualItems();
        if (items.length === 0 || sortedEntries.length === 0) return;
        const startIdx = Math.max(0, items[0].index - 50);
        const endIdx = Math.min(sortedEntries.length, items[items.length - 1].index + 51);
        const ids = sortedEntries.slice(startIdx, endIdx).map(e => e.id);
        clearTimeout(lineItemDebounce);
        lineItemDebounce = setTimeout(() => {
            store.loadLineItems(ids);
        }, 16);
        return () => clearTimeout(lineItemDebounce);
    });

    // Reset metadata maps when entries change
    $effect(() => {
        void store.entries;
        entryTags = new Map();
        entryLinks = new Map();
        entryNotes = new Map();
        convertedTotals = new Map();
        convertedBarSegments = new Map();
    });

    // Viewport-driven metadata/links loading
    let metaGen = 0;
    let metaDebounce: ReturnType<typeof setTimeout>;
    $effect(() => {
        const items = virtualizer.getVirtualItems();
        if (items.length === 0 || sortedEntries.length === 0) return;
        const startIdx = Math.max(0, items[0].index - 50);
        const endIdx = Math.min(sortedEntries.length, items[items.length - 1].index + 51);
        const ids = sortedEntries.slice(startIdx, endIdx).map(e => e.id);
        // Filter to IDs not yet loaded
        const needed = ids.filter(id => !entryTags.has(id));
        if (needed.length === 0) return;
        clearTimeout(metaDebounce);
        const gen = ++metaGen;
        metaDebounce = setTimeout(async () => {
            try {
                const backend = getBackend();
                const [metaMap, linkMap] = await Promise.all([
                    backend.getMetadataBatch
                        ? backend.getMetadataBatch(needed)
                        : Promise.all(
                              needed.map((id) =>
                                  backend
                                      .getMetadata(id)
                                      .catch(
                                          () =>
                                              ({}) as Record<string, string>,
                                      ),
                              ),
                          ).then(
                              (metas) =>
                                  new Map(
                                      needed.map((id, i) => [id, metas[i]]),
                                  ),
                          ),
                    backend.getEntryLinksBatch
                        ? backend.getEntryLinksBatch(needed)
                        : Promise.all(
                              needed.map((id) =>
                                  backend
                                      .getEntryLinks(id)
                                      .catch(() => [] as string[]),
                              ),
                          ).then(
                              (links) =>
                                  new Map(
                                      needed.map((id, i) => [id, links[i]]),
                                  ),
                          ),
                ]);
                if (gen !== metaGen) return;
                const tags = new Map(entryTags);
                const notes = new Map(entryNotes);
                for (const [id, meta] of metaMap) {
                    tags.set(id, parseTags(meta[TAGS_META_KEY]));
                    if (meta[NOTE_META_KEY]) notes.set(id, meta[NOTE_META_KEY]);
                }
                entryTags = tags;
                entryNotes = notes;
                const linksOut = new Map(entryLinks);
                for (const [id, links] of linkMap) {
                    linksOut.set(id, links);
                }
                entryLinks = linksOut;
            } catch {
                /* ignore */
            }
        }, 50);
        return () => clearTimeout(metaDebounce);
    });

    function addTagFilter(tag: string) {
        const token = `#${tag}`;
        if (searchTerm.toLowerCase().includes(token.toLowerCase())) return;
        searchTerm = searchTerm ? `${searchTerm} ${token}` : token;
    }

    function addLinkFilter(link: string) {
        const token = `^${link}`;
        if (searchTerm.toLowerCase().includes(token.toLowerCase())) return;
        searchTerm = searchTerm ? `${searchTerm} ${token}` : token;
    }

    // Visible-range currency conversion
    let convertedTotals = $state(new Map<string, string>());
    let convertedBarSegments = $state(new Map<string, BarSegment[]>());
    let conversionGen = 0;

    async function convertBarSegments(
        items: LineItem[],
        date: string,
        baseCurrency: string,
        cache: ExchangeRateCache,
    ): Promise<BarSegment[]> {
        const { isTrade, debits } = entryAmountParts(items);

        if (isTrade) {
            let total = 0;
            for (const d of debits) {
                if (d.currency === baseCurrency) {
                    total += Math.abs(Number(d.amount));
                } else {
                    const rate = await cache.get(d.currency, baseCurrency, date);
                    if (rate) total += Math.abs(Number(d.amount)) * Number(rate);
                }
            }
            return [{ direction: "default", amount: total }];
        }

        let hasIncome = false,
            hasExpense = false,
            hasEquity = false;
        for (const item of items) {
            const name = accountIdToName.get(item.account_id) ?? "";
            if (name.startsWith("Equity:") || name === "Equity") hasEquity = true;
            else if (name.startsWith("Income:") || name === "Income") hasIncome = true;
            else if (name.startsWith("Expenses:") || name === "Expenses") hasExpense = true;
        }

        const isMixed = (hasEquity || hasIncome) && hasExpense;

        async function convertDebitTotal(debits: CurrencyBalance[]): Promise<number> {
            let total = 0;
            for (const d of debits) {
                if (d.currency === baseCurrency) {
                    total += Math.abs(Number(d.amount));
                } else {
                    const rate = await cache.get(d.currency, baseCurrency, date);
                    if (rate) total += Math.abs(Number(d.amount)) * Number(rate);
                }
            }
            return total;
        }

        if (!isMixed) {
            const dir: AmountDirection = hasIncome ? "income" : hasExpense ? "expense" : "default";
            const total = await convertDebitTotal(debits);
            return [{ direction: dir, amount: total }];
        }

        // Mixed: split expense amounts from the rest
        const expenseByCode = new Map<string, number>();
        for (const item of items) {
            const name = accountIdToName.get(item.account_id) ?? "";
            if (name.startsWith("Expenses:") || name === "Expenses") {
                const n = parseFloat(item.amount);
                if (n > 0)
                    expenseByCode.set(item.currency, (expenseByCode.get(item.currency) ?? 0) + n);
            }
        }
        // Convert expense total
        let expenseTotal = 0;
        for (const [cur, amt] of expenseByCode) {
            if (cur === baseCurrency) {
                expenseTotal += amt;
            } else {
                const rate = await cache.get(cur, baseCurrency, date);
                if (rate) expenseTotal += amt * Number(rate);
            }
        }

        // Convert main total (debits minus expense portions)
        let mainTotal = 0;
        for (const d of debits) {
            const rawTotal = Math.abs(Number(d.amount));
            const exp = expenseByCode.get(d.currency) ?? 0;
            const net = rawTotal - exp;
            if (net <= 0) continue;
            if (d.currency === baseCurrency) {
                mainTotal += net;
            } else {
                const rate = await cache.get(d.currency, baseCurrency, date);
                if (rate) mainTotal += net * Number(rate);
            }
        }

        const segments: BarSegment[] = [];
        const mainDir: AmountDirection = hasIncome ? "income" : "default";
        if (mainTotal > 0) segments.push({ direction: mainDir, amount: mainTotal });
        if (expenseTotal > 0) segments.push({ direction: "expense", amount: expenseTotal });
        return segments;
    }

    let convDebounce: ReturnType<typeof setTimeout>;
    $effect(() => {
        const ids = visibleEntryIds;
        const baseCurrency = settings.currency;
        if (!baseCurrency || ids.length === 0) return;

        clearTimeout(convDebounce);
        const gen = ++conversionGen;
        convDebounce = setTimeout(async () => {
            // Filter to IDs we haven't converted yet
            const needed = ids.filter((id) => !convertedTotals.has(id));
            if (needed.length === 0) return;

            const cache = new ExchangeRateCache(getBackend());
            const results = new Map(convertedTotals);
            const asyncEntries: [string, boolean, CurrencyBalance[], string][] =
                [];

            for (const id of needed) {
                const entryData = store.byId.get(id);
                if (!entryData) continue;
                const { entry, items } = entryData;
                const { isTrade, debits } = entryAmountParts(items);
                if (debits.length === 0) {
                    results.set(entry.id, formatCurrency(0, baseCurrency));
                } else if (debits.every((b) => b.currency === baseCurrency)) {
                    if (isTrade && debits.length === 2) {
                        results.set(
                            entry.id,
                            `${formatCurrency(debits[0].amount, baseCurrency)} → ${formatCurrency(debits[1].amount, baseCurrency)}`,
                        );
                    } else {
                        const total = debits.reduce(
                            (s, b) => s + parseFloat(b.amount),
                            0,
                        );
                        results.set(
                            entry.id,
                            formatCurrency(total, baseCurrency),
                        );
                    }
                } else {
                    asyncEntries.push([entry.id, isTrade, debits, entry.date]);
                }
            }
            if (gen !== conversionGen) return;
            convertedTotals = new Map(results);

            for (const [id, isTrade, debits, date] of asyncEntries) {
                if (gen !== conversionGen) return;
                const summary = await convertBalances(
                    debits,
                    baseCurrency,
                    date,
                    cache,
                );
                if (gen !== conversionGen) return;

                let formatted: string;
                if (isTrade && debits.length === 2) {
                    // For trades, convert each leg separately and show arrow
                    const spentConverted = await convertBalances(
                        [debits[0]],
                        baseCurrency,
                        date,
                        cache,
                    );
                    const rcvConverted = await convertBalances(
                        [debits[1]],
                        baseCurrency,
                        date,
                        cache,
                    );
                    if (gen !== conversionGen) return;
                    const spentStr =
                        spentConverted.unconverted.length === 0
                            ? formatCurrency(spentConverted.total, baseCurrency)
                            : formatCurrency(
                                  debits[0].amount,
                                  debits[0].currency,
                              );
                    const rcvStr =
                        rcvConverted.unconverted.length === 0
                            ? formatCurrency(rcvConverted.total, baseCurrency)
                            : formatCurrency(
                                  debits[1].amount,
                                  debits[1].currency,
                              );
                    formatted = `${spentStr} → ${rcvStr}`;
                } else if (summary.unconverted.length === 0) {
                    formatted = formatCurrency(summary.total, baseCurrency);
                } else {
                    const parts: string[] = [];
                    if (summary.total !== 0)
                        parts.push(formatCurrency(summary.total, baseCurrency));
                    for (const u of summary.unconverted) {
                        parts.push(formatCurrency(u.amount, u.currency));
                    }
                    formatted = parts.join(" + ");
                }
                results.set(id, formatted);
                convertedTotals = new Map(results);
            }

            // Also compute converted bar segments for visible entries
            const barResults = new Map(convertedBarSegments);
            for (const id of ids) {
                if (barResults.has(id)) continue;
                if (gen !== conversionGen) return;
                const entryData = store.byId.get(id);
                if (!entryData) continue;
                const { entry, items } = entryData;
                const segs = await convertBarSegments(items, entry.date, baseCurrency, cache);
                if (gen !== conversionGen) return;
                barResults.set(id, segs);
                convertedBarSegments = new Map(barResults);
            }
        }, 100);
        return () => clearTimeout(convDebounce);
    });

    async function handleFindMatches() {
        findingMatches = true;
        try {
            const backend = getBackend();
            const allEntries = await backend.queryJournalEntries({});
            const accounts = await backend.listAccounts();
            const idToName = new Map<string, string>();
            const accMap = new Map<string, Account>();
            for (const acc of accounts) {
                idToName.set(acc.id, acc.full_name);
                accMap.set(acc.full_name, acc);
            }
            // Collect already-linked entry IDs
            const linked = new Set<string>();
            for (const [entry] of allEntries) {
                if (entry.voided_by) continue;
                const meta = await backend.getMetadata(entry.id);
                if (meta["cross_match_linked"] || meta["cex_linked"] || meta["cross_match_skipped"])
                    linked.add(entry.id);
            }
            const nonVoided = allEntries.filter(([e]) => !e.voided_by);
            const candidates = extractAllCandidates(nonVoided, idToName, linked);
            // Load metadata for scoring
            const metaMap = new Map<string, Record<string, string>>();
            for (const c of candidates) {
                metaMap.set(c.entry.id, await backend.getMetadata(c.entry.id));
            }
            matchCandidates = findMatches(candidates, metaMap);
            matchAccountMap = accMap;
            showMatches = true;
        } catch (e) {
            toast.error(String(e));
        } finally {
            findingMatches = false;
        }
    }

    async function handleDetectDuplicates() {
        detectingDuplicates = true;
        try {
            const allEntries = await getBackend().queryJournalEntries({});
            const filtered = filterHiddenEntries(allEntries, getHiddenCurrencySet());
            duplicateGroups = findDuplicateGroups(filtered);
            showDuplicates = true;
        } finally {
            detectingDuplicates = false;
        }
    }

    async function handleReinterpret() {
        reinterpreting = true;
        try {
            const rules = settings.settings.csvCategorizationRules ?? [];
            if (rules.length === 0) {
                toast.info(m.toast_no_categorization_rules());
                return;
            }
            const result = await findReinterpretCandidates(getBackend(), rules);
            if (result.candidates.length === 0) {
                toast.info(m.toast_no_transactions_to_reinterpret());
                return;
            }
            reinterpretCandidates = result.candidates;
            showReinterpret = true;
        } catch (e) {
            toast.error(String(e));
        } finally {
            reinterpreting = false;
        }
    }

    async function handleExport(format: LedgerFormat) {
        exporting = true;
        try {
            // Build tuples for export — load all line items first if needed
            await store.loadAllLineItems();
            const tuples: [JournalEntry, LineItem[]][] = displayEntries.map(e => [e, getItems(e.id)]);
            const content = await exportLedger(getBackend(), format, tuples);
            const blob = new Blob([content], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `dledger-export${formatExtension(format)}`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success(m.toast_ledger_exported());
        } catch (err) {
            toast.error(String(err));
        } finally {
            exporting = false;
        }
    }
</script>

<div class="flex flex-col gap-6 flex-1 min-h-0 -mb-20 md:-mb-4">
    {#if showChart && !store.loading && chartData.length > 1 && BarChart_imported}
        {@const BarChartComp = BarChart_imported}
        <div class="relative">
        {#if chartDateLabel}
            <div class="absolute top-0 left-2 z-10 rounded-md border bg-background px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm pointer-events-none">
                {chartDateLabel}
            </div>
        {/if}
        <div class="absolute top-0 right-2 z-10">
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <button class="text-[10px] px-1.5 py-0.5 rounded bg-muted/70 hover:bg-muted text-muted-foreground">
                        {manualGranularity ? granularityLabel[manualGranularity]() : m.label_auto_detect()}
                    </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                    <DropdownMenu.Item inset onclick={() => { manualGranularity = null; settings.update({ journalChartGranularity: null }); }}>
                        {#if !manualGranularity}<Check class="absolute left-2 size-4" />{/if}
                        {m.label_auto_granularity({ granularity: granularityLabel[autoGranularity]() })}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    {#each (["day","week","month","quarter","year"] as const) as g}
                        <DropdownMenu.Item inset onclick={() => { manualGranularity = g; settings.update({ journalChartGranularity: g }); }}>
                            {#if manualGranularity === g}<Check class="absolute left-2 size-4" />{/if}
                            {granularityLabel[g]()}
                        </DropdownMenu.Item>
                    {/each}
                </DropdownMenu.Content>
            </DropdownMenu.Root>
        </div>
        <div
            class="h-36 px-2 cursor-col-resize select-none touch-none"
            onpointerdown={(e) => {
                isDragging = true;
                cachedChartRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                handleChartPointer(e);
            }}
            onpointermove={handleChartPointer}
            onpointerup={(e) => {
                isDragging = false;
                cachedChartRect = null;
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            }}
            onpointercancel={() => { isDragging = false; cachedChartRect = null; }}
            onwheel={(e) => {
                if (scrollEl) {
                    e.preventDefault();
                    const dy = e.deltaY;
                    requestAnimationFrame(() => { scrollEl!.scrollTop += dy; });
                }
            }}
        >
            <!-- svelte-ignore binding_property_non_reactive -->
            <div class="w-full h-full" bind:clientWidth={chartContainerWidth}>
            <BarChartComp
                data={chartData}
                x="date"
                axis="x"
                grid={false}
                rule={false}
                yDomain={chartYMax > 0 ? [0, chartYMax] : undefined}
                yScale={scaleSqrt()}
                series={[
                    {
                        key: "expense",
                        label: m.report_expenses(),
                        color: "var(--color-red-500)",
                    },
                    {
                        key: "income",
                        label: m.report_revenue(),
                        color: "var(--color-green-500)",
                    },
                ]}
                seriesLayout="stack"
                bandPadding={BAND_PADDING}
                xRange={computedXRange}
                bind:context={chartContext}
                props={{
                    svg: { clip: true },
                    bars: { strokeWidth: 0 },
                    tooltip: {
                        header: {
                            format: (d: unknown) => d instanceof Date
                                ? formatTooltipHeader(d, effectiveGranularity)
                                : String(d)
                        }
                    },
                    xAxis: { ticks: 5, format: (d: unknown) => d instanceof Date ? formatXAxisLabel(d, effectiveGranularity) : "" },
                }}
            >
                {#snippet belowMarks()}
                    {#if chartContext?.xScale && chartContext?.yScale}
                        {#each chartData as d}
                            {#if d.other > 0}
                                <rect
                                    x={chartContext.xScale(d.date)}
                                    y={chartContext.yScale(d.other)}
                                    width={chartContext.xScale.bandwidth()}
                                    height={Math.max(1, chartContext.yScale(0) - chartContext.yScale(d.other))}
                                    fill="var(--color-muted)"
                                />
                            {/if}
                        {/each}
                    {/if}
                {/snippet}
                {#snippet aboveMarks()}
                    {#if chartContext?.xScale && currentChartBucketDate && lastChartBucketDate}
                        {@const xScale = chartContext.xScale}
                        {@const p1 = xScale(currentChartBucketDate) ?? 0}
                        {@const p2 = xScale(lastChartBucketDate) ?? 0}
                        {@const bw = xScale.bandwidth()}
                        {@const left = Math.min(p1, p2)}
                        {@const right = Math.max(p1, p2) + bw}
                        {@const h = chartContext.height ?? 0}
                        <rect
                            x={left}
                            y={0}
                            width={right - left}
                            height={h}
                            fill="currentColor"
                            opacity={0.06}
                        />
                        <line x1={left} y1={0} x2={left} y2={h} stroke="currentColor" opacity={0.15} stroke-width={2} />
                        <line x1={right} y1={0} x2={right} y2={h} stroke="currentColor" opacity={0.15} stroke-width={2} />
                        <rect x={left} y={0} width={right - left} height={2} fill="currentColor" opacity={0.15} />
                        <rect x={left} y={h - 2} width={right - left} height={2} fill="currentColor" opacity={0.15} />
                    {/if}
                    {#if Rule_imported && hoveredChartBucketDate}
                        {@const RuleComp = Rule_imported}
                        <RuleComp
                            x={hoveredChartBucketDate}
                            class="stroke-foreground/50"
                            stroke-dasharray="4 3"
                            stroke-width={1.5}
                        />
                    {/if}
                {/snippet}
            </BarChartComp>
            </div>
        </div>
        </div>
    {:else if showChart && (store.loading || !BarChart_imported)}
        <Skeleton class="h-36 w-full" />
    {/if}

    <!-- Filter toolbar -->
    <div class="flex items-center gap-2">
        {#if isMobileLayout && multiSelectMode}
            <Checkbox
                checked={table.getIsAllPageRowsSelected()}
                indeterminate={table.getIsSomePageRowsSelected() &&
                    !table.getIsAllPageRowsSelected()}
                onCheckedChange={(v) =>
                    table.toggleAllPageRowsSelected(!!v)}
                aria-label={m.journal_select_all()}
            />
        {/if}
        <ListFilter
            bind:value={searchTerm}
            placeholder={m.placeholder_filter_entries()}
            class="min-w-0 w-[200px] lg:w-[250px] shrink"
        />
        <Popover.Root bind:open={filterPopoverOpen}>
            <Popover.Trigger>
                {#snippet child({ props })}
                    <Button variant="outline" size="sm" class="h-8 border-dashed" {...props}>
                        <Filter class="size-4" />
                        <span class="hidden sm:inline">{m.journal_filter()}</span>
                        {#if totalFilterCount > 0}
                            <Separator orientation="vertical" class="mx-1 h-4" />
                            <Badge variant="secondary" class="rounded-sm px-1 font-normal">
                                {totalFilterCount}
                            </Badge>
                        {/if}
                    </Button>
                {/snippet}
            </Popover.Trigger>
            <Popover.Content class="w-[280px] p-0" align="start" forceMount>
                <div class="flex border-b">
                    {#each [["account", m.label_account(), selectedAccounts.size] as const, ["tags", m.label_tags(), selectedTags.size] as const, ["links", m.label_links(), selectedLinks.size] as const] as [tab, label, count]}
                        <button
                            class="flex-1 px-2 py-1.5 text-sm font-medium transition-colors
                                {filterTab === tab ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}"
                            onclick={() => switchFilterTab(tab as "account" | "tags" | "links")}
                        >
                            {label}{count > 0 ? ` (${count})` : ''}
                        </button>
                    {/each}
                </div>
                <div class:hidden={filterTab !== "account"}>
                    <div class="flex h-9 items-center gap-2 border-b ps-3 pe-8">
                        <SearchIcon class="size-4 shrink-0 opacity-50" />
                        <input
                            type="text"
                            placeholder={m.placeholder_search_accounts()}
                            bind:value={accountSearch}
                            bind:this={accountInputRef}
                            class="placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden"
                        />
                    </div>
                    <div class="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
                        {#if accountOptionsLoading}
                            <div class="p-2 space-y-1.5">
                                {#each {length: 5} as _}<Skeleton class="h-8 w-full rounded-sm" />{/each}
                            </div>
                        {:else if filteredAccountOptions.length === 0}
                            <p class="py-6 text-center text-sm">{m.empty_no_results()}</p>
                        {:else}
                            <div class="text-foreground overflow-hidden p-1">
                                {#each filteredAccountOptions as option (option.value)}
                                    <button
                                        type="button"
                                        class="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
                                        onclick={() => toggleFilterValue(option.value)}
                                    >
                                        <Checkbox checked={selectedAccounts.has(option.value)} class="pointer-events-none" />
                                        <span class="truncate">{option.label}</span>
                                    </button>
                                {/each}
                            </div>
                            {#if selectedAccounts.size > 0}
                                <div class="bg-border -mx-1 h-px"></div>
                                <div class="text-foreground overflow-hidden p-1">
                                    <button type="button" class="relative flex w-full cursor-default items-center justify-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground" onclick={clearActiveFilter}>
                                        {m.journal_clear_filters()}
                                    </button>
                                </div>
                            {/if}
                        {/if}
                    </div>
                </div>
                <div class:hidden={filterTab !== "tags"}>
                    <div class="flex h-9 items-center gap-2 border-b ps-3 pe-8">
                        <SearchIcon class="size-4 shrink-0 opacity-50" />
                        <input
                            type="text"
                            placeholder={m.placeholder_search_tags()}
                            bind:value={tagSearch}
                            bind:this={tagInputRef}
                            class="placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden"
                        />
                    </div>
                    <div class="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
                        {#if tagOptionsLoading}
                            <div class="p-2 space-y-1.5">
                                {#each {length: 5} as _}<Skeleton class="h-8 w-full rounded-sm" />{/each}
                            </div>
                        {:else if filteredTagOptions.length === 0}
                            <p class="py-6 text-center text-sm">{m.empty_no_results()}</p>
                        {:else}
                            <div class="text-foreground overflow-hidden p-1">
                                {#each filteredTagOptions as option (option.value)}
                                    <button
                                        type="button"
                                        class="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
                                        onclick={() => toggleFilterValue(option.value)}
                                    >
                                        <Checkbox checked={selectedTags.has(option.value)} class="pointer-events-none" />
                                        <span class="truncate">{option.label}</span>
                                    </button>
                                {/each}
                            </div>
                            {#if selectedTags.size > 0}
                                <div class="bg-border -mx-1 h-px"></div>
                                <div class="text-foreground overflow-hidden p-1">
                                    <button type="button" class="relative flex w-full cursor-default items-center justify-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground" onclick={clearActiveFilter}>
                                        {m.journal_clear_filters()}
                                    </button>
                                </div>
                            {/if}
                        {/if}
                    </div>
                </div>
                <div class:hidden={filterTab !== "links"}>
                    <div class="flex h-9 items-center gap-2 border-b ps-3 pe-8">
                        <SearchIcon class="size-4 shrink-0 opacity-50" />
                        <input
                            type="text"
                            placeholder={m.placeholder_search_links()}
                            bind:value={linkSearch}
                            bind:this={linkInputRef}
                            class="placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden"
                        />
                    </div>
                    <div class="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
                        {#if linkOptionsLoading}
                            <div class="p-2 space-y-1.5">
                                {#each {length: 5} as _}<Skeleton class="h-8 w-full rounded-sm" />{/each}
                            </div>
                        {:else if filteredLinkOptions.length === 0}
                            <p class="py-6 text-center text-sm">{m.empty_no_results()}</p>
                        {:else}
                            <div class="text-foreground overflow-hidden p-1">
                                {#each filteredLinkOptions as option (option.value)}
                                    <button
                                        type="button"
                                        class="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
                                        onclick={() => toggleFilterValue(option.value)}
                                    >
                                        <Checkbox checked={selectedLinks.has(option.value)} class="pointer-events-none" />
                                        <span class="truncate">{option.label}</span>
                                    </button>
                                {/each}
                            </div>
                            {#if selectedLinks.size > 0}
                                <div class="bg-border -mx-1 h-px"></div>
                                <div class="text-foreground overflow-hidden p-1">
                                    <button type="button" class="relative flex w-full cursor-default items-center justify-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground" onclick={clearActiveFilter}>
                                        {m.journal_clear_filters()}
                                    </button>
                                </div>
                            {/if}
                        {/if}
                    </div>
                </div>
            </Popover.Content>
        </Popover.Root>
        {#if hasFacetedFilters}
            <Button
                variant="ghost"
                size="sm"
                class="h-8 px-2 lg:px-3"
                onclick={() => {
                    selectedAccounts = new Set();
                    selectedTags = new Set();
                    selectedLinks = new Set();
                }}
            >
                <span class="hidden sm:inline">{m.btn_reset()}</span>
                <X class="size-4" />
            </Button>
        {/if}
        <div class="ml-auto">
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                        <Button
                            variant="outline"
                            size="sm"
                            class="h-8"
                            {...props}
                        >
                            <SlidersHorizontal class="size-4" />
                            <span class="hidden sm:inline">{m.journal_view()}</span>
                        </Button>
                    {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-[150px]">
                    <DropdownMenu.Item
                        disabled
                        class="text-xs font-medium opacity-70"
                        >{m.journal_toggle_columns()}</DropdownMenu.Item
                    >
                    <DropdownMenu.Separator />
                    {#each table
                        .getAllColumns()
                        .filter((col) => col.getCanHide()) as column}
                        <DropdownMenu.CheckboxItem
                            checked={column.getIsVisible()}
                            onCheckedChange={(v) =>
                                column.toggleVisibility(!!v)}
                            >{column.columnDef
                                .header}</DropdownMenu.CheckboxItem
                        >
                    {/each}
                    <DropdownMenu.CheckboxItem
                        checked={columnVisibility.tags !== false}
                        onCheckedChange={(v) => {
                            columnVisibility = { ...columnVisibility, tags: !!v };
                            settings.update({ journalColumnVisibility: columnVisibility });
                        }}
                    >{m.label_tags()}</DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem
                        checked={columnVisibility.links !== false}
                        onCheckedChange={(v) => {
                            columnVisibility = { ...columnVisibility, links: !!v };
                            settings.update({ journalColumnVisibility: columnVisibility });
                        }}
                    >{m.label_links()}</DropdownMenu.CheckboxItem>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item disabled class="text-xs font-medium opacity-70">{m.journal_charts()}</DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.CheckboxItem
                        checked={showChart}
                        onCheckedChange={(v) => { showChart = !!v; settings.update({ journalShowChart: !!v }); }}
                    >{m.journal_timeline()}</DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem
                        checked={settings.settings.journalAmountBars !== false}
                        onCheckedChange={(v) => settings.update({ journalAmountBars: !!v })}
                    >{m.journal_amount_bars()}</DropdownMenu.CheckboxItem>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item disabled class="text-xs font-medium opacity-70">Icons</DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.CheckboxItem
                        checked={journalShowSourceIcons}
                        onCheckedChange={(v) => { journalShowSourceIcons = !!v; settings.update({ journalShowSourceIcons: !!v }); }}
                    >Source icons</DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem
                        checked={journalShowCurrencyIcons}
                        onCheckedChange={(v) => { journalShowCurrencyIcons = !!v; settings.update({ journalShowCurrencyIcons: !!v }); }}
                    >Currency icons</DropdownMenu.CheckboxItem>
                </DropdownMenu.Content>
            </DropdownMenu.Root>
        </div>
    </div>

    {#if store.loading}
        {#if store.loadProgress != null}
            <div class="h-1 w-full bg-muted overflow-hidden">
                <div
                    class="h-full bg-primary transition-[width] duration-150 ease-linear"
                    style="width: {store.loadProgress * 100}%"
                ></div>
            </div>
        {/if}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-4">
                <div class="space-y-2">
                    {#each [1, 2, 3, 4, 5] as _}
                        <Skeleton class="h-10 w-full" />
                    {/each}
                </div>
            </Card.Content>
        </Card.Root>
    {:else if store.error}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-8">
                <p class="text-sm text-destructive text-center">
                    {store.error}
                </p>
                <div class="flex justify-center mt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={() => store.load()}>{m.journal_retry()}</Button
                    >
                </div>
            </Card.Content>
        </Card.Root>
    {:else if displayEntries.length === 0 && (searchTerm || hasFacetedFilters)}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-8">
                <p class="text-sm text-muted-foreground text-center">
                    {m.journal_no_entries_match_filters()}
                </p>
                <div class="flex justify-center mt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={() => {
                            searchTerm = "";
                            selectedAccounts = new Set();
                            selectedTags = new Set();
                            selectedLinks = new Set();
                        }}>{m.journal_clear_all_filters()}</Button
                    >
                </div>
            </Card.Content>
        </Card.Root>
    {:else if displayEntries.length === 0}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-8">
                <p class="text-sm text-muted-foreground text-center">
                    {m.empty_no_journal_entries()}
                </p>
            </Card.Content>
        </Card.Root>
    {:else}
        <Card.Root
            class="border-x-0 border-b-0 rounded-none shadow-none py-0 flex-1 min-h-0 flex flex-col"
        >
            <div class="relative flex-1 min-h-0 flex flex-col">
                <div
                    bind:this={scrollEl}
                    class="overflow-y-auto overflow-x-hidden flex-1 min-h-0 [&_[data-slot=table-container]]:overflow-visible"
                >
                    <Table.Root class="border-separate border-spacing-0 [&_tr]:border-0 [&_td]:border-b [&_th]:border-b [&_tr:last-child_td]:border-b-0 [&_tr:last-child]:border-b-0">
                        <Table.Header class="sticky top-0 z-10 bg-background">
                            {#if !isMobileLayout}
                                {#each table.getHeaderGroups() as headerGroup}
                                    <Table.Row>
                                        {#each headerGroup.headers as header}
                                            {#if header.column.id === "select"}
                                                <Table.Head class="w-12">
                                                    <Checkbox
                                                        checked={table.getIsAllPageRowsSelected()}
                                                        indeterminate={table.getIsSomePageRowsSelected() &&
                                                            !table.getIsAllPageRowsSelected()}
                                                        onCheckedChange={(v) =>
                                                            table.toggleAllPageRowsSelected(
                                                                !!v,
                                                            )}
                                                        aria-label={m.journal_select_all()}
                                                    />
                                                </Table.Head>
                                            {:else if header.column.id === "date"}
                                                <SortableHeader
                                                    active={sort.key === "date"}
                                                    direction={sort.direction}
                                                    onclick={() =>
                                                        sort.toggle("date")}
                                                    class="w-28"
                                                    >{m.label_date()}</SortableHeader
                                                >
                                            {:else if header.column.id === "description"}
                                                <SortableHeader
                                                    active={sort.key ===
                                                        "description"}
                                                    direction={sort.direction}
                                                    onclick={() =>
                                                        sort.toggle(
                                                            "description",
                                                        )}
                                                    class=""
                                                    >{m.label_description()}</SortableHeader
                                                >
                                            {:else if header.column.id === "account"}
                                                <SortableHeader
                                                    active={sort.key ===
                                                        "account"}
                                                    direction={sort.direction}
                                                    onclick={() =>
                                                        sort.toggle("account")}
                                                    class="hidden lg:table-cell"
                                                    >{m.label_account()}</SortableHeader
                                                >
                                            {:else if header.column.id === "amount"}
                                                <SortableHeader
                                                    active={sort.key ===
                                                        "amount"}
                                                    direction={sort.direction}
                                                    onclick={() =>
                                                        sort.toggle("amount")}
                                                    class="text-right"
                                                    >{m.label_amount()}</SortableHeader
                                                >
                                            {/if}
                                        {/each}
                                    </Table.Row>
                                {/each}
                            {/if}
                        </Table.Header>
                        <Table.Body>
                            {#if paddingTop > 0}
                                <tr
                                    ><td
                                        style="height: {paddingTop}px;"
                                        colspan={visibleColCount}
                                    ></td></tr
                                >
                            {/if}
                            {@const rows = table.getRowModel().rows}
                            {#each virtualItems as vItem (vItem.key)}
                                {@const row = rows[vItem.index]}
                                {#if row}
                                    {@const entry = row.original}
                                    {@const items = getItems(entry.id)}
                                    {#if isMobileLayout}
                                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                                        {@const handlers =
                                            createLongPressHandlers(
                                                entry.id,
                                                row,
                                            )}
                                        <tr
                                            class="border-b touch-manipulation select-none {entry.status ===
                                            'voided'
                                                ? 'line-through opacity-50'
                                                : ''} {row.getIsSelected()
                                                ? 'bg-muted'
                                                : ''}"
                                            data-state={row.getIsSelected()
                                                ? "selected"
                                                : undefined}
                                            style={barGradientFromSegments(
                                                convertedBarSegments.get(entry.id) ?? entryBarSegments(items),
                                                maxEntryAmount,
                                            )}
                                            onpointerdown={handlers.onpointerdown}
                                            onpointermove={handlers.onpointermove}
                                            onpointerup={handlers.onpointerup}
                                            onpointercancel={handlers.onpointercancel}
                                            onmouseenter={() => { hoveredEntryDate = entry.date; }}
                                            onmouseleave={() => { hoveredEntryDate = null; }}
                                            oncontextmenu={(e) =>
                                                e.preventDefault()}
                                        >
                                            {#if multiSelectMode}
                                                <td
                                                    class="w-10 p-2 align-middle"
                                                >
                                                    <Checkbox
                                                        checked={row.getIsSelected()}
                                                        disabled={!row.getCanSelect()}
                                                        onCheckedChange={(v) =>
                                                            row.toggleSelected(
                                                                !!v,
                                                            )}
                                                        aria-label={m.journal_select_row()}
                                                    />
                                                </td>
                                            {/if}
                                            <td
                                                class="p-2 align-middle"
                                                colspan={multiSelectMode
                                                    ? undefined
                                                    : visibleColCount}
                                            >
                                                <div
                                                    class="flex justify-between items-baseline gap-2"
                                                >
                                                    <span class="flex items-center gap-1 min-w-0">
                                                        {#if columnVisibility.date !== false}
                                                            <span
                                                                class="text-muted-foreground text-xs shrink-0"
                                                                >{entry.date}</span
                                                            >
                                                        {/if}
                                                        {#if columnVisibility.account !== false && mainCounterpartyShort(items)}
                                                            <span class="text-muted-foreground text-xs truncate min-w-0">{#if columnVisibility.date !== false}·{/if} {mainCounterpartyShort(items)}</span>
                                                        {/if}
                                                    </span>
                                                    {#if columnVisibility.amount !== false}
                                                        <span
                                                            class="font-mono text-sm text-right shrink-0"
                                                            title={convertedTotals.get(
                                                                entry.id,
                                                            ) ?? ""}
                                                        >
                                                            {#each entryAmountDisplay(items) as part, i}
                                                                {#if i > 0}{" "}<span
                                                                        class="text-muted-foreground"
                                                                        >+</span
                                                                    >{" "}{/if}
                                                                {#if journalShowCurrencyIcons && part.segments.length > 0}
                                                                    <span class="inline-flex items-center gap-0.5 {amountColorClass(part.direction)}"
                                                                        >{#each part.segments as seg, j}{#if j > 0}<span class="text-muted-foreground">{part.isTrade ? "\u00a0→\u00a0" : ", "}</span>{/if}{seg.amount}&nbsp;<CoinIcon code={seg.currency} size={14} />{seg.currency}{/each}</span
                                                                    >
                                                                {:else}
                                                                    <span class={amountColorClass(part.direction)}>{part.text}</span>
                                                                {/if}
                                                            {/each}
                                                        </span>
                                                    {/if}
                                                </div>
                                                <div
                                                    class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0 mt-0.5"
                                                >
                                                    {#if journalShowSourceIcons}<SourceIcon source={entry.source} size={14} />{/if}
                                                    {#if columnVisibility.description !== false}
                                                        <span
                                                            class="font-medium overflow-clip text-ellipsis whitespace-nowrap"
                                                            title={entry.description}
                                                            >{entry.description}</span
                                                        >
                                                    {/if}
                                                    {#if columnVisibility.links !== false}
                                                        {#if entryLinks.get(entry.id)?.length}
                                                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                                                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                                                            <span
                                                                onclick={(e) =>
                                                                    e.stopPropagation()}
                                                            >
                                                                <LinkDisplay
                                                                    links={entryLinks.get(
                                                                        entry.id,
                                                                    )!}
                                                                    class="shrink-0"
                                                                    onclick={addLinkFilter}
                                                                />
                                                            </span>
                                                        {/if}
                                                    {/if}
                                                    {#if columnVisibility.tags !== false}
                                                        {#if entryTags.get(entry.id)?.length}
                                                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                                                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                                                            <span
                                                                onclick={(e) =>
                                                                    e.stopPropagation()}
                                                            >
                                                                <TagDisplay
                                                                    tags={entryTags.get(
                                                                        entry.id,
                                                                    )!}
                                                                    class="shrink-0"
                                                                    onclick={addTagFilter}
                                                                />
                                                            </span>
                                                        {/if}
                                                    {/if}
                                                    {#if entryNotes.get(entry.id)}
                                                        <span title={entryNotes.get(entry.id)} class="text-muted-foreground shrink-0">
                                                            <StickyNote class="h-3.5 w-3.5 inline" />
                                                        </span>
                                                    {/if}
                                                </div>
                                            </td>
                                        </tr>
                                    {:else}
                                        <Table.Row
                                            class="cursor-pointer {entry.status === "voided"
                                                ? "line-through opacity-50"
                                                : ""}"
                                            data-state={row.getIsSelected()
                                                ? "selected"
                                                : undefined}
                                            style={barGradientFromSegments(
                                                convertedBarSegments.get(entry.id) ?? entryBarSegments(items),
                                                maxEntryAmount,
                                            )}
                                            onclick={() => openEntryDrawer("view", entry.id)}
                                            onmouseenter={() => { hoveredEntryDate = entry.date; }}
                                            onmouseleave={() => { hoveredEntryDate = null; }}
                                        >
                                            {#each row.getVisibleCells() as cell}
                                                {#if cell.column.id === "select"}
                                                    <Table.Cell
                                                        class="py-2 px-2 w-12"
                                                        onclick={(e) => e.stopPropagation()}
                                                    >
                                                        <Checkbox
                                                            checked={row.getIsSelected()}
                                                            disabled={!row.getCanSelect()}
                                                            onCheckedChange={(
                                                                v,
                                                            ) =>
                                                                row.toggleSelected(
                                                                    !!v,
                                                                )}
                                                            aria-label={m.journal_select_row()}
                                                        />
                                                    </Table.Cell>
                                                {:else if cell.column.id === "date"}
                                                    <Table.Cell
                                                        class="text-muted-foreground text-sm p-2"
                                                        >{entry.date}</Table.Cell
                                                    >
                                                {:else if cell.column.id === "description"}
                                                    <Table.Cell class="p-2">
                                                        <div
                                                            class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0"
                                                        >
                                                            {#if journalShowSourceIcons}<SourceIcon source={entry.source} size={14} />{/if}
                                                            <span
                                                                class="font-medium overflow-clip text-ellipsis whitespace-nowrap max-w-md"
                                                                title={entry.description}
                                                                >{entry.description}</span
                                                            >
                                                            {#if columnVisibility.tags !== false}
                                                                {#if entryTags.get(entry.id)?.length}
                                                                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                                                                    <span onclick={(e) => e.stopPropagation()}>
                                                                        <TagDisplay
                                                                            tags={entryTags.get(
                                                                                entry.id,
                                                                            )!}
                                                                            class="shrink-0"
                                                                            onclick={addTagFilter}
                                                                        />
                                                                    </span>
                                                                {/if}
                                                            {/if}
                                                            {#if columnVisibility.links !== false}
                                                                {#if entryLinks.get(entry.id)?.length}
                                                                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                                                                    <span onclick={(e) => e.stopPropagation()}>
                                                                        <LinkDisplay
                                                                            links={entryLinks.get(
                                                                                entry.id,
                                                                            )!}
                                                                            class="shrink-0"
                                                                            onclick={addLinkFilter}
                                                                        />
                                                                    </span>
                                                                {/if}
                                                            {/if}
                                                            {#if entryNotes.get(entry.id)}
                                                                <span title={entryNotes.get(entry.id)} class="text-muted-foreground shrink-0">
                                                                    <StickyNote class="h-3.5 w-3.5 inline" />
                                                                </span>
                                                            {/if}
                                                        </div>
                                                    </Table.Cell>
                                                {:else if cell.column.id === "account"}
                                                    <Table.Cell class="text-muted-foreground text-sm p-2 hidden lg:table-cell">
                                                        <span class="hidden xl:inline" title={mainCounterpartyFull(items)}>{mainCounterparty(items)}</span>
                                                        <span class="xl:hidden" title={mainCounterpartyFull(items)}>{mainCounterpartyShort(items)}</span>
                                                    </Table.Cell>
                                                {:else if cell.column.id === "amount"}
                                                    <Table.Cell
                                                        class="text-right font-mono p-2"
                                                        title={convertedTotals.get(
                                                            entry.id,
                                                        ) ?? ""}
                                                    >
                                                        {#each entryAmountDisplay(items) as part, i}
                                                            {#if i > 0}{" "}<span
                                                                    class="text-muted-foreground"
                                                                    >+</span
                                                                >{" "}{/if}
                                                            {#if journalShowCurrencyIcons && part.segments.length > 0}
                                                                <span class="inline-flex items-center gap-0.5 {amountColorClass(part.direction)}"
                                                                    >{#each part.segments as seg, j}{#if j > 0}<span class="text-muted-foreground">{part.isTrade ? "\u00a0→\u00a0" : ", "}</span>{/if}{seg.amount}&nbsp;<CoinIcon code={seg.currency} size={14} />{seg.currency}{/each}</span
                                                                >
                                                            {:else}
                                                                <span class={amountColorClass(part.direction)}>{part.text}</span>
                                                            {/if}
                                                        {/each}
                                                    </Table.Cell>
                                                {/if}
                                            {/each}
                                        </Table.Row>
                                    {/if}
                                {/if}
                            {/each}
                            {#if paddingBottom > 0}
                                <tr
                                    ><td
                                        style="height: {paddingBottom}px;"
                                        colspan={visibleColCount}
                                    ></td></tr
                                >
                            {/if}
                        </Table.Body>
                    </Table.Root>
                </div>

                {#if showPill && positionLabel}
                    <div
                        class="fixed md:absolute bottom-[11.75rem] md:bottom-12 right-4 z-20 rounded-md border
                      bg-background px-3 py-1 text-xs text-muted-foreground
                      shadow-sm"
                    >
                        {m.journal_position_of({ position: positionLabel, total: store.totalCount })}
                    </div>
                {/if}

                {#if isScrolledDown}
                    <button
                        type="button"
                        class="fixed md:absolute bottom-[9.5rem] md:bottom-3 right-4 z-20 flex h-8 w-8 items-center
                   justify-center rounded-full border bg-background
                   text-muted-foreground shadow-sm
                   hover:text-foreground"
                        onclick={() =>
                            virtualizer.scrollToOffset(0, {
                                behavior: "smooth",
                            })}
                        title={m.btn_back_to_top()}
                    >
                        <ArrowUp class="size-4" />
                    </button>
                {/if}
            </div>
        </Card.Root>

        {#if selectedCount > 0}
            <div
                class="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-50
                        flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5
                        max-w-[calc(100vw-2rem)] rounded-lg border bg-background
                        px-4 py-2.5 shadow-md"
            >
                <span class="text-sm text-muted-foreground whitespace-nowrap">
                    {m.journal_entries_selected({ count: selectedCount })}
                </span>
                <div class="hidden sm:block h-4 w-px bg-border"></div>
                <Popover.Root bind:open={batchTagOpen}>
                    <Popover.Trigger>
                        {#snippet child({ props })}
                            <Button variant="outline" size="sm" {...props}>
                                <Tag class="size-3.5 mr-1" />{m.label_tags()}
                            </Button>
                        {/snippet}
                    </Popover.Trigger>
                    <Popover.Content side="top" class="w-72 p-3">
                        <div class="space-y-3">
                            <ButtonGroup.Root class="w-full">
                                <Button
                                    variant={batchTagMode === "add"
                                        ? "default"
                                        : "outline"}
                                    size="sm"
                                    class="flex-1"
                                    onclick={() => {
                                        batchTagMode = "add";
                                    }}>{m.btn_add()}</Button
                                >
                                <Button
                                    variant={batchTagMode === "remove"
                                        ? "default"
                                        : "outline"}
                                    size="sm"
                                    class="flex-1"
                                    onclick={() => {
                                        batchTagMode = "remove";
                                    }}>{m.btn_remove()}</Button
                                >
                            </ButtonGroup.Root>
                            <TagInput
                                tags={batchTags}
                                onchange={(t) => {
                                    batchTags = t;
                                }}
                                suggestions={tagOptions.map((o) => o.value)}
                            />
                            <Button
                                size="sm"
                                class="w-full"
                                disabled={batchTagBusy ||
                                    batchTags.length === 0}
                                onclick={handleBatchTag}
                            >
                                {#if batchTagBusy}<Loader
                                        class="size-3 mr-1 animate-spin"
                                    />{/if}
                                {m.journal_batch_tags_action({ mode: batchTagMode, count: batchTags.length })}
                            </Button>
                        </div>
                    </Popover.Content>
                </Popover.Root>
                <Popover.Root bind:open={batchLinkOpen}>
                    <Popover.Trigger>
                        {#snippet child({ props })}
                            <Button variant="outline" size="sm" {...props}>
                                <Link2 class="size-3.5 mr-1" />{m.label_links()}
                            </Button>
                        {/snippet}
                    </Popover.Trigger>
                    <Popover.Content side="top" class="w-72 p-3">
                        <div class="space-y-3">
                            <ButtonGroup.Root class="w-full">
                                <Button
                                    variant={batchLinkMode === "add"
                                        ? "default"
                                        : "outline"}
                                    size="sm"
                                    class="flex-1"
                                    onclick={() => {
                                        batchLinkMode = "add";
                                    }}>{m.btn_add()}</Button
                                >
                                <Button
                                    variant={batchLinkMode === "remove"
                                        ? "default"
                                        : "outline"}
                                    size="sm"
                                    class="flex-1"
                                    onclick={() => {
                                        batchLinkMode = "remove";
                                    }}>{m.btn_remove()}</Button
                                >
                            </ButtonGroup.Root>
                            <LinkInput
                                links={batchLinks}
                                onchange={(l) => {
                                    batchLinks = l;
                                }}
                                suggestions={linkOptions.map((o) => o.value)}
                            />
                            <Button
                                size="sm"
                                class="w-full"
                                disabled={batchLinkBusy ||
                                    batchLinks.length === 0}
                                onclick={handleBatchLink}
                            >
                                {#if batchLinkBusy}<Loader
                                        class="size-3 mr-1 animate-spin"
                                    />{/if}
                                {m.journal_batch_links_action({ mode: batchLinkMode, count: batchLinks.length })}
                            </Button>
                        </div>
                    </Popover.Content>
                </Popover.Root>
                <Button
                    variant="destructive"
                    size="sm"
                    disabled={batchVoiding}
                    onclick={handleBatchVoid}
                >
                    {#if batchVoiding}<Loader
                            class="size-3.5 mr-1 animate-spin"
                        />{m.journal_voiding()}{:else}{m.journal_void_selected()}{/if}
                </Button>
                <Button variant="ghost" size="sm" onclick={clearSelection}>
                    <X class="size-4" />
                </Button>
            </div>
        {/if}
    {/if}
</div>

<!-- Reinterpret Preview Dialog -->
<ReinterpretPreviewDialog
    bind:open={showReinterpret}
    candidates={reinterpretCandidates}
    onApplied={() => store.load()}
/>

<!-- Cross-Source Match Dialog -->
<MatchDialog
    bind:open={showMatches}
    matches={matchCandidates}
    accountMap={matchAccountMap}
    onMerged={() => store.load()}
/>

<!-- Duplicate Detection Dialog -->
<Dialog.Root bind:open={showDuplicates}>
    <Dialog.Content
        class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto"
    >
        <Dialog.Header>
            <Dialog.Title>{m.dialog_duplicate_detection()}</Dialog.Title>
            <Dialog.Description>
                {m.journal_duplicate_description()}
            </Dialog.Description>
        </Dialog.Header>
        {#if duplicateGroups.length === 0}
            <p class="text-sm text-muted-foreground py-8 text-center">
                {m.journal_no_duplicates_found()}
            </p>
        {:else}
            <div class="space-y-4">
                {#each duplicateGroups as group, gi}
                    <div class="rounded-md border p-3 space-y-2">
                        <div class="flex items-center gap-2">
                            <Badge
                                variant={group.confidence === "likely"
                                    ? "destructive"
                                    : "secondary"}
                            >
                                {group.confidence === "likely"
                                    ? m.journal_likely_duplicate()
                                    : m.journal_possible_duplicate()}
                            </Badge>
                            <span class="text-xs text-muted-foreground"
                                >{m.journal_n_entries({ count: group.entries.length })}</span
                            >
                        </div>
                        {#each group.entries as [entry, items]}
                            <div
                                class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30"
                            >
                                <div class="flex items-center gap-3">
                                    <span class="text-muted-foreground w-24"
                                        >{entry.date}</span
                                    >
                                    <button
                                        class="hover:underline text-left"
                                        onclick={() => openEntryDrawer("view", entry.id)}
                                        >{entry.description}</button
                                    >
                                </div>
                                <div class="flex items-center gap-2">
                                    <span
                                        class="font-mono text-xs"
                                        title={convertedTotals.get(entry.id) ??
                                            ""}
                                    >
                                        {#each entryAmountDisplay(items) as part, i}
                                            {#if i > 0}{" "}<span
                                                    class="text-muted-foreground"
                                                    >+</span
                                                >{" "}{/if}
                                            {#if journalShowCurrencyIcons && part.segments.length > 0}
                                                <span class="inline-flex items-center gap-0.5 {amountColorClass(part.direction)}"
                                                    >{#each part.segments as seg, j}{#if j > 0}<span class="text-muted-foreground">{part.isTrade ? "\u00a0→\u00a0" : ", "}</span>{/if}{seg.amount}&nbsp;<CoinIcon code={seg.currency} size={14} />{seg.currency}{/each}</span
                                                >
                                            {:else}
                                                <span class={amountColorClass(part.direction)}>{part.text}</span>
                                            {/if}
                                        {/each}
                                    </span>
                                    <Badge variant="outline" class="text-xs"
                                        >{entry.status}</Badge
                                    >
                                    {#if entry.status !== "voided"}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            class="h-6 text-xs text-destructive hover:text-destructive"
                                            onclick={async () => {
                                                try {
                                                    await getBackend().voidJournalEntry(
                                                        entry.id,
                                                    );
                                                    await store.load();
                                                    toast.success(
                                                        m.toast_entry_voided(),
                                                    );
                                                } catch (e) {
                                                    toast.error(String(e));
                                                }
                                            }}>{m.journal_void()}</Button
                                        >
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/each}
            </div>
        {/if}
    </Dialog.Content>
</Dialog.Root>

<JournalEntryDrawer
    bind:open={drawerOpen}
    bind:entryId={drawerEntryId}
    onedit={() => { drawerOpen = false; openEntryDrawer("edit", drawerEntryId ?? undefined); }}
    onclose={closeEntryDrawer}
    onsaved={(newId) => {
        drawerEntryId = newId;
        const url = new URL(window.location.href);
        url.searchParams.set("entry", newId);
        replaceState(url, {});
    }}
/>

<JournalEntryDialog
    bind:open={dialogOpen}
    mode={dialogMode}
    bind:entryId={dialogEntryId}
    onsaved={(newId) => { dialogOpen = false; openEntryDrawer("view", newId); }}
    onclose={() => { dialogOpen = false; }}
/>

<style>
    :global(tr[style*="--bar-width"]) {
        position: relative;
    }
    :global(tr[style*="--bar-width"]::after) {
        content: '';
        position: absolute;
        bottom: 0;
        right: 0;
        width: var(--bar-width);
        height: 20%;
        background: var(--bar-bg);
        border-radius: 9999px 0 0 9999px;
        pointer-events: none;
    }
</style>

