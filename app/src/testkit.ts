// App-side test helpers (the server suite's namesake is src/testkit.ts).
// The in-app confirm (confirm.tsx) renders real DOM — tests answer it by
// clicking its buttons, the way the operator would.
export function confirmSheet(root: ParentNode): HTMLElement | null {
	return root.querySelector<HTMLElement>('[role="alertdialog"]');
}

export function confirmText(root: ParentNode): string | null {
	return confirmSheet(root)?.querySelector(".confirm-msg")?.textContent ?? null;
}

export function clickConfirm(root: ParentNode, ok: boolean): void {
	const button = confirmSheet(root)?.querySelector<HTMLElement>(
		ok ? ".confirm-ok" : ".confirm-cancel",
	);
	if (button === null || button === undefined) throw new Error("no confirm sheet is open");
	button.click();
}
