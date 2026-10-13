// The ui block renderers — one component per leaf type, plus the two
// containers (design/app.md → Intelligent UI). Every rendered root
// carries ui-<type>. Local state (the open tab, form values — read
// from the DOM at submit, never stored server-side, and the picked
// choice row) lives and dies here; actions are the only way out —
// they post a [ui] message through the composer's own sendMessage,
// never a hidden channel.

import { createContext, useContext, useState, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import type { UiBlock, UiLeaf, UiInput } from "../../../src/agent/tools/ui-schema.ts";
import { Markdown } from "../markdown.tsx";
import { Skeleton } from "../tools/bits.tsx";
import { Chart } from "./Chart.tsx";
import { choiceLabels, derivePick } from "./picks.ts";
import { HtmlFrame } from "./HtmlFrame.tsx";

export interface UiActionProps {
	// Sends an ordinary user message ("[ui] …"). Undefined while the
	// part streams — a half-rendered interface is never tappable.
	onAction?: ((text: string) => void) | undefined;
	// A turn is running; actions wait for it.
	busy?: boolean | undefined;
	// Input is still arriving: html never mounts at any depth — a
	// partial srcdoc re-executes its scripts on every delta.
	streaming?: boolean | undefined;
}

function actionsOff({ onAction, busy }: UiActionProps): boolean {
	return busy === true || onAction === undefined;
}

// The picked-row highlight (design/app.md → Intelligent UI, local
// state tier): a choices tap highlights the matching table row
// client-side AND posts [ui] <label> as usual. Cosmetic only — on
// reload Surface re-derives the label from the transcript, so the
// tap remains the single source of record. Context, not props: the
// pick crosses leaf boundaries (Choices → Table) without threading
// every renderer.
const PickContext = createContext<{ picked: string | null; pick: (label: string) => void }>({
	picked: null,
	pick: () => {},
});

function Text({ leaf }: { leaf: Extract<UiLeaf, { type: "text" }> }) {
	return (
		<div className="ui-text">
			<Markdown text={leaf.md} />
		</div>
	);
}

function Callout({ leaf }: { leaf: Extract<UiLeaf, { type: "callout" }> }) {
	return (
		<div className={`ui-callout ui-callout-${leaf.tone ?? "info"}`}>
			{leaf.title !== undefined && <div className="ui-callout-title">{leaf.title}</div>}
			<Markdown text={leaf.md} />
		</div>
	);
}

function Stats({ leaf }: { leaf: Extract<UiLeaf, { type: "stats" }> }) {
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

function Table({ leaf }: { leaf: Extract<UiLeaf, { type: "table" }> }) {
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

function Steps({ leaf }: { leaf: Extract<UiLeaf, { type: "steps" }> }) {
	return (
		<ol className="ui-steps">
			{leaf.items.map((item, i) => (
				<li key={i}>
					<div className="ui-step-title">{item.title}</div>
					{item.md !== undefined && (
						<div className="ui-step-md">
							<Markdown text={item.md} />
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
}: { leaf: Extract<UiLeaf, { type: "choices" }> } & UiActionProps) {
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
}: { leaf: Extract<UiLeaf, { type: "form" }> } & UiActionProps) {
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

function Tabs({
	block,
	onAction,
	busy,
	streaming,
}: { block: Extract<UiBlock, { type: "tabs" }> } & UiActionProps) {
	const [active, setActive] = useState(0);
	const tab = block.tabs[Math.min(active, block.tabs.length - 1)]!;
	return (
		<div className="ui-tabs">
			<div className="ui-tab-bar" role="tablist">
				{block.tabs.map((t, i) => (
					<button
						key={i}
						type="button"
						role="tab"
						aria-selected={i === active}
						className={i === active ? "ui-tab active" : "ui-tab"}
						onClick={() => setActive(i)}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="ui-tab-panel" role="tabpanel">
				{tab.blocks.map((leaf, i) => (
					<Leaf key={i} leaf={leaf} onAction={onAction} busy={busy} streaming={streaming} />
				))}
			</div>
		</div>
	);
}

function Columns({
	block,
	onAction,
	busy,
	streaming,
}: { block: Extract<UiBlock, { type: "columns" }> } & UiActionProps) {
	return (
		<div className="ui-columns" style={{ "--ui-cols": block.columns.length } as CSSProperties}>
			{block.columns.map((col, i) => (
				<div key={i} className="ui-column">
					{col.title !== undefined && <div className="ui-column-title">{col.title}</div>}
					{col.blocks.map((leaf, j) => (
						<Leaf key={j} leaf={leaf} onAction={onAction} busy={busy} streaming={streaming} />
					))}
				</div>
			))}
		</div>
	);
}

export function Leaf({ leaf, onAction, busy, streaming }: { leaf: UiLeaf } & UiActionProps) {
	switch (leaf.type) {
		case "text":
			return <Text leaf={leaf} />;
		case "callout":
			return <Callout leaf={leaf} />;
		case "stats":
			return <Stats leaf={leaf} />;
		case "table":
			return <Table leaf={leaf} />;
		case "steps":
			return <Steps leaf={leaf} />;
		case "chart":
			return <Chart leaf={leaf} />;
		case "choices":
			return <Choices leaf={leaf} onAction={onAction} busy={busy} />;
		case "form":
			return <Form leaf={leaf} onAction={onAction} busy={busy} />;
		case "html":
			return streaming === true ? <Skeleton /> : <HtmlFrame leaf={leaf} />;
	}
}

export function Block({ block, onAction, busy, streaming }: { block: UiBlock } & UiActionProps) {
	if (block.type === "tabs")
		return <Tabs block={block} onAction={onAction} busy={busy} streaming={streaming} />;
	if (block.type === "columns")
		return <Columns block={block} onAction={onAction} busy={busy} streaming={streaming} />;
	return <Leaf leaf={block} onAction={onAction} busy={busy} streaming={streaming} />;
}

// One complete interface — the wrapper shared by the finished render
// and (block-by-block) the streaming one.
export function Surface({
	input,
	onAction,
	busy,
	streaming,
	messages,
}: { input: UiInput; messages?: readonly UIMessage[] | undefined } & UiActionProps) {
	// The tap sets the highlight instantly; the transcript, when wired
	// in, re-derives the same label after a reload — the [ui] message
	// is the only record, and it is already persisted.
	const [tapped, setTapped] = useState<string | null>(null);
	const picked =
		tapped ?? (messages !== undefined ? derivePick(messages, choiceLabels(input.blocks)) : null);
	return (
		<PickContext.Provider value={{ picked, pick: setTapped }}>
			<div className="ui">
				{input.title !== undefined && <div className="ui-title">{input.title}</div>}
				{input.blocks.map((block, i) => (
					<Block key={i} block={block} onAction={onAction} busy={busy} streaming={streaming} />
				))}
			</div>
		</PickContext.Provider>
	);
}
