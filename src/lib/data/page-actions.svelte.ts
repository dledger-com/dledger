export interface PageActionButton {
	type: 'button';
	label: string;
	href?: string;
	onclick?: () => void;
	variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';
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
	_actions = actions;
}

export function clearTopBarActions() {
	_actions = [];
}

export function getTopBarActions(): PageAction[] {
	return _actions;
}
