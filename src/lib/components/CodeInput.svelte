<script lang="ts">
  import { untrack } from "svelte";

  let {
    value = $bindable(""),
    placeholder = "// Paste your plugin code here...",
    minHeight = "300px",
  }: {
    value: string;
    placeholder?: string;
    minHeight?: string;
  } = $props();

  let highlightedHtml = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let preEl: HTMLElement | undefined = $state();

  // Debounced syntax highlighting
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const code = value;
    clearTimeout(timer);
    if (!code.trim()) {
      untrack(() => { highlightedHtml = ""; });
      return;
    }
    timer = setTimeout(() => {
      import("shiki/bundle/web").then(({ codeToHtml }) => {
        const isDark = document.documentElement.classList.contains("dark");
        codeToHtml(code, {
          lang: "javascript",
          theme: isDark ? "github-dark" : "github-light",
        }).then((html) => {
          highlightedHtml = html;
        });
      });
    }, 300);
  });

  function syncScroll() {
    if (preEl && textareaEl) {
      preEl.scrollTop = textareaEl.scrollTop;
      preEl.scrollLeft = textareaEl.scrollLeft;
    }
  }
</script>

<div class="relative rounded-md border border-input ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2" style:min-height={minHeight}>
  <!-- Highlighted overlay -->
  <div
    bind:this={preEl}
    class="absolute inset-0 overflow-hidden pointer-events-none rounded-md
      [&_pre]:!m-0 [&_pre]:!px-3 [&_pre]:!py-2 [&_pre]:!bg-transparent
      [&_code]:!text-sm [&_code]:!leading-[1.625] [&_code]:!font-mono
      [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_pre]:!overflow-hidden"
    aria-hidden="true"
  >
    {#if highlightedHtml}
      {@html highlightedHtml}
    {/if}
  </div>
  <!-- Transparent textarea for input -->
  <textarea
    bind:this={textareaEl}
    bind:value
    {placeholder}
    class="relative w-full bg-transparent resize-y rounded-md px-3 py-2 text-sm font-mono leading-[1.625]
      placeholder:text-muted-foreground focus-visible:outline-none
      {highlightedHtml ? 'text-transparent caret-foreground' : ''}"
    style:min-height={minHeight}
    oninput={syncScroll}
    onscroll={syncScroll}
    spellcheck={false}
    autocomplete="off"
    data-gramm="false"
  ></textarea>
</div>
