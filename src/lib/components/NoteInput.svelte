<script lang="ts">
  import { renderMarkdown } from "$lib/utils/markdown";

  let { note, onchange, class: className }: { note: string; onchange: (note: string) => void; class?: string } = $props();

  let editing = $state(false);
  let draft = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function startEditing() {
    draft = note;
    editing = true;
    setTimeout(() => {
      if (textareaEl) {
        textareaEl.focus();
        autoResize(textareaEl);
      }
    }, 0);
  }

  function save() {
    const trimmed = draft.trim();
    if (trimmed !== note) {
      onchange(trimmed);
    }
    editing = false;
  }

  function cancel() {
    editing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div class={className}>
  {#if editing}
    <textarea
      bind:this={textareaEl}
      bind:value={draft}
      class="w-full rounded border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus:border-primary resize-none min-h-[3lh] max-h-[12lh] overflow-y-auto"
      onblur={save}
      onkeydown={handleKeydown}
      oninput={(e) => autoResize(e.currentTarget)}
    ></textarea>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="text-xs cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50 min-h-[1.75rem] {note ? 'prose prose-xs dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0' : 'text-muted-foreground italic'}"
      onclick={startEditing}
    >
      {#if note}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderMarkdown(note)}
      {:else}
        Add a note...
      {/if}
    </div>
  {/if}
</div>
