/**
 * Svelte 5 rune-based sort state. Must be in .svelte.ts for $state support.
 */
export { type SortDirection, type SortState, type SortAccessor, sortItems, parseCurrencyForSort } from "./sort.js";
import type { SortDirection, SortState } from "./sort.js";

/**
 * Creates a Svelte 5 rune-based sort state.
 * Cycling: null → asc → desc → null.
 */
export function createSortState<K extends string>(): SortState<K> {
	let key = $state<K | null>(null);
	let direction = $state<SortDirection | null>(null);

	return {
		get key() {
			return key;
		},
		get direction() {
			return direction;
		},
		toggle(k: K) {
			if (key !== k) {
				key = k;
				direction = "asc";
			} else if (direction === "asc") {
				direction = "desc";
			} else {
				key = null;
				direction = null;
			}
		},
		reset() {
			key = null;
			direction = null;
		}
	};
}
