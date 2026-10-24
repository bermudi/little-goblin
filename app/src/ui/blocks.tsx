// The ui element renderers — one component per leaf type, plus the
// containers. The input is a flat id→element map; `render(id)` resolves
// children so the tree is walked lazily — the streaming surface swaps
// in a render that skeletons pending ids instead. Every rendered root
// carries ui-<type>. Local state (the open tab, form values — read
// from the DOM at submit, never stored server-side, and the picked
// choice row) lives and dies here; actions are the only way out —
// they post a [ui] message through the composer's own sendMessage,
// never a hidden channel.

import { createContext, Fragment, useContext, useState, type CSSProperties, type ReactNode } from "react";
import type { UIMessage } from "ai";
import type {
	UiElement,
	UiInput,
	UiLeaf,
	UiLeafProps,
} from "../../../src/agent/tools/ui-schema.ts";
import { Markdown, type MarkdownNoteContext } from "../markdown.tsx";
import { Skeleton } from "../tools/bits.tsx";
import { Chart } from "./Chart.tsx";
import { choiceLabels, derivePick } from "./picks.ts";
import { HtmlFrame } from "./HtmlFrame.tsx";

export interface UiActionProps extends MarkdownNoteContext {
	// Sends an ordinary user message ("[ui] …"). Undefined while the
	// part streams — a half-rendered interface is never tappable.
	onAction?: ((text: string) => void) | undefined;
	// A turn is running; actions wait for it.
	busy?: boolean | undefined;
	// Input is still arriving: html never mounts at any depth — a
	// partial srcdoc re-executes its scripts on every delta.
	streaming?: boolean | undefined;
}

// Resolves an element id to rendered output — complete surfaces render
// straight through; the streaming surface wraps it with skeletons for
// pending ids and a visited guard for partial cycles.
export type UiRender = (id: string) => ReactNode;

function actionsOff({ onAction, busy }: UiActionProps): boolean {
	return busy === true || onAction === undefined;
}

// The picked-row highlight (local state tier): a choices tap
// highlights the matching table row
// client-side AND posts [ui] <label> as usual. Cosmetic only — on
// reload Surface re-derives the label from the transcript, so the
// tap remains the single source of record. Context, not props: the
// pick crosses leaf boundaries (Choices → Table) without threading
// every renderer.
const PickContext = createContext<{ picked: string | null; pick: (label: string) => void }>({
	picked: null,
	pick: () => {},
});

function Text({
	leaf,
	...note
}: { leaf: UiLeafProps<"text"> } & MarkdownNoteContext) {
	return (
		<div className="ui-text">
			<Markdown text={leaf.md} {...note} />
		</div>
	);
}

function Callout({
	leaf,
	...note
}: { leaf: UiLeafProps<"callout"> } & MarkdownNoteContext) {
	return (
		<div className={`ui-callout ui-callout-${leaf.tone ?? "info"}`}>
			{leaf.title !== undefined && <div className="ui-callout-title">{leaf.title}</div>}
			<Markdown text={leaf.md} {...note} />
		</div>
	);
}

function Stats({ leaf }: { leaf: UiLeafProps<"stats"> }) {
	return (
		<div className="ui-stats">
			{leaf.items.map((item, i) => (
				<div key={i} className="ui-stat">
					<div className="ui-stat-value">{item.value}</div>
					<div className="ui-stat-label">{item.label}</div>
					{item.note !== undefined && <div className="ui-stat-note">{item.note}</div>}
				</div>
			))}
		</div>
	);
}

function Table({ leaf }: { leaf: UiLeafProps<"table"> }) {
	const { picked } = useContext(PickContext);
	return (
		<div className="ui-table">
			<table className="md-table">
				<thead>
					<tr>
						{leaf.columns.map((c, i) => (
							<th key={i}>{c}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{leaf.rows.map((row, ri) => (
						<tr key={ri} className={picked !== null && row[0] === picked ? "picked" : undefined}>
							{row.map((cell, ci) => (
								<td key={ci}>{cell}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Steps({
	leaf,
	...note
}: { leaf: UiLeafProps<"steps"> } & MarkdownNoteContext) {
	return (
		<ol className="ui-steps">
			{leaf.items.map((item, i) => (
				<li key={i}>
					<div className="ui-step-title">{item.title}</div>
					{item.md !== undefined && (
						<div className="ui-step-md">
							<Markdown text={item.md} {...note} />
						</div>
					)}
				</li>
			))}
		</ol>
	);
}

function Choices({
	leaf,
	onAction,
	busy,
}: { leaf: UiLeafProps<"choices"> } & UiActionProps) {
	const { pick } = useContext(PickContext);
	const disabled = actionsOff({ onAction, busy });
	return (
		<div className="ui-choices">
			{leaf.prompt !== undefined && <div className="ui-choices-prompt">{leaf.prompt}</div>}
			<div className="ui-choice-row">
				{leaf.options.map((o, i) => (
					<button
						key={i}
						type="button"
						className="ui-choice"
						disabled={disabled}
						onClick={() => {
							pick(o.label);
							onAction?.(`[ui] ${o.label}`);
						}}
					>
						{o.label}
					</button>
				))}
			</div>
		</div>
	);
}

function Form({
	leaf,
	onAction,
	busy,
}: { leaf: UiLeafProps<"form"> } & UiActionProps) {
	const disabled = actionsOff({ onAction, busy });
	return (
		<form
			className="ui-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (disabled) return;
				// Uncontrolled inputs: the values live in the DOM until this
				// read, then ride out as one [ui] message. Selects report
				// their shown option — never an invisible empty. Reads
				// form.elements, not FormData: the host may pair this form
				// with a different realm's FormData (tests do).
				const data = e.currentTarget.elements;
				const summary = leaf.fields
					.map((f) => {
						const el = data.namedItem(f.name);
						// Checkbox inputs carry their state in .checked — .value
						// is the inert "on" default. No other form control has
						// type "checkbox" (duck-typed, not instanceof: the host
						// realm may differ from this module's globals).
						const value =
							el !== null && "checked" in el && "type" in el && el.type === "checkbox"
								? String(el.checked)
								: el !== null && "value" in el
									? String(el.value)
									: "";
						return `${f.name}=${value}`;
					})
					.join(", ");
				onAction?.(`[ui] ${leaf.submit}: ${summary}`);
			}}
		>
			{leaf.fields.map((f) => (
				<label
					key={f.name}
					className={f.kind === "checkbox" ? "ui-field ui-field-check" : "ui-field"}
				>
					<span className="ui-field-label">{f.label}</span>
					{f.kind === "select" ? (
						<select className="ui-input" name={f.name}>
							{(f.options ?? []).map((o) => (
								<option key={o} value={o}>
									{o}
								</option>
							))}
						</select>
					) : f.kind === "textarea" ? (
						<textarea className="ui-input" name={f.name} rows={3} />
					) : f.kind === "checkbox" ? (
						<input className="ui-input ui-check" name={f.name} type="checkbox" />
					) : (
						<input
							className="ui-input"
							name={f.name}
							type={f.kind}
							step={f.kind === "number" ? "any" : undefined}
						/>
					)}
				</label>
			))}
			<button type="submit" className="ui-submit" disabled={disabled}>
				{leaf.submit}
			</button>
		</form>
	);
}

// A tab element that hasn't fully arrived may carry no label yet —
// "…" is a placeholder, never emitted on a complete surface.
function tabLabel(el: UiElement | undefined): string {
	return el?.type === "tab" ? el.props.label : "…";
}

function Tabs({
	element,
	elements,
	render,
	onAction,
	busy,
	streaming,
	...note
}: {
	element: Extract<UiElement, { type: "tabs" }>;
	elements: Record<string, UiElement>;
	render: UiRender;
} & UiActionProps) {
	const [active, setActive] = useState(0);
	const ids = element.children;
	const current = Math.min(active, ids.length - 1);
	return (
		<div className="ui-tabs">
			<div className="ui-tab-bar" role="tablist">
				{ids.map((id, i) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={i === current}
						className={i === current ? "ui-tab active" : "ui-tab"}
						onClick={() => setActive(i)}
					>
						{tabLabel(elements[id])}
					</button>
				))}
			</div>
			{/* The active tab is part of the panel's key: leaf indexes alone
			    collide across tabs, and uncontrolled form inputs would carry
			    one tab's DOM values into another's submit. */}
			<div className="ui-tab-panel" role="tabpanel" key={current}>
				{render(ids[current]!)}
			</div>
		</div>
	);
}

function Columns({
	element,
	render,
}: { element: Extract<UiElement, { type: "columns" }>; render: UiRender }) {
	return (
		<div
			className="ui-columns"
			style={{ "--ui-cols": element.children.length } as CSSProperties}
		>
			{element.children.map((id) => (
				<Fragment key={id}>{render(id)}</Fragment>
			))}
		</div>
	);
}

export function Leaf({
	leaf,
	onAction,
	busy,
	streaming,
	...note
}: { leaf: UiLeaf } & UiActionProps) {
	switch (leaf.type) {
		case "text":
			return <Text leaf={leaf.props} streaming={streaming} {...note} />;
		case "callout":
			return <Callout leaf={leaf.props} streaming={streaming} {...note} />;
		case "stats":
			return <Stats leaf={leaf.props} />;
		case "table":
			return <Table leaf={leaf.props} />;
		case "steps":
			return <Steps leaf={leaf.props} streaming={streaming} {...note} />;
		case "chart":
			return <Chart leaf={leaf.props} />;
		case "choices":
			return <Choices leaf={leaf.props} onAction={onAction} busy={busy} />;
		case "form":
			return <Form leaf={leaf.props} onAction={onAction} busy={busy} />;
		case "html":
			return streaming === true ? <Skeleton /> : <HtmlFrame leaf={leaf.props} />;
	}
}

// One element of the map by id. tab/column render their own children —
// their parents consume them (tabs for the bar+panel, columns for the
// grid) — while a stray mid-stream tab/column still shows its content.
export function Node({
	id,
	elements,
	render,
	onAction,
	busy,
	streaming,
	...note
}: {
	id: string;
	elements: Record<string, UiElement>;
	render: UiRender;
} & UiActionProps) {
	const el = elements[id];
	if (el === undefined) return null;
	switch (el.type) {
		case "stack":
			return (
				<div className="ui-stack">
					{el.children.map((c) => (
						<Fragment key={c}>{render(c)}</Fragment>
					))}
				</div>
			);
		case "tabs":
			return (
				<Tabs
					element={el}
					elements={elements}
					render={render}
					onAction={onAction}
					busy={busy}
					streaming={streaming}
					{...note}
				/>
			);
		case "tab":
			return (
				<>
					{el.children.map((c) => (
						<Fragment key={c}>{render(c)}</Fragment>
					))}
				</>
			);
		case "columns":
			return <Columns element={el} render={render} />;
		case "column":
			return (
				<div className="ui-column">
					{el.props?.title !== undefined && (
						<div className="ui-column-title">{el.props.title}</div>
					)}
					{el.children.map((c) => (
						<Fragment key={c}>{render(c)}</Fragment>
					))}
				</div>
			);
		default:
			return (
				<Leaf leaf={el} onAction={onAction} busy={busy} streaming={streaming} {...note} />
			);
	}
}

// One complete interface — the wrapper shared by the finished render
// and (element-by-element) the streaming one.
export function Surface({
	input,
	onAction,
	busy,
	streaming,
	messages,
	...note
}: { input: UiInput; messages?: readonly UIMessage[] | undefined } & UiActionProps) {
	// The tap sets the highlight instantly; the transcript, when wired
	// in, re-derives the same label after a reload — the [ui] message
	// is the only record, and it is already persisted.
	const [tapped, setTapped] = useState<string | null>(null);
	const picked =
		tapped ?? (messages !== undefined ? derivePick(messages, choiceLabels(input)) : null);
	const elements = input.elements;
	const render: UiRender = (id) => (
		<Node
			id={id}
			elements={elements}
			render={render}
			onAction={onAction}
			busy={busy}
			streaming={streaming}
			{...note}
		/>
	);
	return (
		<PickContext.Provider value={{ picked, pick: setTapped }}>
			<div className="ui">
				{input.title !== undefined && <div className="ui-title">{input.title}</div>}
				{(Array.isArray(input.root) ? input.root : [input.root]).map((id) => (
					<Fragment key={id}>{render(id)}</Fragment>
				))}
			</div>
		</PickContext.Provider>
	);
}
