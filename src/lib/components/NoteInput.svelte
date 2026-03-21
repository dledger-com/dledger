<script lang="ts">
  let { note, onchange, class: className }: { note: string; onchange: (note: string) => void; class?: string } = $props();

  let editing = $state(false);
  let draft = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function startEditing() {
    draft = note;
    editing = true;
    setTimeout(() => textareaEl?.focus(), 0);
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
      rows="3"
      class="w-full rounded border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus:border-primary resize-y"
      onblur={save}
      onkeydown={handleKeydown}
    ></textarea>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="text-xs cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50 min-h-[1.75rem] {note ? '' : 'text-muted-foreground italic'}"
      onclick={startEditing}
    >
      {note || "Add a note..."}
    </div>
  {/if}
</div>
