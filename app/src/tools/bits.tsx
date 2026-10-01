// Shared primitives for the tool renderers: the per-tool contract, the
// small icons, and the blocks every expanded row is built from (clips,
// chips, badges, the skeleton). Kept leaf-level — views and the
// dispatcher import from here, never the reverse.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { clipHead } from "./parse.ts";

/** What a view produces for one call: the collapsed-row summary fragment
 *  plus the expanded body. failed marks a refused/errored output — the
 *  summary renders in danger color. */
export interface Face {
	summary: string;
	detail: ReactNode;
	failed?: boolean;
}

/** Per-tool renderer. inputHint feeds running rows off the (possibly
 *  partial) input alone; a null from done hands the part to the generic
 *  renderer — junk payloads degrade, never crash. */
export interface ToolView {
	icon: ReactNode;
	inputHint(input: unknown): string | null;
	done(input: unknown, output: unknown): Face | null;
}

export function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="12"
			height="12"
		>
			{children}
		</svg>
	);
}

export function FileGlyph() {
	return (
		<Icon>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
		</Icon>
	);
}

/** The running-state body: two shimmer bars inside the fold. */
export function Skeleton() {
	return (
		<div className="tool-body">
			<div className="skel skel-a" />
			<div className="skel skel-b" />
		</div>
	);
}

/** Scrollable, height-capped mono block — output tails and previews. */
export function Clip({ text, className }: { text: string; className?: string }) {
	return <pre className={className === undefined ? "tool-clip" : `tool-clip ${className}`}>{text}</pre>;
}

/** The failure renderer — returned {error} refusals and thrown errors. */
export function ErrBox({ text }: { text: string }) {
	return <Clip className="err" text={clipHead(text, 4000)} />;
}

export function CopyBtn({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = () => {
		void navigator.clipboard.writeText(text).catch(() => {});
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1500);
	};
	return (
		<button type="button" className="codeblock-copy" onClick={copy}>
			{copied ? "✓" : "copy"}
		</button>
	);
}

export function PathChip({ path }: { path: string }) {
	return (
		<span className="pathchip">
			<FileGlyph />
			{path}
		</span>
	);
}

/** Diff-count chips — the add hue is always shown, the del only when
 *  lines actually went away (a pure write has no removals). */
export function DiffStat({ adds, dels }: { adds: number; dels: number }) {
	return (
		<span className="diffstat">
			<em className="add">+{adds}</em>
			{dels > 0 && <em className="del">−{dels}</em>}
		</span>
	);
}
