export interface PageActionButton {
	type: 'button';
	label: string;
	href?: string;
	onclick?: () => void;
	variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';
	/** Disable the button */
	disabled?: boolean;
	/** Show as a floating action button on mobile instead of in the TopBar */
	fab?: boolean;
	/** Icon component to render inside the FAB (lucide-svelte icon or similar) */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fabIcon?: any;
}

export interface MenuItem {
	label: string;
	onclick?: () => void;
	disabled?: boolean;
	separator?: boolean;
	header?: boolean;
}

export interface PageActionMenu {
	type: 'menu';
	items: MenuItem[];
}

export type PageAction = PageActionButton | PageActionMenu;

let _actions = $state<PageAction[]>([]);

export function setTopBarActions(actions: PageAction[]) {
	if (JSON.stringify(_actions) === JSON.stringify(actions)) return;
	_actions = actions;
}

export function clearTopBarActions() {
	_actions = [];
}

export function getTopBarActions(): PageAction[] {
	return _actions;
}
