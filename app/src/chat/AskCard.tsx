import { useState } from "react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { closeAsk } from "../api.ts";
import { ToolRun } from "../tools/mod.tsx";
import { useLive, useLiveStore } from "../useLive.tsx";

export function AskCard({
	part,
	onAction,
	busy,
	token,
}: {
	part: ToolUIPart | DynamicToolUIPart;
	onAction?: ((text: string) => void) | undefined;
	busy: boolean;
	token: string | null;
}) {
	const input = part.input as { action?: unknown; question?: unknown; options?: unknown };
	const output = part.state === "output-available" && typeof part.output === "object" && part.output !== null
		? part.output as { id?: unknown }
		: null;
	if (part.state === "input-streaming" || part.state === "input-available") {
		return <div className="ask-card ask-skeleton" aria-hidden="true" />;
	}
	if (part.state === "output-error" || typeof input.question !== "string" || typeof output?.id !== "number") {
		return <ul className="ask-tool-error"><ToolRun part={part} /></ul>;
	}
	const options = Array.isArray(input.options)
		? input.options.filter((option): option is string => typeof option === "string")
		: [];
	return <OperatorQuestionCard id={output.id} question={input.question} options={options} onAction={onAction} busy={busy} token={token} />;
}

export function OperatorQuestionCard({
	id,
	question,
	options,
	onAction,
	busy,
	token,
	label = "Question from Goblin",
	heading,
}: {
	id: number;
	question: string;
	options?: readonly string[];
	onAction?: ((text: string) => void) | undefined;
	busy?: boolean;
	token: string | null;
	label?: string;
	heading?: string;
}) {
	const live = useLive("attention");
	const store = useLiveStore();
	const [error, setError] = useState(false);
	const itemId = `ask:${id}`;
	const isOpen = live.data?.items.some((item) => item.id === itemId) ?? false;
	const known = live.data !== null && live.error === null;
	const close = async (by: "tap" | "dismiss", label?: string) => {
		setError(false);
		if (by === "tap" && label !== undefined) onAction?.(`[ask] ${question} → ${label}`);
		try {
			await closeAsk(token, id, by);
			await store.refresh("attention");
		} catch {
			setError(true);
		}
	};
	return (
		<div className={`ask-card${isOpen ? "" : " closed"}`} role="group" aria-label={label}>
			{heading !== undefined && <strong>{heading}</strong>}
			<div className="ask-question">{question}</div>
			{isOpen ? (
				<>
					{options !== undefined && options.length > 0 && (
						<div className="ui-choice-row">
							{options.map((option) => (
								<button key={option} className="ui-choice" disabled={busy || !known} onClick={() => void close("tap", option)}>
									{option}
								</button>
							))}
						</div>
					)}
					<button className="ask-dismiss" onClick={() => void close("dismiss")}>No answer needed</button>
				</>
			) : known ? (
				<div className="ask-closed">Closed</div>
			) : (
				options !== undefined && options.length > 0 && (
					<div className="ui-choice-row">
						{options.map((option) => <button key={option} className="ui-choice" disabled>{option}</button>)}
					</div>
				)
			)}
			{error && <div className="ask-error" role="alert">Couldn't close the question. Try again.</div>}
		</div>
	);
}
