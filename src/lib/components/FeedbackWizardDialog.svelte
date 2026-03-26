<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import { generateLlmPrompt, type SourceType } from "$lib/feedback/llm-prompts.js";
  import { loadPluginFromCode } from "$lib/feedback/plugin-loader.js";
  import { getSystemInfo } from "$lib/feedback/system-info.js";
  import { saveCustomPlugin } from "$lib/plugins/custom-plugins.js";
  import * as m from "$paraglide/messages.js";
  import Puzzle from "lucide-svelte/icons/puzzle";
  import Bug from "lucide-svelte/icons/bug";
  import MessageSquare from "lucide-svelte/icons/message-square";
  import FileSpreadsheet from "lucide-svelte/icons/file-spreadsheet";
  import ArrowUpDown from "lucide-svelte/icons/arrow-up-down";
  import Blocks from "lucide-svelte/icons/blocks";
  import FileText from "lucide-svelte/icons/file-text";
  import HandHelping from "lucide-svelte/icons/hand-helping";
  import ChevronLeft from "lucide-svelte/icons/chevron-left";
  import Copy from "lucide-svelte/icons/copy";
  import Check from "lucide-svelte/icons/check";
  import CircleCheck from "lucide-svelte/icons/circle-check";
  import GitPullRequest from "lucide-svelte/icons/git-pull-request";
  import Mail from "lucide-svelte/icons/mail";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import TriangleAlert from "lucide-svelte/icons/triangle-alert";
  import Info from "lucide-svelte/icons/info";

  const GITHUB_REPO = "https://github.com/dledger-com/dledger";
  const CONTACT_EMAIL = "feedback@dledger.org";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  type WizardStep = "choose" | "source-type" | "llm-guide" | "load-plugin" | "contribute" | "bug-report" | "general" | "done";

  let step = $state<WizardStep>("choose");
  let sourceType = $state<SourceType>("csv");
  let pluginCode = $state("");
  let loadError = $state("");
  let loadedPluginName = $state("");
  let sourceUrl = $state("");
  let promptCopied = $state(false);
  let infoCopied = $state(false);
  // Save source code for persistence after successful load
  let lastLoadedSourceCode = $state("");

  const dialogClass = $derived(
    step === "llm-guide" ? "sm:max-w-2xl" : "sm:max-w-lg",
  );

  function reset() {
    step = "choose";
    sourceType = "csv";
    sourceUrl = "";
    pluginCode = "";
    loadError = "";
    loadedPluginName = "";
    promptCopied = false;
    infoCopied = false;
    lastLoadedSourceCode = "";
  }

  $effect(() => {
    if (open) reset();
  });

  function goBack() {
    switch (step) {
      case "source-type": step = "choose"; break;
      case "llm-guide": step = "source-type"; break;
      case "load-plugin": step = "llm-guide"; break;
      case "contribute": step = "load-plugin"; break;
      case "bug-report": step = "choose"; break;
      case "general": step = "choose"; break;
      default: break;
    }
  }

  async function copyToClipboard(text: string, which: "prompt" | "info") {
    await navigator.clipboard.writeText(text);
    if (which === "prompt") {
      promptCopied = true;
      setTimeout(() => { promptCopied = false; }, 2000);
    } else {
      infoCopied = true;
      setTimeout(() => { infoCopied = false; }, 2000);
    }
  }

  async function handleLoadPlugin() {
    loadError = "";
    const result = loadPluginFromCode(pluginCode);
    if (!result.success) {
      loadError = result.error ?? "Unknown error";
      return;
    }

    loadedPluginName = result.plugin!.name;
    lastLoadedSourceCode = pluginCode;

    // Persist to database
    try {
      const backend = getBackend();
      await saveCustomPlugin(backend, result.plugin!, pluginCode);
    } catch (e) {
      console.warn("Failed to persist custom plugin:", e);
    }

    toast.success(m.feedback_load_success({ name: loadedPluginName }));
    step = "contribute";
  }

  function sourceTypeLabel(type: SourceType): string {
    switch (type) {
      case "csv": return m.feedback_source_csv();
      case "cex": return m.feedback_source_cex();
      case "defi": return m.feedback_source_defi();
      case "pdf": return m.feedback_source_pdf();
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class={dialogClass}>
    <!-- Step: Choose -->
    {#if step === "choose"}
      <Dialog.Header>
        <Dialog.Title>{m.feedback_title()}</Dialog.Title>
        <Dialog.Description>{m.feedback_desc()}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-2">
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted cursor-pointer"
          onclick={() => { step = "source-type"; }}
        >
          <Puzzle class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p class="text-sm font-medium">{m.feedback_missing_source()}</p>
            <p class="text-xs text-muted-foreground">{m.feedback_missing_source_desc()}</p>
          </div>
        </button>

        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted cursor-pointer"
          onclick={() => { step = "bug-report"; }}
        >
          <Bug class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p class="text-sm font-medium">{m.feedback_bug()}</p>
            <p class="text-xs text-muted-foreground">{m.feedback_bug_desc()}</p>
          </div>
        </button>

        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted cursor-pointer"
          onclick={() => { step = "general"; }}
        >
          <MessageSquare class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p class="text-sm font-medium">{m.feedback_general()}</p>
            <p class="text-xs text-muted-foreground">{m.feedback_general_desc()}</p>
          </div>
        </button>
      </div>

    <!-- Step: Source Type -->
    {:else if step === "source-type"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_source_type_title()}</Dialog.Title>
        </div>
      </Dialog.Header>

      <div class="space-y-4">
        <!-- DIY with LLM section -->
        <div class="space-y-2">
          <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{m.feedback_source_diy_label()}</p>
          {#each [
            { type: "csv" as SourceType, icon: FileSpreadsheet, name: m.feedback_source_csv(), desc: m.feedback_source_csv_desc(), difficulty: m.feedback_difficulty_easy() },
            { type: "pdf" as SourceType, icon: FileText, name: m.feedback_source_pdf(), desc: m.feedback_source_pdf_desc(), difficulty: m.feedback_difficulty_advanced() },
            { type: "cex" as SourceType, icon: ArrowUpDown, name: m.feedback_source_cex(), desc: m.feedback_source_cex_desc(), difficulty: m.feedback_difficulty_moderate() },
            { type: "defi" as SourceType, icon: Blocks, name: m.feedback_source_defi(), desc: m.feedback_source_defi_desc(), difficulty: m.feedback_difficulty_moderate() },
          ] as item (item.type)}
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted cursor-pointer"
              onclick={() => { sourceType = item.type; step = "llm-guide"; }}
            >
              <item.icon class="h-5 w-5 shrink-0 text-muted-foreground" />
              <div class="flex-1">
                <p class="text-sm font-medium">{item.name}</p>
                <p class="text-xs text-muted-foreground">{item.desc}</p>
              </div>
              <Badge variant="secondary" class="shrink-0">{item.difficulty}</Badge>
            </button>
          {/each}
        </div>

        <!-- Divider -->
        <div class="flex items-center gap-3">
          <div class="h-px flex-1 bg-border"></div>
          <span class="text-xs text-muted-foreground">{m.feedback_source_or_label()}</span>
          <div class="h-px flex-1 bg-border"></div>
        </div>

        <!-- Human help section -->
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted cursor-pointer"
          onclick={() => { step = "bug-report"; }}
        >
          <HandHelping class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div class="flex-1">
            <p class="text-sm font-medium">{m.feedback_source_human()}</p>
            <p class="text-xs text-muted-foreground">{m.feedback_source_human_desc()}</p>
          </div>
        </button>
      </div>

    <!-- Step: LLM Guide -->
    {:else if step === "llm-guide"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_llm_title({ type: sourceTypeLabel(sourceType) })}</Dialog.Title>
        </div>
        <Dialog.Description>{sourceType === "csv" || sourceType === "pdf" ? m.feedback_llm_desc_file() : m.feedback_llm_desc_api()}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-4">
        <!-- URL input for API-based types -->
        {#if sourceType === "cex" || sourceType === "defi"}
          <div class="space-y-1">
            <label for="source-url" class="text-sm font-medium">
              {sourceType === "cex" ? m.feedback_source_cex() : m.feedback_source_defi()} URL
            </label>
            <Input
              id="source-url"
              type="url"
              placeholder="https://..."
              bind:value={sourceUrl}
            />
          </div>
        {/if}

        <!-- Prompt block -->
        <div class="relative">
          <div class="rounded-lg bg-muted p-4 pr-12 font-mono text-xs max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {generateLlmPrompt(sourceType, sourceUrl || undefined)}
          </div>
          <button
            type="button"
            class="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors"
            onclick={() => copyToClipboard(generateLlmPrompt(sourceType, sourceUrl || undefined), "prompt")}
          >
            {#if promptCopied}
              <Check class="h-4 w-4 text-green-500" />
            {:else}
              <Copy class="h-4 w-4" />
            {/if}
          </button>
        </div>

        <!-- What's included -->
        <div>
          <p class="text-xs font-medium text-muted-foreground">{m.feedback_llm_whats_included()}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            {m.feedback_llm_whats_included_desc()}
          </p>
        </div>
      </div>

      <Dialog.Footer>
        <div class="flex w-full flex-col gap-2 sm:flex-row sm:justify-between">
          <div class="flex gap-2">
            <Button variant="outline" size="sm" href="https://chatgpt.com" target="_blank" rel="noopener noreferrer">
              ChatGPT <ExternalLink class="ml-1 h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" href="https://claude.ai" target="_blank" rel="noopener noreferrer">
              Claude <ExternalLink class="ml-1 h-3 w-3" />
            </Button>
          </div>
          <Button onclick={() => { step = "load-plugin"; }}>
            {m.feedback_llm_have_code()}
          </Button>
        </div>
      </Dialog.Footer>

    <!-- Step: Load Plugin -->
    {:else if step === "load-plugin"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_load_title()}</Dialog.Title>
        </div>
        <Dialog.Description>{m.feedback_load_desc()}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-4">
        <!-- Warning -->
        <div class="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
          <TriangleAlert class="h-4 w-4 shrink-0 text-yellow-500 mt-0.5" />
          <p class="text-xs text-yellow-700 dark:text-yellow-400">{m.feedback_load_warning()}</p>
        </div>

        <!-- Code textarea -->
        <textarea
          class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          placeholder="// Paste your plugin code here..."
          bind:value={pluginCode}
        ></textarea>

        <!-- Error -->
        {#if loadError}
          <div class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <Info class="h-4 w-4 shrink-0 text-destructive mt-0.5" />
            <p class="text-xs text-destructive">{m.feedback_load_error({ error: loadError })}</p>
          </div>
        {/if}
      </div>

      <Dialog.Footer>
        <Button
          disabled={!pluginCode.trim()}
          onclick={handleLoadPlugin}
        >
          {m.feedback_load_validate()}
        </Button>
      </Dialog.Footer>

    <!-- Step: Contribute -->
    {:else if step === "contribute"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_contribute_title()}</Dialog.Title>
        </div>
        <Dialog.Description>{m.feedback_contribute_desc()}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-2">
        <a
          href="{GITHUB_REPO}/issues/new?title=New+plugin:+{encodeURIComponent(loadedPluginName)}&body=Plugin+code+attached"
          target="_blank"
          rel="noopener noreferrer"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
        >
          <GitPullRequest class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div class="flex-1">
            <p class="text-sm font-medium">{m.feedback_contribute_pr()}</p>
          </div>
          <ExternalLink class="h-4 w-4 text-muted-foreground" />
        </a>

        <a
          href="mailto:{CONTACT_EMAIL}?subject={encodeURIComponent('dLedger plugin: ' + loadedPluginName)}"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
        >
          <Mail class="h-5 w-5 shrink-0 text-muted-foreground" />
          <div class="flex-1">
            <p class="text-sm font-medium">{m.feedback_contribute_email()}</p>
          </div>
          <ExternalLink class="h-4 w-4 text-muted-foreground" />
        </a>
      </div>

      <Dialog.Footer>
        <Button variant="ghost" onclick={() => { step = "done"; }}>
          {m.feedback_skip()}
        </Button>
      </Dialog.Footer>

    <!-- Step: Bug Report -->
    {:else if step === "bug-report"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_bug_title()}</Dialog.Title>
        </div>
        <Dialog.Description>{m.feedback_bug_desc()}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-4">
        <!-- System info -->
        <div>
          <p class="text-sm font-medium mb-2">{m.feedback_bug_system_info()}</p>
          <div class="relative">
            <div class="rounded-lg bg-muted p-3 pr-10 font-mono text-xs whitespace-pre-wrap">
              {getSystemInfo()}
            </div>
            <button
              type="button"
              class="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors"
              onclick={() => copyToClipboard(getSystemInfo(), "info")}
            >
              {#if infoCopied}
                <Check class="h-4 w-4 text-green-500" />
              {:else}
                <Copy class="h-4 w-4" />
              {/if}
            </button>
          </div>
        </div>

        <!-- Actions -->
        <div class="space-y-2">
          <a
            href="{GITHUB_REPO}/issues/new?labels=bug"
            target="_blank"
            rel="noopener noreferrer"
            class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
          >
            <ExternalLink class="h-5 w-5 shrink-0 text-muted-foreground" />
            <p class="text-sm font-medium">{m.feedback_bug_github()}</p>
          </a>

          <a
            href="mailto:{CONTACT_EMAIL}?subject={encodeURIComponent('dLedger bug report')}&body={encodeURIComponent(getSystemInfo())}"
            class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
          >
            <Mail class="h-5 w-5 shrink-0 text-muted-foreground" />
            <p class="text-sm font-medium">{m.feedback_bug_email()}</p>
          </a>
        </div>
      </div>

    <!-- Step: General Feedback -->
    {:else if step === "general"}
      <Dialog.Header>
        <div class="flex items-center gap-2">
          <button type="button" class="text-muted-foreground hover:text-foreground transition-colors" onclick={goBack}>
            <ChevronLeft class="h-4 w-4" />
          </button>
          <Dialog.Title>{m.feedback_general_title()}</Dialog.Title>
        </div>
      </Dialog.Header>

      <div class="space-y-2">
        <a
          href="{GITHUB_REPO}/discussions"
          target="_blank"
          rel="noopener noreferrer"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
        >
          <ExternalLink class="h-5 w-5 shrink-0 text-muted-foreground" />
          <p class="text-sm font-medium">{m.feedback_general_github()}</p>
        </a>

        <a
          href="mailto:{CONTACT_EMAIL}?subject={encodeURIComponent('dLedger feedback')}"
          class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
        >
          <Mail class="h-5 w-5 shrink-0 text-muted-foreground" />
          <p class="text-sm font-medium">{m.feedback_general_email()}</p>
        </a>
      </div>

    <!-- Step: Done -->
    {:else if step === "done"}
      <div class="flex flex-col items-center gap-4 py-8">
        <div class="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
          <CircleCheck class="h-8 w-8 text-green-500" />
        </div>
        <div class="text-center">
          <h3 class="text-lg font-semibold">{m.feedback_done_title()}</h3>
          <p class="text-sm text-muted-foreground mt-1">{m.feedback_done_desc()}</p>
        </div>
        <Button onclick={() => { open = false; }}>{m.feedback_close()}</Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
