import type { ReactNode } from "react";
import type { Page } from "./routing.ts";

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

// The C gutter (design/app.md → mobile-nav ruling — the desktop half of
// the prototypes at design/prototypes/sidebar/c-gutter.html): a 52px
// glyph spine where every surface is one click away, and a 216px panel
// that lists exactly one surface at a time — chats by default, search
// as a mode. Glyph names live on the buttons' aria-labels, not in text.
export function G({ children, size = 17 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			width={size}
			height={size}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export type ListPane = "chats" | "projects" | "notes";

// The three panes that own a list — order and icons from the prototype.
export const LIST_GLYPHS: { key: ListPane; label: string; svg: ReactNode }[] = [
	{
		key: "chats",
		label: "Chats",
		svg: (
			<G>
				<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6z" />
			</G>
		),
	},
	{
		key: "projects",
		label: "Projects",
		svg: (
			<G>
				<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
			</G>
		),
	},
	{
		key: "notes",
		label: "Notes",
		svg: (
			<G>
				<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5v-15z" />
				<path d="M9 3v18" />
			</G>
		),
	},
];

// The system surfaces — spine order from the prototype, Settings docked
// at the foot (rendered separately, after the spacer).
export const OPS_GLYPHS: {
	key: Exclude<Page, "chat" | "notes" | "note" | "projects" | "project" | "window">;
	label: string;
	svg: ReactNode;
}[] = [
	{
		key: "attention",
		label: "Attention",
		svg: (
			<G>
				<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
				<path d="M10 19a2.2 2.2 0 0 0 4 0" />
			</G>
		),
	},
	{
		key: "delegations",
		label: "Delegations",
		svg: (
			<G>
				<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
				<path d="M12 3v11" />
				<path d="M8 10l4 4 4-4" />
			</G>
		),
	},
	{
		key: "memory",
		label: "Memories",
		svg: (
			<G>
				<path d="M12 3l9 5-9 5-9-5 9-5z" />
				<path d="M3 13.5l9 5 9-5" />
			</G>
		),
	},
	{
		key: "programs",
		label: "Programs",
		svg: (
			<G>
				<circle cx="12" cy="12" r="8.5" />
				<path d="M10 8.5l6 3.5-6 3.5v-7z" />
			</G>
		),
	},
	{
		key: "skills",
		label: "Skills",
		svg: (
			<G>
				<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13L13 2z" />
			</G>
		),
	},
	{
		key: "files",
		label: "Files",
		svg: (
			<G>
				<path d="M6 3h8l4 4v14H6V3z" />
				<path d="M14 3v4h4" />
			</G>
		),
	},
	{
		key: "status",
		label: "Status",
		svg: (
			<G>
				<path d="M3 12h4l2.5-6 4 12L16 12h5" />
			</G>
		),
	},
	{
		key: "log",
		label: "Log",
		svg: (
			<G>
				<rect x="3" y="4" width="18" height="16" rx="3" />
				<path d="M7 9l3 3-3 3" />
				<path d="M13 15h4" />
			</G>
		),
	},
];
