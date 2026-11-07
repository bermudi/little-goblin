// The note editor's formatting row. Buttons keep the editor's
// selection (mousedown never takes focus); active state follows the
// selection; every tooltip names its shortcut.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BlockKind, FormatAction, FormatState } from "./noteFormat.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const ALT = isMac ? "⌥" : "Alt+";
const SHIFT = isMac ? "⇧" : "Shift+";

const icon = (d: ReactNode): ReactNode => (
	<svg
		viewBox="0 0 16 16"
		width="15"
		height="15"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		{d}
	</svg>
);

interface Tool {
	id: string;
	label: string;
	shortcut: string | null;
	face: ReactNode;
	action: FormatAction;
	active?: (f: FormatState) => boolean;
	disabled?: (f: FormatState) => boolean;
}

const GROUPS: Tool[][] = [
	[
		{ id: "strong", label: "Bold", shortcut: `${MOD}B`, face: <b>B</b>, action: { kind: "strong" }, active: (f) => f.strong },
		{ id: "emphasis", label: "Italic", shortcut: `${MOD}I`, face: <i>I</i>, action: { kind: "emphasis" }, active: (f) => f.emphasis },
		{ id: "strike", label: "Strikethrough", shortcut: `${MOD}${ALT}X`, face: <s>S</s>, action: { kind: "strike" }, active: (f) => f.strike },
		{
			id: "code",
			label: "Inline code",
			shortcut: `${MOD}E`,
			face: icon(<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />),
			action: { kind: "code" },
			active: (f) => f.code,
		},
	],
	[
		{
			id: "bullet",
			label: "Bulleted list",
			shortcut: `${MOD}${ALT}8`,
			face: icon(<path d="M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />),
			action: { kind: "bullet" },
			active: (f) => f.bullet,
		},
		{
			id: "ordered",
			label: "Numbered list",
			shortcut: `${MOD}${ALT}7`,
			face: icon(<path d="M7 4h7M7 8h7M7 12h7M2 3.2l1-.7v3M2 9.5c.2-.6 1.6-.7 1.6.1 0 .7-1.6 1.1-1.6 1.9h1.8" />),
			action: { kind: "ordered" },
			active: (f) => f.ordered,
		},
		{
			id: "task",
			label: "Task list",
			shortcut: null,
			face: icon(<path d="M2 3.5h4v4H2zM3 5.5l.8.8L5 4.8M8.5 5.5H14M2 10.5h4v4H2zM8.5 12.5H14" />),
			action: { kind: "task" },
			active: (f) => f.task,
		},
		{
			id: "quote",
			label: "Quote",
			shortcut: `${MOD}${SHIFT}B`,
			face: icon(<path d="M3 3v10M7 5h7M7 8h7M7 11h5" />),
			action: { kind: "quote" },
			active: (f) => f.quote,
		},
		{
			id: "codeblock",
			label: "Code block",
			shortcut: `${MOD}${ALT}C`,
			face: icon(<path d="M2 3h12v10H2zM6 6.5 4.5 8 6 9.5M10 6.5 11.5 8 10 9.5" />),
			action: { kind: "codeblock" },
			active: (f) => f.block === "code",
		},
		{
			id: "hr",
			label: "Horizontal rule",
			shortcut: null,
			face: icon(<path d="M2 8h12" />),
			action: { kind: "hr" },
		},
	],
	[
		{
			id: "undo",
			label: "Undo",
			shortcut: `${MOD}Z`,
			face: icon(<path d="M5 3 2 6l3 3M2.5 6H10a4 4 0 0 1 0 8H7" />),
			action: { kind: "undo" },
			disabled: (f) => !f.canUndo,
		},
		{
			id: "redo",
			label: "Redo",
			shortcut: `${MOD}${SHIFT}Z`,
			face: icon(<path d="m11 3 3 3-3 3M13.5 6H6a4 4 0 0 0 0 8h3" />),
			action: { kind: "redo" },
			disabled: (f) => !f.canRedo,
		},
	],
];

const BLOCKS: { value: BlockKind; label: string; shortcut: string; action: FormatAction }[] = [
	{ value: "paragraph", label: "Paragraph", shortcut: `${MOD}${ALT}0`, action: { kind: "block", to: "paragraph" } },
	{ value: "h1", label: "Heading 1", shortcut: `${MOD}${ALT}1`, action: { kind: "block", to: 1 } },
	{ value: "h2", label: "Heading 2", shortcut: `${MOD}${ALT}2`, action: { kind: "block", to: 2 } },
	{ value: "h3", label: "Heading 3", shortcut: `${MOD}${ALT}3`, action: { kind: "block", to: 3 } },
];

const linkFace = icon(<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />);

export default function NoteToolbar({
	fmt,
	disabled,
	linkOpen,
	onLinkOpen,
	onAction,
}: {
	fmt: FormatState;
	disabled: boolean;
	linkOpen: boolean;
	onLinkOpen: (open: boolean) => void;
	onAction: (a: FormatAction) => void;
}) {
	const [href, setHref] = useState("");
	const hrefRef = useRef<HTMLInputElement>(null);
	// Seed the field from the link under the cursor when the row opens.
	useEffect(() => {
		if (!linkOpen) return;
		setHref(fmt.link ?? "");
		hrefRef.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [linkOpen]);

	// Mousedown on a button must not move focus out of the editor.
	const keepFocus = (e: React.MouseEvent) => e.preventDefault();
	const currentBlock = BLOCKS.some((b) => b.value === fmt.block) ? fmt.block : "paragraph";

	function applyLink(): void {
		const v = href.trim();
		if (v === "") return;
		onAction({ kind: "link", href: v });
		onLinkOpen(false);
	}

	return (
		<div className="note-fmt" role="toolbar" aria-label="Formatting">
			<div className="note-fmt-row">
				<select
					className="note-fmt-block"
					aria-label="Text style"
					title="Text style — pick Paragraph to turn a heading back into plain text"
					value={currentBlock}
					disabled={disabled}
					onChange={(e) => {
						const b = BLOCKS.find((x) => x.value === e.target.value);
						if (b) onAction(b.action);
					}}
				>
					{BLOCKS.map((b) => (
						<option key={b.value} value={b.value}>
							{b.label}
						</option>
					))}
					{fmt.block === "code" && <option value="code" disabled>Code block</option>}
					{fmt.block === "h4" || fmt.block === "h5" || fmt.block === "h6" ? (
						<option value={fmt.block} disabled>
							Heading {fmt.block.slice(1)}
						</option>
					) : null}
				</select>
				{GROUPS.map((group, gi) => (
					<span className="note-fmt-group" key={gi} role="group">
						{group.map((t) => (
							<button
								key={t.id}
								type="button"
								className={`note-fmt-btn${t.active?.(fmt) ? " on" : ""}`}
								data-tool={t.id}
								aria-label={t.label}
								aria-pressed={t.active ? t.active(fmt) : undefined}
								title={t.shortcut === null ? t.label : `${t.label} (${t.shortcut})`}
								disabled={disabled || (t.disabled?.(fmt) ?? false)}
								onMouseDown={keepFocus}
								onClick={() => onAction(t.action)}
							>
								{t.face}
							</button>
						))}
						{gi === 0 && (
							<button
								type="button"
								className={`note-fmt-btn${fmt.link !== null ? " on" : ""}`}
								data-tool="link"
								aria-label="Link"
								aria-pressed={fmt.link !== null}
								aria-expanded={linkOpen}
								title={`Link (${MOD}K)`}
								disabled={disabled}
								onMouseDown={keepFocus}
								onClick={() => onLinkOpen(!linkOpen)}
							>
								{linkFace}
							</button>
						)}
					</span>
				))}
			</div>
			{linkOpen && (
				<form
					className="note-fmt-link"
					onSubmit={(e) => {
						e.preventDefault();
						applyLink();
					}}
				>
					<input
						ref={hrefRef}
						type="url"
						inputMode="url"
						aria-label="Link address"
						placeholder="https://…"
						value={href}
						onChange={(e) => setHref(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") onLinkOpen(false);
						}}
					/>
					<button type="submit" className="ghost-inline" disabled={href.trim() === ""}>
						{fmt.link !== null ? "Update" : "Apply"}
					</button>
					{fmt.link !== null && (
						<button
							type="button"
							className="ghost-inline"
							onClick={() => {
								onAction({ kind: "link", href: null });
								onLinkOpen(false);
							}}
						>
							Remove link
						</button>
					)}
					<button type="button" className="ghost-inline" onClick={() => onLinkOpen(false)}>
						Cancel
					</button>
				</form>
			)}
		</div>
	);
}
