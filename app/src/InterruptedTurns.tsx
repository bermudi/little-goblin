import { useCallback, useEffect, useRef, useState } from "react";
import type { AppDecideRequest, AppInterruptedRun, AppRunCall } from "../../src/http/app-wire.ts";
import { ApiError, decideRunCall, listInterruptedRuns, resumeRun } from "./api.ts";

const STATE_LABEL: Record<AppRunCall["state"], string> = {
	planned: "planned",
	dispatched: "uncertain",
	completed: "completed",
	failed: "failed",
	"resolved-done": "recorded",
	"resolved-retry": "retry authorized",
	"resolved-skip": "skipped",
};

const DECISIONS: { decision: AppDecideRequest["decision"]; label: string }[] = [
	{ decision: "record-result", label: "Record result" },
	{ decision: "authorize-retry", label: "Authorize retry" },
	{ decision: "skip", label: "Skip" },
];

const noteKey = (runId: string, callId: string): string => JSON.stringify([runId, callId]);

function argsText(args: unknown): string {
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args, null, 2) ?? String(args);
	} catch {
		return String(args);
	}
}

function errText(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

export function InterruptedTurns({
	token,
	conversationId,
	busy,
	onResumed,
}: {
	token: string | null;
	conversationId: string;
	busy: boolean;
	onResumed: () => Promise<void>;
}) {
	const [runs, setRuns] = useState<AppInterruptedRun[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [resumeWarning, setResumeWarning] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const context = useRef(0);
	const fetchGen = useRef(0);
	const inFlight = useRef(false);
	const acknowledged = useRef(new Set<string>());

	const refresh = useCallback(async () => {
		const ctx = context.current;
		const gen = ++fetchGen.current;
		try {
			const data = await listInterruptedRuns(token, conversationId);
			if (ctx !== context.current || gen !== fetchGen.current) return;
			setRuns(data.runs);
			setLoadError(null);
		} catch (err) {
			if (ctx !== context.current || gen !== fetchGen.current) return;
			setLoadError(errText(err, "failed to load"));
		}
	}, [token, conversationId]);

	useEffect(() => {
		context.current += 1;
		fetchGen.current += 1;
		inFlight.current = false;
		acknowledged.current.clear();
		setRuns(null);
		setNotes({});
		setPending(null);
		setLoadError(null);
		setActionError(null);
		setResumeWarning(null);
		void refresh();
		return () => {
			context.current += 1;
			fetchGen.current += 1;
		};
	}, [refresh]);

	const wasBusy = useRef(busy);
	useEffect(() => {
		const settled = wasBusy.current && !busy;
		wasBusy.current = busy;
		if (settled) void refresh();
	}, [busy, refresh]);

	const decide = async (
		runId: string,
		call: AppRunCall,
		decision: AppDecideRequest["decision"],
	) => {
		if (busy || inFlight.current) return;
		const ctx = context.current;
		inFlight.current = true;
		setPending(`${runId}:${call.toolCallId}:${decision}`);
		setActionError(null);
		try {
			const key = noteKey(runId, call.toolCallId);
			const note = notes[key];
			const body: AppDecideRequest =
				note !== undefined && note !== ""
					? { callId: call.toolCallId, decision, note }
					: { callId: call.toolCallId, decision };
			await decideRunCall(token, conversationId, runId, body);
			if (ctx !== context.current) return;
			setNotes((prev) => ({ ...prev, [key]: "" }));
			await refresh();
		} catch (err) {
			if (ctx !== context.current) return;
			if (err instanceof ApiError && err.status === 409) {
				await refresh();
				if (ctx !== context.current) return;
			}
			setActionError(errText(err, "decision failed"));
		} finally {
			if (ctx === context.current) {
				inFlight.current = false;
				setPending(null);
			}
		}
	};

	const resume = async (runId: string) => {
		if (busy || inFlight.current) return;
		const ctx = context.current;
		inFlight.current = true;
		setPending(`resume:${runId}`);
		setActionError(null);
		setResumeWarning(null);
		try {
			try {
				await resumeRun(token, conversationId, runId);
			} catch (err) {
				if (ctx === context.current) {
					if (err instanceof ApiError && err.status === 409) {
						await refresh();
					}
					if (ctx === context.current) {
						setActionError(errText(err, "resume failed"));
					}
				}
				return;
			}
			if (ctx !== context.current) return;
			acknowledged.current.add(runId);
			setRuns((prev) => (prev === null ? prev : prev.filter((r) => r.runId !== runId)));
			try {
				await onResumed();
			} catch (err) {
				if (ctx === context.current) {
					setResumeWarning(
						`Resume was accepted and the turn is running — reconnecting to it failed: ${errText(err, "unknown error")}. Reload the conversation to follow it.`,
					);
				}
			}
		} finally {
			if (ctx === context.current) {
				inFlight.current = false;
				setPending(null);
			}
		}
	};

	const visible = (runs ?? []).filter((r) => !acknowledged.current.has(r.runId));
	if (
		loadError === null &&
		actionError === null &&
		resumeWarning === null &&
		visible.length === 0
	) {
		return null;
	}

	return (
		<section className="interrupted">
			<div className="interrupted-title">Interrupted turn</div>
			{loadError === null && visible.length > 0 && (
				<p className="interrupted-warn">
					Tool effects may already have happened. Check each uncertain call before resuming.
				</p>
			)}
			{loadError !== null && (
				<div className="error" role="alert">
					Interrupted turns failed to load: {loadError}
					<button type="button" className="interrupted-retry" onClick={() => void refresh()}>
						Retry
					</button>
				</div>
			)}
			{actionError !== null && (
				<div className="error" role="alert">
					{actionError}
				</div>
			)}
			{resumeWarning !== null && (
				<div className="error" role="alert">
					{resumeWarning}
				</div>
			)}
			{visible.map((run) => {
				const undecided = run.toolCalls.filter((c) => c.state === "dispatched");
				return (
					<div className="interrupted-run" key={run.runId}>
						<div className="interrupted-run-head">
							<span className="interrupted-run-id">run {run.runId.slice(0, 8)}</span>
							<span className="interrupted-run-time">
								{new Date(run.startedMs).toLocaleString()}
							</span>
						</div>
						{run.toolCalls.map((call) => (
							<div className="interrupted-call" key={call.toolCallId}>
								<div className="interrupted-call-head">
									<code>{call.name}</code>
									<span className="interrupted-call-state">{STATE_LABEL[call.state]}</span>
								</div>
								<details className="interrupted-args">
									<summary>Arguments</summary>
									<p className="interrupted-note interrupted-args-note">
										journal preview — long inputs are truncated
									</p>
									<pre>{argsText(call.args)}</pre>
								</details>
								{call.result !== null && (
									<details className="interrupted-args">
										<summary>Recorded result</summary>
										<pre>{call.result}</pre>
									</details>
								)}
								{call.error !== null && <div className="interrupted-err">{call.error}</div>}
								{call.resolutionNote !== null && (
									<div className="interrupted-note">decision note: {call.resolutionNote}</div>
								)}
								{call.state !== "dispatched" && call.canAuthorizeRetry && (
									<div className="interrupted-actions">
										<button
											type="button"
											disabled={busy || pending !== null}
											onClick={() => void decide(run.runId, call, "authorize-retry")}
										>
											Authorize another execution
										</button>
									</div>
								)}
								{call.state === "dispatched" && (
									<div className="interrupted-decide">
										<label className="interrupted-note-label">
											Note / asserted result (optional)
											<textarea
												maxLength={4000}
												value={notes[noteKey(run.runId, call.toolCallId)] ?? ""}
												disabled={busy || pending !== null}
												onChange={(e) =>
													setNotes((prev) => ({
														...prev,
														[noteKey(run.runId, call.toolCallId)]: e.target.value,
													}))
												}
											/>
										</label>
										<div className="interrupted-actions">
											{DECISIONS.map((d) => (
												<button
													key={d.decision}
													type="button"
													disabled={busy || pending !== null}
													onClick={() => void decide(run.runId, call, d.decision)}
												>
													{d.label}
												</button>
											))}
										</div>
									</div>
								)}
							</div>
						))}
						<button
							type="button"
							className="interrupted-resume"
							disabled={undecided.length > 0 || busy || pending !== null}
							onClick={() => void resume(run.runId)}
						>
							Resume turn
						</button>
						{undecided.length > 0 && (
							<p className="interrupted-help">
								Resume stays locked until every uncertain call has a decision. Record result asserts
								an outcome you already know happened; Authorize retry re-runs the call and its
								effects may repeat; Skip declines it so it never runs.
							</p>
						)}
					</div>
				);
			})}
		</section>
	);
}
