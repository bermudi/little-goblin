import type { ReactNode } from "react";

export function LoopGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="15"
			height="15"
			aria-hidden="true"
		>
			<path d="M17 2l4 4-4 4" />
			<path d="M3 11V9a3 3 0 0 1 3-3h15" />
			<path d="M7 22l-4-4 4-4" />
			<path d="M21 13v2a3 3 0 0 1-3 3H3" />
		</svg>
	);
}

export function PinGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="10"
			height="10"
			className="conv-pin"
			aria-hidden="true"
		>
			<path d="M9 3h6l2 8H7l2-8z" />
			<line x1="12" y1="11" x2="12" y2="21" />
		</svg>
	);
}

// Icon-only buttons carry aria-label + title — the tests assert on the
// accessible name, not visible text.
function ActionGlyph({ children }: { children: ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="12"
			height="12"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}
export const PinActionGlyph = () => (
	<ActionGlyph>
		<path d="M9 3h6l2 8H7l2-8z" />
		<line x1="12" y1="11" x2="12" y2="21" />
	</ActionGlyph>
);
export const UnpinGlyph = () => (
	<ActionGlyph>
		<path d="M9 3h6l2 8H7l2-8z" />
		<line x1="12" y1="11" x2="12" y2="21" />
		<line x1="5" y1="5" x2="19" y2="19" />
	</ActionGlyph>
);
export const PencilGlyph = () => (
	<ActionGlyph>
		<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
	</ActionGlyph>
);
export const ArchiveGlyph = () => (
	<ActionGlyph>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="M10 12h4" />
	</ActionGlyph>
);
export const UnarchiveGlyph = () => (
	<ActionGlyph>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="m9 15 3-3 3 3" />
		<path d="M12 12v7" />
	</ActionGlyph>
);
export const TrashGlyph = () => (
	<ActionGlyph>
		<path d="M3 6h18" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</ActionGlyph>
);


export function ChevronDownGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="14"
			height="14"
			aria-hidden="true"
		>
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}
