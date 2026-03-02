import {
  type VirtualizerOptions,
  type Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer as VirtualizerClass,
} from "@tanstack/virtual-core";

type Options = VirtualizerOptions<HTMLElement, Element>;

export function createVirtualizer(opts: () => Omit<Options, "observeElementOffset" | "observeElementRect" | "scrollToFn">) {
  let virtualItems = $state<ReturnType<Virtualizer<HTMLElement, Element>["getVirtualItems"]>>([]);
  let totalSize = $state(0);

  const instance = new VirtualizerClass<HTMLElement, Element>({
    ...opts(),
    observeElementOffset,
    observeElementRect,
    scrollToFn: elementScroll,
    onChange: (inst) => {
      inst._willUpdate();
      virtualItems = inst.getVirtualItems();
      totalSize = inst.getTotalSize();
    },
  });

  $effect(() => {
    instance._didMount();
    return () => instance._willUpdate();
  });

  $effect(() => {
    const current = opts();
    instance.setOptions({
      ...current,
      observeElementOffset,
      observeElementRect,
      scrollToFn: elementScroll,
      onChange: (inst) => {
        inst._willUpdate();
        virtualItems = inst.getVirtualItems();
        totalSize = inst.getTotalSize();
      },
    });
    instance.measure();
  });

  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === "getVirtualItems") return () => virtualItems;
      if (prop === "getTotalSize") return () => totalSize;
      return Reflect.get(target, prop, receiver);
    },
  });
}
