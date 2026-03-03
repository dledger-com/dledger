<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import AppSidebar from "$lib/components/shell/AppSidebar.svelte";
  import TopBar from "$lib/components/shell/TopBar.svelte";
  import BottomTabBar from "$lib/components/shell/BottomTabBar.svelte";

  let { children } = $props();

  const isDesktop = new MediaQuery("(min-width: 768px)");
</script>

{#if isDesktop.current}
  <Sidebar.Provider>
    <AppSidebar />
    <Sidebar.Inset>
      <TopBar showSidebarTrigger={true} />
      <main class="flex-1 flex flex-col overflow-auto p-4">
        {@render children?.()}
      </main>
    </Sidebar.Inset>
  </Sidebar.Provider>
{:else}
  <div class="flex h-screen flex-col">
    <TopBar showSidebarTrigger={false} />
    <main class="flex-1 flex flex-col overflow-auto p-4 pb-20">
      {@render children?.()}
    </main>
    <BottomTabBar />
  </div>
{/if}
