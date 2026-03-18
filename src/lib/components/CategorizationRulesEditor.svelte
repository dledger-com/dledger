<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { v7 as uuidv7 } from "uuid";
  import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
  import TagInput from "./TagInput.svelte";
  import { tagColor } from "$lib/utils/tags.js";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import GripVertical from "lucide-svelte/icons/grip-vertical";
  import Plus from "lucide-svelte/icons/plus";

  let {
    rules,
    onchange,
    collapsible = true,
    maxHeight = "max-h-40",
  }: {
    rules: CsvCategorizationRule[];
    onchange: (rules: CsvCategorizationRule[]) => void;
    collapsible?: boolean;
    maxHeight?: string;
  } = $props();

  let showRules = $state(!collapsible);
  let newPattern = $state("");
  let newAccount = $state("");
  let newRuleTags = $state<string[]>([]);
  let dragIdx = $state<number | null>(null);
  let dropIdx = $state<number | null>(null);

  function addRule() {
    if (!newPattern.trim() || !newAccount.trim()) return;
    const rule: CsvCategorizationRule = { id: uuidv7(), pattern: newPattern.trim(), account: newAccount.trim() };
    if (newRuleTags.length > 0) rule.tags = [...newRuleTags];
    onchange([...rules, rule]);
    newPattern = "";
    newAccount = "";
    newRuleTags = [];
  }

  function removeRule(id: string) {
    onchange(rules.filter((r) => r.id !== id));
  }

  function moveRule(from: number, to: number) {
    if (from === to) return;
    const updated = [...rules];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    onchange(updated);
  }
</script>

<div class="rounded-md border p-4 space-y-3">
  {#if collapsible}
    <div class="flex items-center justify-between">
      <h4 class="text-sm font-semibold">Categorization Rules</h4>
      <Button size="sm" variant="ghost" onclick={() => { showRules = !showRules; }}>
        {showRules ? "Hide" : "Show"} ({rules.length} rules)
      </Button>
    </div>
  {/if}
  {#if showRules}
    <p class="text-xs text-muted-foreground">
      Match keywords in descriptions to auto-assign counterparty accounts. First match wins.
    </p>
    {#if rules.length > 0}
      <div class="space-y-0 {maxHeight} overflow-y-auto">
        {#each rules as rule, index}
          <div
            role="listitem"
            class="flex items-center gap-2 text-sm py-1 {dragIdx === index ? 'opacity-50' : ''}"
            style={dropIdx === index ? "border-top: 2px solid hsl(var(--primary))" : ""}
            draggable="true"
            ondragstart={(e) => {
              dragIdx = index;
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
              }
            }}
            ondragover={(e) => {
              e.preventDefault();
              dropIdx = index;
            }}
            ondragleave={() => {
              if (dropIdx === index) dropIdx = null;
            }}
            ondrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null) moveRule(dragIdx, index);
              dragIdx = null;
              dropIdx = null;
            }}
            ondragend={() => {
              dragIdx = null;
              dropIdx = null;
            }}
          >
            <GripVertical class="h-3 w-3 text-muted-foreground cursor-grab shrink-0" />
            <Badge variant="outline" class="font-mono">{rule.pattern}</Badge>
            <span class="text-muted-foreground">&rarr;</span>
            <span class="font-mono text-xs">{rule.account}</span>
            {#if rule.tags && rule.tags.length > 0}
              {#each rule.tags as tag}
                <Badge variant="outline" class={tagColor(tag) + " border-transparent text-[10px] px-1 py-0"}>{tag}</Badge>
              {/each}
            {/if}
            <Button
              size="sm"
              variant="ghost"
              class="h-6 w-6 p-0 ml-auto"
              onclick={() => removeRule(rule.id)}
            >
              <Trash2 class="h-3 w-3" />
            </Button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex gap-2">
      <Input bind:value={newPattern} placeholder="Keyword (e.g. coffee)" class="flex-1 h-8 text-sm" />
      <Input bind:value={newAccount} placeholder="Account (e.g. Expenses:Coffee)" class="flex-1 h-8 text-sm" />
      <Button size="sm" class="h-8" onclick={addRule} disabled={!newPattern.trim() || !newAccount.trim()}>
        <Plus class="h-3 w-3 mr-1" /> Add
      </Button>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-xs text-muted-foreground shrink-0">Rule tags:</span>
      <TagInput tags={newRuleTags} onchange={(t) => { newRuleTags = t; }} class="flex-1" />
    </div>
  {/if}
</div>
