/** Yield to the browser macrotask queue so rendering and input events can process.
 *  No-op in non-browser (test) environments. */
const _isBrowser = typeof requestAnimationFrame === "function";
export const yieldToUI = (): Promise<void> =>
  _isBrowser ? new Promise(r => setTimeout(r, 0)) : Promise.resolve();
