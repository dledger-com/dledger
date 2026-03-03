<script lang="ts">
    import { onDestroy } from "svelte";
    import { page } from "$app/state";
    import { replaceState } from "$app/navigation";
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

    import MatchDialog from "$lib/components/MatchDialog.svelte";
    import { extractAllCandidates } from "$lib/matching/extract.js";
    import { findMatches } from "$lib/matching/score.js";
    import type { MatchCandidate } from "$lib/matching/types.js";
    import type { Account } from "$lib/types/index.js";

    import ListFilter from "$lib/components/ListFilter.svelte";
    import TagDisplay from "$lib/components/TagDisplay.svelte";
    import LinkDisplay from "$lib/components/LinkDisplay.svelte";
    import { parseTags, TAGS_META_KEY } from "$lib/utils/tags.js";
    import { formatExtension, type LedgerFormat } from "$lib/ledger-format.js";
    import SortableHeader from "$lib/components/SortableHeader.svelte";
    import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
    import type { TransactionFilter } from "$lib/types/index.js";
    import { createVirtualizer } from "$lib/utils/virtual.svelte.js";

    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
    import Download from "lucide-svelte/icons/download";
    import X from "lucide-svelte/icons/x";
    import SlidersHorizontal from "lucide-svelte/icons/sliders-horizontal";
    import FacetedFilter from "$lib/components/FacetedFilter.svelte";
    import { Checkbox } from "$lib/components/ui/checkbox/index.js";
    import { createSvelteTable } from "$lib/components/ui/data-table/data-table.svelte.js";
    import { type ColumnDef, getCoreRowModel, type RowSelectionState, type VisibilityState } from "@tanstack/table-core";
    import { invalidate } from "$lib/data/invalidation.js";

    const store = new JournalStore();
    const settings = new SettingsStore();
    const hidden = $derived(
        settings.showHidden ? new Set<string>() : getHiddenCurrencySet(),
    );
    const filteredEntries = $derived(
        filterHiddenEntries(store.entries, hidden),
    );

    // Reload when journal data changes elsewhere (imports, cross-tab)
    const unsubJournal = onInvalidate("journal", () => {
        store.loadAll();
        // Refresh tag options (new tags may have been added via import)
        getBackend().getAllTagValues().then((tags) => {
            tagOptions = tags.map((t) => ({ value: t, label: t }));
        });
    });
    onDestroy(unsubJournal);

    // Load faceted filter options
    $effect(() => {
        const backend = getBackend();
        backend.listAccounts().then((accounts) => {
            accountOptions = accounts
                .filter((a: Account) => !a.is_archived)
                .map((a: Account) => ({ value: a.id, label: a.full_name }))
                .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));
        });
        backend.getAllTagValues().then((tags) => {
            tagOptions = tags.map((t) => ({ value: t, label: t }));
        });
    });

    let exporting = $state(false);
    let detectingDuplicates = $state(false);
    let searchTerm = $state(page.url?.searchParams.get("q") ?? "");
    let showDuplicates = $state(false);

    // Faceted filters
    let selectedAccounts = $state<Set<string>>(new Set());
    let selectedTags = $state<Set<string>>(new Set());
    let accountOptions = $state<{ value: string; label: string }[]>([]);
    let tagOptions = $state<{ value: string; label: string }[]>([]);
    const hasFacetedFilters = $derived(selectedAccounts.size > 0 || selectedTags.size > 0);

    // TanStack Table state
    type JournalRow = [JournalEntry, LineItem[]];

    const columns: ColumnDef<JournalRow>[] = [
        { id: "select", enableSorting: false, enableHiding: false },
        { id: "date", header: "Date", enableHiding: true },
        { id: "description", header: "Description", enableHiding: true },
        { id: "amount", header: "Amount", enableHiding: true },
    ];

    let rowSelection = $state<RowSelectionState>({});
    let columnVisibility = $state<VisibilityState>({});

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

    function findDuplicateGroups(
        entries: [JournalEntry, LineItem[]][],
    ): DuplicateGroup[] {
        // O(n): bucket by "date|amounts-fingerprint"
        const buckets = new Map<string, [JournalEntry, LineItem[]][]>();
        for (const [entry, items] of entries) {
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
            bucket.push([entry, items]);
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

    // Debounced backend search
    let debounceTimer: ReturnType<typeof setTimeout>;
    $effect(() => {
        const { groups, backendText } = searchFilters;
        const orderBy = sort.key !== "amount" ? sort.key : null;
        const orderDir = sort.direction;
        const accountFilter = selectedAccounts;
        const tagFilter = selectedTags;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
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

            store.load(filter).then(() => {
                virtualizer.scrollToOffset(0);
            });
        }, 300);
        return () => clearTimeout(debounceTimer);
    });

    function totalDebits(items: { amount: string }[]): number {
        return items.reduce((sum, i) => {
            const n = parseFloat(i.amount);
            return n > 0 ? sum + n : sum;
        }, 0);
    }

    function debitsByCurrency(
        items: { amount: string; currency: string }[],
    ): CurrencyBalance[] {
        const map = new Map<string, number>();
        for (const item of items) {
            const n = parseFloat(item.amount);
            if (n > 0)
                map.set(item.currency, (map.get(item.currency) ?? 0) + n);
        }
        return [...map].map(([currency, amount]) => ({
            currency,
            amount: String(amount),
        }));
    }

    function formatDebitTotal(
        items: { amount: string; currency: string }[],
    ): string {
        const byCode = debitsByCurrency(items);
        if (byCode.length === 0) return formatCurrency(0, settings.currency);
        return byCode
            .map((b) => formatCurrency(b.amount, b.currency))
            .join(", ");
    }

    // Metadata state — declared before displayEntries to avoid TDZ
    let entryTags = $state<Map<string, string[]>>(new Map());
    let entryLinks = $state<Map<string, string[]>>(new Map());

    // Post-filter: OR across comma-separated groups, AND within each group
    const displayEntries = $derived.by(() => {
        const { groups } = searchFilters;
        if (groups.length === 0) return filteredEntries;
        const single = groups.length === 1;
        // Single group: tags/links already filtered by backend SQL, no client-side filtering needed
        if (
            single &&
            groups[0].tags.length === 0 &&
            groups[0].links.length === 0
        )
            return filteredEntries;
        if (single) return filteredEntries;
        // Multi-group: client-side OR filtering across groups
        return filteredEntries.filter(([entry]) => {
            return groups.some(({ tags, links, text }) => {
                if (
                    text &&
                    !entry.description
                        .toLowerCase()
                        .includes(text.toLowerCase())
                )
                    return false;
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
    const sortedEntries = $derived.by(() => {
        if (sort.key === "amount" && sort.direction)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return sortItems(
                displayEntries,
                ([, items]: [any, any]) => totalDebits(items),
                sort.direction,
            );
        return displayEntries;
    });

    // TanStack Table instance
    const table = createSvelteTable({
        get data() { return sortedEntries; },
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row[0].id,
        state: {
            get rowSelection() { return rowSelection; },
            get columnVisibility() { return columnVisibility; },
        },
        onRowSelectionChange: (updater) => {
            rowSelection = typeof updater === "function" ? updater(rowSelection) : updater;
        },
        onColumnVisibilityChange: (updater) => {
            columnVisibility = typeof updater === "function" ? updater(columnVisibility) : updater;
        },
        enableRowSelection: (row) => row.original[0].status !== "voided",
    });

    const visibleColCount = $derived(table.getVisibleLeafColumns().length);
    const selectedCount = $derived(table.getFilteredSelectedRowModel().rows.length);
    function clearSelection() { rowSelection = {}; }

    // Clear selection when filters/sort change
    $effect(() => {
        void searchTerm; void selectedAccounts; void selectedTags;
        void sort.key; void sort.direction;
        rowSelection = {};
    });

    let batchVoiding = $state(false);

    async function handleBatchVoid() {
        batchVoiding = true;
        try {
            const selectedRows = table.getFilteredSelectedRowModel().rows;
            const ids = selectedRows
                .map((r) => r.original[0])
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
                toast.success(`${success} ${success === 1 ? "entry" : "entries"} voided`);
            } else {
                toast.warning(`${success} voided, ${failed} failed`);
            }
        } catch (err) {
            toast.error(String(err));
        } finally {
            batchVoiding = false;
            clearSelection();
        }
    }

    // Mobile layout detection for virtual row height
    let isMobileLayout = $state(false);
    $effect(() => {
        const mq = window.matchMedia("(max-width: 639px)");
        isMobileLayout = mq.matches;
        const handler = (e: MediaQueryListEvent) => { isMobileLayout = e.matches; };
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    });

    // Virtual scrolling
    let scrollEl = $state<HTMLDivElement | null>(null);

    const virtualizer = createVirtualizer(() => ({
        count: sortedEntries.length,
        getScrollElement: () => scrollEl,
        estimateSize: () => isMobileLayout ? 64 : 44,
        overscan: 10,
    }));

    const virtualItems = $derived(
        virtualizer
            .getVirtualItems()
            .filter((row) => row.index < sortedEntries.length),
    );
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
        ),
    );

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

    // Visible-range metadata loading
    let tagGen = 0;
    let prevFilteredRef: unknown = null;
    let linkGen = 0;

    // Derive visible entry IDs
    const visibleEntryIds = $derived(
        virtualizer
            .getVirtualItems()
            .map((item) => sortedEntries[item.index]?.[0]?.id)
            .filter(Boolean),
    );

    let tagDebounce: ReturnType<typeof setTimeout>;
    $effect(() => {
        const ids = visibleEntryIds;
        // Clear maps when underlying data changes
        if (filteredEntries !== prevFilteredRef) {
            prevFilteredRef = filteredEntries;
            entryTags = new Map();
            entryLinks = new Map();
            convertedTotals = new Map();
        }
        if (ids.length === 0) return;
        clearTimeout(tagDebounce);
        const gen = ++tagGen;
        tagDebounce = setTimeout(async () => {
            // Filter to IDs we haven't loaded yet
            const needed = ids.filter((id) => !entryTags.has(id));
            if (needed.length === 0) return;
            try {
                const backend = getBackend();
                let metaMap: Map<string, Record<string, string>>;
                if (backend.getMetadataBatch) {
                    metaMap = await backend.getMetadataBatch(needed);
                } else {
                    const metas = await Promise.all(
                        needed.map((id) =>
                            backend
                                .getMetadata(id)
                                .catch(() => ({}) as Record<string, string>),
                        ),
                    );
                    metaMap = new Map(needed.map((id, i) => [id, metas[i]]));
                }
                if (gen !== tagGen) return;
                const merged = new Map(entryTags);
                for (const [id, meta] of metaMap) {
                    const tags = parseTags(meta[TAGS_META_KEY]);
                    if (tags.length > 0) merged.set(id, tags);
                    else merged.set(id, []); // Mark as loaded (empty)
                }
                entryTags = merged;
            } catch {
                /* ignore */
            }
        }, 80);
        return () => clearTimeout(tagDebounce);
    });

    let linkDebounce: ReturnType<typeof setTimeout>;
    $effect(() => {
        const ids = visibleEntryIds;
        if (ids.length === 0) return;
        clearTimeout(linkDebounce);
        const gen = ++linkGen;
        linkDebounce = setTimeout(async () => {
            const needed = ids.filter((id) => !entryLinks.has(id));
            if (needed.length === 0) return;
            try {
                const backend = getBackend();
                let linkMap: Map<string, string[]>;
                if (backend.getEntryLinksBatch) {
                    linkMap = await backend.getEntryLinksBatch(needed);
                } else {
                    const links = await Promise.all(
                        needed.map((id) =>
                            backend
                                .getEntryLinks(id)
                                .catch(() => [] as string[]),
                        ),
                    );
                    linkMap = new Map(needed.map((id, i) => [id, links[i]]));
                }
                if (gen !== linkGen) return;
                const merged = new Map(entryLinks);
                for (const [id, links] of linkMap) {
                    merged.set(id, links);
                }
                // Mark entries with no links as loaded
                for (const id of needed) {
                    if (!merged.has(id)) merged.set(id, []);
                }
                entryLinks = merged;
            } catch {
                /* ignore */
            }
        }, 80);
        return () => clearTimeout(linkDebounce);
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
    let conversionGen = 0;

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
            const asyncEntries: [string, CurrencyBalance[], string][] = [];

            for (const id of needed) {
                const pair = sortedEntries.find(([e]) => e.id === id);
                if (!pair) continue;
                const [entry, items] = pair;
                const debits = debitsByCurrency(items);
                if (debits.length === 0) {
                    results.set(entry.id, formatCurrency(0, baseCurrency));
                } else if (debits.every((b) => b.currency === baseCurrency)) {
                    const total = debits.reduce(
                        (s, b) => s + parseFloat(b.amount),
                        0,
                    );
                    results.set(entry.id, formatCurrency(total, baseCurrency));
                } else {
                    asyncEntries.push([entry.id, debits, entry.date]);
                }
            }
            if (gen !== conversionGen) return;
            convertedTotals = new Map(results);

            for (const [id, debits, date] of asyncEntries) {
                if (gen !== conversionGen) return;
                const summary = await convertBalances(
                    debits,
                    baseCurrency,
                    date,
                    cache,
                );
                if (gen !== conversionGen) return;

                let formatted: string;
                if (summary.unconverted.length === 0) {
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
        }, 100);
        return () => clearTimeout(convDebounce);
    });

    async function handleExport(format: LedgerFormat) {
        exporting = true;
        try {
            const content = await getBackend().exportLedgerFile(format);
            const blob = new Blob([content], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `dledger-export${formatExtension(format)}`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Ledger file exported");
        } catch (err) {
            toast.error(String(err));
        } finally {
            exporting = false;
        }
    }
</script>

<div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="shrink-0">
            <h1 class="text-2xl font-bold tracking-tight">Journal</h1>
            <p class="text-muted-foreground hidden sm:block">
                View and manage all journal entries.
            </p>
        </div>
        <div class="flex flex-wrap gap-2 shrink-0">
            <Button
                variant="outline"
                size="sm"
                class="hidden sm:inline-flex"
                disabled={findingMatches}
                onclick={async () => {
                    findingMatches = true;
                    try {
                        const backend = getBackend();
                        const allEntries = await backend.queryJournalEntries(
                            {},
                        );
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
                            if (
                                meta["cross_match_linked"] ||
                                meta["cex_linked"] ||
                                meta["cross_match_skipped"]
                            )
                                linked.add(entry.id);
                        }
                        const nonVoided = allEntries.filter(
                            ([e]) => !e.voided_by,
                        );
                        const candidates = extractAllCandidates(
                            nonVoided,
                            idToName,
                            linked,
                        );
                        // Load metadata for scoring
                        const metaMap = new Map<
                            string,
                            Record<string, string>
                        >();
                        for (const c of candidates) {
                            metaMap.set(
                                c.entry.id,
                                await backend.getMetadata(c.entry.id),
                            );
                        }
                        matchCandidates = findMatches(candidates, metaMap);
                        matchAccountMap = accMap;
                        showMatches = true;
                    } catch (e) {
                        toast.error(String(e));
                    } finally {
                        findingMatches = false;
                    }
                }}
            >
                {#if findingMatches}
                    <Loader class="h-3.5 w-3.5 mr-1 animate-spin" />
                {/if}
                {findingMatches ? "Finding..." : "Find Matches"}
            </Button>
            <Button
                variant="outline"
                size="sm"
                class="hidden sm:inline-flex"
                disabled={detectingDuplicates}
                onclick={async () => {
                    detectingDuplicates = true;
                    try {
                        const allEntries =
                            await getBackend().queryJournalEntries({});
                        const filtered = filterHiddenEntries(
                            allEntries,
                            getHiddenCurrencySet(),
                        );
                        duplicateGroups = findDuplicateGroups(filtered);
                        showDuplicates = true;
                    } finally {
                        detectingDuplicates = false;
                    }
                }}
            >
                {#if detectingDuplicates}
                    <Loader class="h-3.5 w-3.5 mr-1 animate-spin" />
                {/if}
                {detectingDuplicates ? "Detecting..." : "Detect Duplicates"}
            </Button>
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                        <Button
                            variant="outline"
                            size="sm"
                            {...props}
                            disabled={exporting}
                        >
                            <Download class="h-3.5 w-3.5 mr-1" />
                            {exporting ? "Exporting..." : "Export"}
                        </Button>
                    {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                    <DropdownMenu.Item
                        onclick={() => handleExport("beancount")}
                    >
                        Beancount (.beancount)
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onclick={() => handleExport("hledger")}>
                        hledger (.journal)
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onclick={() => handleExport("ledger")}>
                        ledger (.ledger)
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Button size="sm" href="/journal/new">New Entry</Button>
        </div>
    </div>

    <!-- Filter toolbar -->
    <div class="flex flex-wrap items-center gap-2">
        <ListFilter
            bind:value={searchTerm}
            placeholder="Filter entries..."
            class="w-[200px] lg:w-[250px]"
        />
        <FacetedFilter
            title="Account"
            options={accountOptions}
            bind:selected={selectedAccounts}
        />
        <FacetedFilter
            title="Tags"
            options={tagOptions}
            bind:selected={selectedTags}
        />
        {#if hasFacetedFilters}
            <Button
                variant="ghost"
                size="sm"
                class="h-8 px-2 lg:px-3"
                onclick={() => {
                    selectedAccounts = new Set();
                    selectedTags = new Set();
                }}
            >
                Reset
                <X class="size-4" />
            </Button>
        {/if}
        <div class="ml-auto">
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                        <Button variant="outline" size="sm" class="h-8" {...props}>
                            <SlidersHorizontal class="size-4" />
                            View
                        </Button>
                    {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-[150px]">
                    <DropdownMenu.Item disabled class="text-xs font-medium opacity-70">Toggle columns</DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    {#each table.getAllColumns().filter((col) => col.getCanHide()) as column}
                        <DropdownMenu.CheckboxItem
                            checked={column.getIsVisible()}
                            onCheckedChange={(v) => column.toggleVisibility(!!v)}
                        >{column.columnDef.header}</DropdownMenu.CheckboxItem>
                    {/each}
                </DropdownMenu.Content>
            </DropdownMenu.Root>
        </div>
    </div>

    {#if store.loading}
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
                        onclick={() => store.load()}>Retry</Button
                    >
                </div>
            </Card.Content>
        </Card.Root>
    {:else if displayEntries.length === 0 && (searchTerm || hasFacetedFilters)}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-8">
                <p class="text-sm text-muted-foreground text-center">
                    No entries match the current filters.
                </p>
                <div class="flex justify-center mt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={() => {
                            searchTerm = "";
                            selectedAccounts = new Set();
                            selectedTags = new Set();
                        }}>Clear all filters</Button
                    >
                </div>
            </Card.Content>
        </Card.Root>
    {:else if displayEntries.length === 0}
        <Card.Root class="border-x-0 rounded-none shadow-none">
            <Card.Content class="py-8">
                <p class="text-sm text-muted-foreground text-center">
                    No journal entries yet. Create your first entry to start
                    recording transactions.
                </p>
            </Card.Content>
        </Card.Root>
    {:else}
        <Card.Root class="border-x-0 rounded-none shadow-none py-0">
            <div class="relative">
                <div
                    bind:this={scrollEl}
                    class="overflow-y-auto max-h-[calc(100vh-220px)] [&_[data-slot=table-container]]:overflow-visible"
                >
                    <Table.Root class="table-fixed">
                        <Table.Header class="sticky top-0 z-10 bg-background">
                            {#each table.getHeaderGroups() as headerGroup}
                            <Table.Row>
                                {#each headerGroup.headers as header}
                                    {#if header.column.id === "select"}
                                        <Table.Head class="w-10 sm:w-12">
                                            <Checkbox
                                                checked={table.getIsAllPageRowsSelected()}
                                                indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
                                                onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
                                                aria-label="Select all"
                                            />
                                        </Table.Head>
                                    {:else if header.column.id === "date"}
                                        <SortableHeader
                                            active={sort.key === "date"}
                                            direction={sort.direction}
                                            onclick={() => sort.toggle("date")}
                                            class="hidden sm:table-cell sm:w-28"
                                            >Date</SortableHeader
                                        >
                                    {:else if header.column.id === "description"}
                                        <SortableHeader
                                            active={sort.key === "description"}
                                            direction={sort.direction}
                                            onclick={() => sort.toggle("description")}
                                            class="w-full"
                                            >Description</SortableHeader
                                        >
                                    {:else if header.column.id === "amount"}
                                        <SortableHeader
                                            active={sort.key === "amount"}
                                            direction={sort.direction}
                                            onclick={() => sort.toggle("amount")}
                                            class="text-right hidden sm:table-cell sm:w-48">Amount</SortableHeader
                                        >
                                    {/if}
                                {/each}
                            </Table.Row>
                            {/each}
                        </Table.Header>
                        <Table.Body>
                            {#if paddingTop > 0}
                                <tr class="flex sm:table-row"
                                    ><td
                                        class="w-full"
                                        style="height: {paddingTop}px;"
                                        colspan={visibleColCount}
                                    ></td></tr
                                >
                            {/if}
                            {@const rows = table.getRowModel().rows}
                            {#each virtualItems as vItem (vItem.key)}
                                {@const row = rows[vItem.index]}
                                {#if row}
                                {@const [entry, items] = row.original}
                                <Table.Row
                                    class="flex flex-wrap sm:table-row {entry.status === 'voided' ? 'line-through opacity-50' : ''}"
                                    data-state={row.getIsSelected() ? "selected" : undefined}
                                >
                                    {#each row.getVisibleCells() as cell}
                                        {#if cell.column.id === "select"}
                                            <Table.Cell class="order-0 py-2 px-2 sm:w-12">
                                                <Checkbox
                                                    checked={row.getIsSelected()}
                                                    disabled={!row.getCanSelect()}
                                                    onCheckedChange={(v) => row.toggleSelected(!!v)}
                                                    aria-label="Select row"
                                                />
                                            </Table.Cell>
                                        {:else if cell.column.id === "date"}
                                            <Table.Cell class="text-muted-foreground order-1 text-xs sm:text-sm shrink-0 py-2 pr-2 sm:p-2"
                                                >{entry.date}</Table.Cell
                                            >
                                        {:else if cell.column.id === "description"}
                                            <Table.Cell class="order-3 w-full sm:w-auto whitespace-normal sm:whitespace-nowrap pt-0 pb-2 sm:p-2">
                                                <div
                                                    class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0"
                                                >
                                                    <a
                                                        href="/journal/{entry.id}"
                                                        class="font-medium hover:underline truncate"
                                                        title={entry.description}
                                                        >{entry.description}</a
                                                    >
                                                    {#if entryTags.get(entry.id)?.length}
                                                        <TagDisplay
                                                            tags={entryTags.get(
                                                                entry.id,
                                                            )!}
                                                            class="shrink-0"
                                                            onclick={addTagFilter}
                                                        />
                                                    {/if}
                                                    {#if entryLinks.get(entry.id)?.length}
                                                        <LinkDisplay
                                                            links={entryLinks.get(
                                                                entry.id,
                                                            )!}
                                                            class="shrink-0"
                                                            onclick={addLinkFilter}
                                                        />
                                                    {/if}
                                                </div>
                                            </Table.Cell>
                                        {:else if cell.column.id === "amount"}
                                            <Table.Cell class="text-right font-mono order-2 ml-auto py-2 pl-2 sm:p-2 overflow-hidden">
                                                {convertedTotals.get(entry.id) ??
                                                    formatDebitTotal(items)}
                                            </Table.Cell>
                                        {/if}
                                    {/each}
                                </Table.Row>
                                {/if}
                            {/each}
                            {#if paddingBottom > 0}
                                <tr class="flex sm:table-row"
                                    ><td
                                        class="w-full"
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
                        class="absolute bottom-12 right-4 z-20 rounded-full border
                      bg-background/95 px-3 py-1 text-xs text-muted-foreground
                      shadow-sm backdrop-blur-sm"
                    >
                        {positionLabel}
                    </div>
                {/if}

                {#if isScrolledDown}
                    <button
                        type="button"
                        class="absolute bottom-3 right-4 z-20 flex h-8 w-8 items-center
                   justify-center rounded-full border bg-background/95
                   text-muted-foreground shadow-sm backdrop-blur-sm
                   hover:text-foreground"
                        onclick={() =>
                            virtualizer.scrollToOffset(0, {
                                behavior: "smooth",
                            })}
                        title="Back to top"
                    >
                        <ArrowUp class="size-4" />
                    </button>
                {/if}
            </div>
        </Card.Root>

        {#if selectedCount > 0}
            <div class="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-50
                        flex items-center gap-3 rounded-lg border bg-background/95
                        px-4 py-2.5 shadow-lg backdrop-blur-sm">
                <span class="text-sm text-muted-foreground whitespace-nowrap">
                    {selectedCount} {selectedCount === 1 ? "entry" : "entries"} selected
                </span>
                <div class="h-4 w-px bg-border"></div>
                <Button variant="destructive" size="sm" disabled={batchVoiding}
                    onclick={handleBatchVoid}>
                    {#if batchVoiding}<Loader class="size-3.5 mr-1 animate-spin" />Voiding...{:else}Void Selected{/if}
                </Button>
                <Button variant="ghost" size="sm" onclick={clearSelection}>
                    <X class="size-4" />
                </Button>
            </div>
        {/if}

        <div class="flex items-center justify-between">
            <span class="text-sm text-muted-foreground">
                {#if selectedCount > 0}
                    {selectedCount} of {sortedEntries.length} row(s) selected
                {:else if isScrolledDown}
                    {(virtualItems[0]?.index ?? 0) + 1}–{Math.min(
                        (virtualItems[virtualItems.length - 1]?.index ?? 0) + 1,
                        sortedEntries.length,
                    )} of
                {/if}
                {store.totalCount}
                {store.totalCount === 1 ? "entry" : "entries"}
            </span>
        </div>
    {/if}
</div>

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
            <Dialog.Title>Duplicate Detection</Dialog.Title>
            <Dialog.Description>
                Entries with the same date and amounts that may be duplicates.
            </Dialog.Description>
        </Dialog.Header>
        {#if duplicateGroups.length === 0}
            <p class="text-sm text-muted-foreground py-8 text-center">
                No potential duplicates found.
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
                                    ? "Likely duplicate"
                                    : "Possible duplicate"}
                            </Badge>
                            <span class="text-xs text-muted-foreground"
                                >{group.entries.length} entries</span
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
                                    <a
                                        href="/journal/{entry.id}"
                                        class="hover:underline"
                                        >{entry.description}</a
                                    >
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="font-mono text-xs"
                                        >{convertedTotals.get(entry.id) ??
                                            formatDebitTotal(items)}</span
                                    >
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
                                                        "Entry voided",
                                                    );
                                                } catch (e) {
                                                    toast.error(String(e));
                                                }
                                            }}>Void</Button
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
