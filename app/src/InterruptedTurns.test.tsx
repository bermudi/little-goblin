import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppInterruptedList, AppInterruptedRun, AppRunCall } from "../../src/http/app-wire.ts";
import { canAuthorizeRetry } from "../../src/turn/retry-guard.ts";
import { InterruptedTurns } from "./InterruptedTurns.tsx";

function mountDom() {
	const dom = {
		win: undefined as unknown as Window,
		container: undefined as unknown as HTMLElement,
		root: null as Root | null,
		realFetch: globalThis.fetch,
	};
	const installed: string[] = [];
	const install = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};
	beforeEach(() => {
		dom.realFetch = globalThis.fetch;
		dom.win = new Window();
		const div = dom.win.document.createElement("div");
		dom.win.document.body.appendChild(div);
		dom.container = div as unknown as HTMLElement;
		installed.length = 0;
		install("window", dom.win);
		install("document", dom.win.document);
		install("navigator", dom.win.navigator);
		install("Event", dom.win.Event);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});
	afterEach(async () => {
		if (dom.root !== null) {
			await act(async () => {
				dom.root?.unmount();
			});
			dom.root = null;
		}
		await dom.win.happyDOM.close();
		globalThis.fetch = dom.realFetch;
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed.length = 0;
	});
	return dom;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const call = (
	id: string,
	state: AppRunCall["state"],
	extra: Partial<AppRunCall> = {},
): AppRunCall => ({
	toolCallId: id,
	canAuthorizeRetry: canAuthorizeRetry({ state, replayed: false }),
	name: "probe",
	args: { q: 1 },
	state,
	result: null,
	error: null,
	resolutionNote: null,
	resolvedMs: null,
	...extra,
});

const run = (id: string, toolCalls: AppRunCall[]): AppInterruptedRun => ({
	runId: id,
	resumedFrom: null,
	startedMs: Date.parse("2026-10-17T01:00:00Z"),
	finishedMs: Date.parse("2026-10-17T01:00:05Z"),
	calls: {
		planned: 0,
		dispatched: toolCalls.filter((c) => c.state === "dispatched").length,
		completed: toolCalls.filter((c) => c.state === "completed").length,
		failed: toolCalls.filter((c) => c.state === "failed").length,
		resolved: toolCalls.filter((c) => c.state.startsWith("resolved-")).length,
	},
	toolCalls,
});

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface Props {
	token?: string | null;
	conversationId?: string;
	busy?: boolean;
	onResumed?: () => Promise<void>;
}

describe("InterruptedTurns", () => {
	const dom = mountDom();
	let requests: Request[];
	let onRequest: (req: Request) => Response | Promise<Response>;

	const byPath = (suffix: string) =>
		requests.filter((r) => new URL(r.url).pathname.endsWith(suffix));
	const decides = () => byPath("/decide");
	const resumes = () => byPath("/resume");
	const listsFor = (conv: string) =>
		requests.filter(
			(r) =>
				new URL(r.url).pathname === `/api/app/conversations/${conv}/interrupted` &&
				r.method === "GET",
		);

	beforeEach(() => {
		requests = [];
		onRequest = () => json({ error: "unhandled" }, 500);
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const req = new Request(new URL(url, "http://localhost"), init);
			requests.push(req);
			return onRequest(req);
		}) as typeof fetch;
	});

	const render = async (props: Props = {}) => {
		if (dom.root === null) dom.root = createRoot(dom.container);
		const el = (
			<InterruptedTurns
				token={props.token ?? null}
				conversationId={props.conversationId ?? "app/chat-01"}
				busy={props.busy ?? false}
				onResumed={props.onResumed ?? (() => Promise.resolve())}
			/>
		);
		await act(async () => {
			dom.root?.render(el);
		});
	};

	const flush = async () => act(async () => {});
	const click = async (el: Element | null) =>
		act(async () => {
			el?.dispatchEvent(new dom.win.Event("click", { bubbles: true }) as unknown as Event);
		});
	const button = (label: string) =>
		[...dom.container.querySelectorAll("button")].find((b) => b.textContent === label) as
			| HTMLButtonElement
			| undefined;
	const typeNote = async (ta: Element, value: string) => {
		await act(async () => {
			(ta as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(dom.win.HTMLTextAreaElement.prototype, "value")!.set!.call(
				ta,
				value,
			);
			ta.dispatchEvent(new dom.win.Event("input", { bubbles: true }) as unknown as Event);
			ta.dispatchEvent(
				new dom.win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
	};

	test("a dispatched call shows the three decisions; settled calls are read-only", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [
						run("run-deadbeef", [
							call("c1", "dispatched"),
							call("c2", "completed", { result: '{"ok":true}' }),
							call("c3", "resolved-skip", { resolutionNote: "no" }),
						]),
					],
				});
			return json({ error: "unhandled" }, 500);
		};
		await render();
		const text = dom.container.textContent!;
		expect(text).toContain("Interrupted turn");
		expect(text).toContain("Tool effects may already have happened");
		expect(text).toContain("uncertain");
		expect(text).toContain("Recorded result");
		expect(text).toContain("decision note: no");
		expect(text).toContain("Arguments");
		const labels = [...dom.container.querySelectorAll("button")].map((b) => b.textContent);
		expect(labels).toEqual(
			expect.arrayContaining(["Record result", "Authorize retry", "Skip", "Resume turn"]),
		);
		const ta = dom.container.querySelector("textarea")!;
		expect(ta.getAttribute("maxlength")).toBe("4000");
		expect(dom.container.querySelectorAll(".interrupted-decide")).toHaveLength(1);
		expect(button("Resume turn")!.disabled).toBe(true);
	});

	test("each decision posts its payload and the refetched state shows resolved", async () => {
		const calls = [call("c1", "dispatched"), call("c2", "dispatched"), call("c3", "dispatched")];
		const resolved: Record<string, string> = {};
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [
						run(
							"run-deadbeef",
							calls.map((c) =>
								resolved[c.toolCallId] !== undefined
									? call(c.toolCallId, resolved[c.toolCallId] as AppRunCall["state"])
									: c,
							),
						),
					],
				});
			if (path.endsWith("/decide")) return json({ ok: true });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		const seq: [string, string, string][] = [
			["Record result", "c1", "resolved-done"],
			["Authorize retry", "c2", "resolved-retry"],
			["Skip", "c3", "resolved-skip"],
		];
		for (const [label, callId, state] of seq) {
			resolved[callId] = state;
			const first = dom.container.querySelector(".interrupted-decide")!;
			await click([...first.querySelectorAll("button")].find((b) => b.textContent === label)!);
			await flush();
		}
		expect(decides()).toHaveLength(3);
		expect(await decides()[0]!.json()).toEqual({ callId: "c1", decision: "record-result" });
		expect(await decides()[1]!.json()).toEqual({ callId: "c2", decision: "authorize-retry" });
		expect(await decides()[2]!.json()).toEqual({ callId: "c3", decision: "skip" });
		const text = dom.container.textContent!;
		expect(text).toContain("recorded");
		expect(text).toContain("retry authorized");
		expect(text).toContain("skipped");
		expect(dom.container.querySelectorAll(".interrupted-decide")).toHaveLength(0);
		expect(button("Resume turn")!.disabled).toBe(false);
	});

	test("a known call's 'Authorize another execution' posts the same authorize-retry decision", async () => {
		// Settled calls keep their recorded outcome — the button grants
		// one more execution, identical wire shape to the uncertain path.
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [
						run("run-deadbeef", [
							call("c-done", "completed", { result: '{"out":"landed"}' }),
							call("c-fail", "failed", { error: "blew up" }),
							call("c-plan", "planned"),
						]),
					],
				});
			if (path.endsWith("/decide")) return json({ ok: true });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		expect(button("Authorize another execution")).toBeDefined();
		await click(button("Authorize another execution")!);
		await flush();
		expect(decides()).toHaveLength(1);
		expect(await decides()[0]!.json()).toEqual({
			callId: "c-done",
			decision: "authorize-retry",
		});
	});

	test("the note rides record-result verbatim — whitespace preserved, empty omitted", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			if (path.endsWith("/decide")) return json({ ok: true });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		const verbatim = "  output:\n  line one\n  line two  ";
		await typeNote(dom.container.querySelector("textarea")!, verbatim);
		await click(button("Record result")!);
		await flush();
		expect(await decides().at(-1)!.json()).toEqual({
			callId: "c1",
			decision: "record-result",
			note: verbatim,
		});
		await typeNote(dom.container.querySelector("textarea")!, "");
		await click(button("Skip")!);
		await flush();
		expect(await decides().at(-1)!.json()).toEqual({ callId: "c1", decision: "skip" });
	});

	test("notes are scoped per run — same callId in two runs stays independent", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [
						run("run-aaaa0000", [call("c1", "dispatched")]),
						run("run-bbbb1111", [call("c1", "dispatched")]),
					],
				});
			if (path.endsWith("/decide")) return json({ ok: true });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		const tas = dom.container.querySelectorAll("textarea");
		expect(tas).toHaveLength(2);
		await typeNote(tas[0]!, "note for run A");
		expect((tas[1] as HTMLTextAreaElement).value).toBe("");
		const firstRun = dom.container.querySelectorAll(".interrupted-run")[0]!;
		await click(
			[...firstRun.querySelectorAll(".interrupted-actions button")].find(
				(b) => b.textContent === "Record result",
			)!,
		);
		await flush();
		expect(await decides().at(-1)!.json()).toEqual({
			callId: "c1",
			decision: "record-result",
			note: "note for run A",
		});
	});

	test("a rapid double click fires one mutation", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			if (path.endsWith("/decide")) return json({ ok: true });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		const btn = button("Skip")!;
		await act(async () => {
			btn.dispatchEvent(new dom.win.Event("click", { bubbles: true }) as unknown as Event);
			btn.dispatchEvent(new dom.win.Event("click", { bubbles: true }) as unknown as Event);
		});
		await flush();
		expect(decides()).toHaveLength(1);
	});

	test("resume posts once, drops the source locally, and invokes onResumed", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return json({ resumed: true, runId: "run-deadbeef" });
			return json({ error: "unhandled" }, 500);
		};
		let resumed = 0;
		await render({
			onResumed: async () => {
				resumed++;
			},
		});
		const resumeBtn = button("Resume turn")!;
		await click(resumeBtn);
		await flush();
		expect(resumes()).toHaveLength(1);
		expect(resumed).toBe(1);
		expect(dom.container.querySelector(".interrupted-run")).toBeNull();
		expect(button("Resume turn")).toBeUndefined();
	});

	test("accepted resume + failed reconnect keeps a visible warning after the last row drops", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return json({ resumed: true, runId: "run-deadbeef" });
			return json({ error: "unhandled" }, 500);
		};
		await render({
			onResumed: () => Promise.reject(new Error("stream attach blew up")),
		});
		await click(button("Resume turn")!);
		await flush();
		await flush();
		expect(resumes()).toHaveLength(1);
		expect(dom.container.textContent).toContain("Resume was accepted");
		expect(dom.container.textContent).toContain("stream attach blew up");
		expect(button("Resume turn")).toBeUndefined();
	});

	test("a list failure shows the error with a working retry", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted")) return json({ error: "journal exploded" }, 503);
			return json({ error: "unhandled" }, 500);
		};
		await render();
		expect(dom.container.textContent).toContain("journal exploded");
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			return json({ error: "unhandled" }, 500);
		};
		await click(dom.container.querySelector(".interrupted-retry"));
		await flush();
		expect(dom.container.textContent).toContain("uncertain");
	});

	test("a malformed list response fails loud — visible error, not an empty screen", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted")) return json({ runs: "not-an-array" });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		expect(dom.container.textContent).toContain("invalid interrupted-turn list response");
		expect(dom.container.querySelector(".interrupted-retry")).not.toBeNull();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [run("run-deadbeef", [{ ...call("c1", "dispatched"), state: "bogus" as never }])],
				});
			return json({ error: "unhandled" }, 500);
		};
		await click(dom.container.querySelector(".interrupted-retry"));
		await flush();
		expect(dom.container.textContent).toContain("invalid interrupted-turn list response");
	});

	test("a malformed decide ack is an error — note stays, nothing mutates", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			if (path.endsWith("/decide")) return json({ ok: false });
			return json({ error: "unhandled" }, 500);
		};
		await render();
		await typeNote(dom.container.querySelector("textarea")!, "keep me");
		await click(button("Record result")!);
		await flush();
		expect(dom.container.textContent).toContain("invalid decide response");
		expect((dom.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("keep me");
	});

	test("a malformed resume ack is an error — run stays, onResumed never fires", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return json({ unexpected: true });
			return json({ error: "unhandled" }, 500);
		};
		let resumed = 0;
		await render({
			onResumed: async () => {
				resumed++;
			},
		});
		await click(button("Resume turn")!);
		await flush();
		expect(resumed).toBe(0);
		expect(dom.container.textContent).toContain("invalid resume response");
		expect(dom.container.querySelector(".interrupted-run")).not.toBeNull();
	});

	test("a 409 decision shows the reason and refetches; a 422 resume refusal shows verbatim", async () => {
		let decided = false;
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [run("run-deadbeef", [call("c1", decided ? "resolved-skip" : "dispatched")])],
				});
			if (path.endsWith("/decide")) {
				decided = true;
				return json({ error: "call c1 is already 'resolved-skip'" }, 409);
			}
			return json({ error: "unhandled" }, 500);
		};
		await render();
		await click(button("Skip")!);
		await flush();
		await flush();
		expect(dom.container.textContent).toContain("already 'resolved-skip'");
		expect(dom.container.querySelector(".interrupted-decide")).toBeNull();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume"))
				return json({ error: "the recorded tool surface is unreadable — not resumed" }, 422);
			return json({ error: "unhandled" }, 500);
		};
		await click(dom.container.querySelector(".interrupted-retry") ?? button("Resume turn")!);
		await flush();
		await click(button("Resume turn")!);
		await flush();
		expect(dom.container.textContent).toContain(
			"the recorded tool surface is unreadable — not resumed",
		);
	});

	test("busy disables the decision controls and resume", async () => {
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			return json({ error: "unhandled" }, 500);
		};
		await render({ busy: true });
		for (const b of dom.container.querySelectorAll("button")) {
			expect((b as HTMLButtonElement).disabled).toBe(true);
		}
		expect(dom.container.querySelector("textarea")!.disabled).toBe(true);
	});

	test("a stale list from a previous conversation never lands", async () => {
		const first = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/api/app/conversations/chat-01/interrupted") return first.promise;
			if (path === "/api/app/conversations/chat-02/interrupted")
				return json({ runs: [run("run-b", [call("c2", "dispatched")])] });
			return json({ error: "unhandled" }, 500);
		};
		await render({ conversationId: "app/chat-01" });
		await render({ conversationId: "app/chat-02" });
		await flush();
		expect(dom.container.textContent).toContain("run-b".slice(0, 8));
		await act(async () => {
			first.resolve(json({ runs: [run("run-a", [call("c1", "dispatched")])] }));
		});
		await flush();
		expect(dom.container.textContent).not.toContain("run-a".slice(0, 8));
		expect(dom.container.textContent).toContain("run-b".slice(0, 8));
	});

	test("an in-flight decision fenced by navigation never refetches or touches new state", async () => {
		const heldDecide = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/api/app/conversations/chat-01/interrupted")
				return json({ runs: [run("run-a", [call("c1", "dispatched")])] });
			if (path === "/api/app/conversations/chat-02/interrupted")
				return json({ runs: [run("run-b", [call("c2", "dispatched")])] });
			if (path.endsWith("/decide")) return heldDecide.promise;
			return json({ error: "unhandled" }, 500);
		};
		await render({ conversationId: "app/chat-01" });
		await click(button("Skip")!);
		expect(decides()).toHaveLength(1);
		const chat01Lists = listsFor("chat-01").length;
		await render({ conversationId: "app/chat-02" });
		await flush();
		expect(dom.container.textContent).toContain("run-b".slice(0, 8));
		await act(async () => {
			heldDecide.resolve(json({ ok: true }));
		});
		await flush();
		expect(listsFor("chat-01")).toHaveLength(chat01Lists);
		expect(dom.container.textContent).toContain("run-b".slice(0, 8));
		expect((dom.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
	});

	test("an acknowledged resume fenced by navigation or token change never fires a callback", async () => {
		const heldResume = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-a", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return heldResume.promise;
			return json({ error: "unhandled" }, 500);
		};
		let oldFired = 0;
		let newFired = 0;
		await render({
			conversationId: "app/chat-01",
			onResumed: async () => {
				oldFired++;
			},
		});
		await click(button("Resume turn")!);
		expect(resumes()).toHaveLength(1);
		await render({
			conversationId: "app/chat-02",
			onResumed: async () => {
				newFired++;
			},
		});
		await act(async () => {
			heldResume.resolve(json({ resumed: true, runId: "run-a" }));
		});
		await flush();
		expect(oldFired).toBe(0);
		expect(newFired).toBe(0);

		const heldResume2 = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-c", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return heldResume2.promise;
			return json({ error: "unhandled" }, 500);
		};
		await render({
			conversationId: "app/chat-03",
			token: "tok-a",
			onResumed: async () => {
				oldFired += 10;
			},
		});
		await click(button("Resume turn")!);
		expect(resumes()).toHaveLength(2);
		await render({
			conversationId: "app/chat-03",
			token: "tok-b",
			onResumed: async () => {
				newFired += 10;
			},
		});
		await act(async () => {
			heldResume2.resolve(json({ resumed: true, runId: "run-c" }));
		});
		await flush();
		expect(oldFired).toBe(0);
		expect(newFired).toBe(0);
	});

	test("a held old-context decision never blocks or leaks into the new lane", async () => {
		const held1 = deferred<Response>();
		const held2 = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/api/app/conversations/chat-01/interrupted")
				return json({ runs: [run("run-a", [call("c1", "dispatched")])] });
			if (path === "/api/app/conversations/chat-02/interrupted")
				return json({ runs: [run("run-b", [call("c2", "dispatched")])] });
			if (path.endsWith("/run-a/decide")) return held1.promise;
			if (path.endsWith("/run-b/decide")) return held2.promise;
			return json({ error: "unhandled" }, 500);
		};
		await render({ conversationId: "app/chat-01" });
		await click(button("Skip")!);
		expect(decides()).toHaveLength(1);
		await render({ conversationId: "app/chat-02" });
		await flush();
		expect(dom.container.textContent).toContain("run-b".slice(0, 8));
		const skipBtn = button("Skip")!;
		expect(skipBtn.disabled).toBe(false);
		await click(skipBtn);
		expect(decides()).toHaveLength(2);
		expect(button("Skip")!.disabled).toBe(true);
		const chat01Lists = listsFor("chat-01").length;
		const chat02Lists = listsFor("chat-02").length;
		await act(async () => {
			held1.resolve(json({ ok: true }));
		});
		await flush();
		expect(listsFor("chat-01")).toHaveLength(chat01Lists);
		expect(listsFor("chat-02")).toHaveLength(chat02Lists);
		expect(button("Skip")!.disabled).toBe(true);
		await act(async () => {
			held2.resolve(json({ ok: true }));
		});
		await flush();
		expect(listsFor("chat-02")).toHaveLength(chat02Lists + 1);
	});

	test("a resume ack fenced by a token change leaves the new lane's run resumable", async () => {
		const held = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-a", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return held.promise;
			return json({ error: "unhandled" }, 500);
		};
		let oldFired = 0;
		let newFired = 0;
		await render({
			conversationId: "app/chat-01",
			token: "tok-a",
			onResumed: async () => {
				oldFired++;
			},
		});
		await click(button("Resume turn")!);
		expect(resumes()).toHaveLength(1);
		await render({
			conversationId: "app/chat-01",
			token: "tok-b",
			onResumed: async () => {
				newFired++;
			},
		});
		await flush();
		await act(async () => {
			held.resolve(json({ resumed: true, runId: "run-a" }));
		});
		await flush();
		expect(oldFired).toBe(0);
		expect(newFired).toBe(0);
		expect(dom.container.textContent).toContain("run-a".slice(0, 8));
		expect(button("Resume turn")!.disabled).toBe(false);
	});

	test("unmounting mid-decision emits no further fetch", async () => {
		const held = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "dispatched")])] });
			if (path.endsWith("/decide")) return held.promise;
			return json({ error: "unhandled" }, 500);
		};
		await render();
		await click(button("Skip")!);
		expect(decides()).toHaveLength(1);
		await act(async () => {
			dom.root?.unmount();
			dom.root = null;
		});
		await act(async () => {
			held.resolve(json({ ok: true }));
		});
		await flush();
		expect(byPath("/interrupted")).toHaveLength(1);
	});

	test("a held onResumed keeps single-flight — a second run's resume stays blocked", async () => {
		const heldCallback = deferred<void>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({
					runs: [
						run("run-a", [call("c1", "resolved-skip")]),
						run("run-b", [call("c2", "resolved-skip")]),
					],
				});
			if (path.endsWith("/resume")) return json({ resumed: true, runId: "x" });
			return json({ error: "unhandled" }, 500);
		};
		await render({ onResumed: () => heldCallback.promise });
		const resumeBtns = [...dom.container.querySelectorAll(".interrupted-resume")];
		expect(resumeBtns).toHaveLength(2);
		await click(resumeBtns[0]!);
		await flush();
		expect(resumes()).toHaveLength(1);
		await click(dom.container.querySelectorAll(".interrupted-resume")[0]!);
		await flush();
		expect(resumes()).toHaveLength(1);
		await act(async () => {
			heldCallback.resolve();
		});
		await flush();
		await click(dom.container.querySelectorAll(".interrupted-resume")[0]!);
		await flush();
		expect(resumes()).toHaveLength(2);
	});

	test("unmounting mid-flight leaks no refetch, state, or callback", async () => {
		const heldResume = deferred<Response>();
		onRequest = (req) => {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/interrupted"))
				return json({ runs: [run("run-deadbeef", [call("c1", "resolved-skip")])] });
			if (path.endsWith("/resume")) return heldResume.promise;
			return json({ error: "unhandled" }, 500);
		};
		let resumed = 0;
		await render({
			onResumed: async () => {
				resumed++;
			},
		});
		await click(button("Resume turn")!);
		expect(resumes()).toHaveLength(1);
		await act(async () => {
			dom.root?.unmount();
			dom.root = null;
		});
		await act(async () => {
			heldResume.resolve(json({ resumed: true, runId: "run-deadbeef" }));
		});
		await flush();
		expect(resumed).toBe(0);
		expect(byPath("/interrupted")).toHaveLength(1);
	});
});
