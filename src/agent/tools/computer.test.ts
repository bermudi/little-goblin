// The computer type's desktop tools against a stubbed Desktops at its
// own boundary: claim-then-act ordering, the conversation lease
// holder, observation-id pass-through, error mapping, and the
// interrupted-act rule (a failure is reported once, never retried).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopError, type Desktops } from "../../desktops.ts";
import type { DesktopRow } from "../../desktops-store.ts";
import type { LeaseHolder } from "../../desktops-store.ts";
import { computerTools } from "./computer.ts";
import { askOperatorTool } from "./ask-operator.ts";
import { isHosted, type Tool } from "../../tool.ts";

interface Call {
	method: string;
	args: unknown[];
}

// A Desktops stub that records calls and answers from scriptable
// results — the real pool's lease/observation rules are desktops.test.ts's
// job; here the tool's use of them is the boundary.
function stubDesktops(over: Partial<Desktops> = {}): { desktops: Desktops; calls: Call[] } {
	const calls: Call[] = [];
	const rec =
		<T>(name: string, impl: (...args: unknown[]) => T | Promise<T>) =>
		(...args: unknown[]) => {
			calls.push({ method: name, args });
			return impl(...args);
		};
	const desktops = {
		allocate: rec("allocate", () => {
			throw new Error("unused");
		}),
		list: rec("list", () => [] as DesktopRow[]),
		get: rec("get", () => null),
		claim: rec("claim", async () => ({ name: "desk", container: "c", image: "i" }) as never),
		release: rec("release", async () => undefined),
		handoff: rec("handoff", async () => undefined),
		reserve: rec("reserve", async () => undefined),
		setNetwork: rec("setNetwork", async () => undefined),
		destroy: rec("destroy", async () => undefined),
		screenshot: rec("screenshot", async () => {
			throw new Error("unused — text only");
		}),
		inspect: rec("inspect", async () => ({
			id: "obs-1",
			state: { apps: [{ name: "chromium" }], screenshot_png_b64: "AAAA" },
		})),
		act: rec("act", async () => ({ result: { effect: "dispatched" } })),
		cpIn: rec("cpIn", async () => {
			throw new Error("unused");
		}),
		catFile: rec("catFile", async () => {
			throw new Error("unused");
		}),
		...over,
	} as unknown as Desktops;
	return { desktops, calls };
}

const deps = (desktops: Desktops) => ({
	conversation: "app/agent-child1",
	desktop: "desk",
	desktops,
});

const exec = async (tool: Tool | undefined, input: Record<string, unknown>) => {
	if (tool === undefined || isHosted(tool)) throw new Error("tool not mounted");
	return tool.execute(input, { toolCallId: "t1" });
};

describe("computer tools", () => {
	test("inspect claims the bound desktop then returns the observation as text", async () => {
		const { desktops, calls } = stubDesktops();
		const tools = computerTools(deps(desktops));
		const out = (await exec(tools.inspect, {})) as Record<string, unknown>;
		expect(calls.map((c) => c.method)).toEqual(["claim", "inspect"]);
		// The lease holder is the child conversation, not a run.
		expect(calls[0]!.args).toEqual([
			"desk",
			{ kind: "conversation", id: "app/agent-child1" },
		]);
		expect(calls[1]!.args[0]).toBe("desk");
		expect(out["observation_id"]).toBe("obs-1");
		const state = JSON.parse(out["state"] as string) as Record<string, unknown>;
		expect(state["apps"]).toEqual([{ name: "chromium" }]);
		// Text only (#606): screenshot bytes never leave the box.
		expect(state["screenshot_png_b64"]).toBeUndefined();
		expect(out["screenshot_png_b64"]).toBeUndefined();
	});

	test("act binds the observation id and the conversation holder; rejects unknown tools", async () => {
		const { desktops, calls } = stubDesktops();
		const tools = computerTools(deps(desktops));
		const bad = (await exec(tools.act, {
			observation_id: "obs-1",
			tool: "shell_exec",
			args: {},
		})) as Record<string, unknown>;
		expect(bad["error"]).toContain("not an allowed input operation");
		expect(calls).toHaveLength(0);
		const out = (await exec(tools.act, {
			observation_id: "obs-9",
			tool: "click",
			args: { scope: "desktop", x: 1, y: 2, button: "left" },
		})) as Record<string, unknown>;
		expect(calls.map((c) => c.method)).toEqual(["claim", "act"]);
		expect(calls[1]!.args).toEqual([
			"desk",
			{ kind: "conversation", id: "app/agent-child1" },
			"obs-9",
			{ kind: "cua", tool: "click", args: { scope: "desktop", x: 1, y: 2, button: "left" } },
		]);
		expect(out["result"]).toEqual({ effect: "dispatched" });
	});

	test("launch maps to the launch action with chromium", async () => {
		const { desktops, calls } = stubDesktops();
		const tools = computerTools(deps(desktops));
		await exec(tools.launch, { observation_id: "obs-2", url: "https://example.com" });
		expect(calls[1]!.args[3]).toEqual({
			kind: "launch",
			app: "chromium",
			url: "https://example.com",
		});
	});

	test("a refused claim reports the error and never reaches the desktop op", async () => {
		const seen: string[] = [];
		const { desktops, calls } = stubDesktops({
			claim: async () => {
				seen.push("claim");
				throw new DesktopError("desktop desk is controlled by operator until later");
			},
		});
		const tools = computerTools(deps(desktops));
		const out = (await exec(tools.inspect, {})) as Record<string, unknown>;
		expect(out["error"]).toContain("controlled by operator");
		// claim was attempted once; inspect never ran.
		expect(seen).toEqual(["claim"]);
		expect(calls).toHaveLength(0);
	});

	test("a stale observation is reported once — the tool does not retry the act", async () => {
		const seen: string[] = [];
		const { desktops, calls } = stubDesktops({
			act: async () => {
				seen.push("act");
				throw new DesktopError("observation obs-1 is stale — inspect again");
			},
		});
		const tools = computerTools(deps(desktops));
		const out = (await exec(tools.act, {
			observation_id: "obs-1",
			tool: "click",
			args: {},
		})) as Record<string, unknown>;
		expect(out["error"]).toContain("stale");
		expect(seen).toEqual(["act"]);
		// claim ran once around the single act attempt.
		expect(calls.map((c) => c.method)).toEqual(["claim"]);
	});

	test("screenshot is absent unless the dep opts in — the capability gate decides", () => {
		const { desktops } = stubDesktops();
		expect(computerTools(deps(desktops)).screenshot).toBeUndefined();
		expect(
			computerTools({ ...deps(desktops), screenshots: true }).screenshot,
		).toBeDefined();
	});

	test("screenshot stores a small descriptor and toModelOutput rehydrates the frame", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-shot-"));
		const pngPath = join(dir, "frame.png");
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		writeFileSync(pngPath, png);
		const { desktops, calls } = stubDesktops({
			screenshot: async () => ({
				id: "obs-shot-1",
				path: pngPath,
				bytes: png,
				note: "network off",
			}),
		});
		const tool = computerTools({ ...deps(desktops), screenshots: true })
			.screenshot as Tool;
		if (isHosted(tool)) throw new Error("hosted?");
		const stored = (await tool.execute({}, { toolCallId: "t1" })) as string;
		// The lease claim wraps the capture; the overridden screenshot
		// stub isn't call-recorded, so the descriptor proves it ran.
		expect(calls.map((c) => c.method)).toEqual(["claim"]);
		// The durable output is a descriptor string — no image bytes.
		const descriptor = JSON.parse(stored) as Record<string, unknown>;
		expect(descriptor).toMatchObject({
			v: 1,
			observation_id: "obs-shot-1",
			path: pngPath,
			bytes: png.byteLength,
			note: "network off",
		});
		const model = (await tool.toModelOutput!({
			output: stored,
			toolCallId: "t1",
			input: {},
		})) as { type: string; value: Array<Record<string, unknown>> };
		expect(model.type).toBe("content");
		const image = model.value.find((p) => p["type"] === "image") as {
			mediaType: string;
			data: Uint8Array;
		};
		expect(image.mediaType).toBe("image/png");
		expect([...image.data]).toEqual([...png]);
		const caption = model.value.find((p) => p["type"] === "text") as { text: string };
		expect(caption.text).toContain("obs-shot-1");
	});

	test("toModelOutput passes a stub marker or error through as text — never a stale frame", async () => {
		const { desktops } = stubDesktops({
			screenshot: async () => ({ id: "o", path: "/nonexistent/x.png", bytes: new Uint8Array(0) }),
		});
		const tool = computerTools({ ...deps(desktops), screenshots: true })
			.screenshot as Tool;
		if (isHosted(tool)) throw new Error("hosted?");
		const marker =
			"<pruned-frame>\n[Screenshot frame omitted — superseded by a newer frame]\n</pruned-frame>";
		const out = (await tool.toModelOutput!({
			output: marker,
			toolCallId: "t1",
			input: {},
		})) as { type: string; value: string };
		expect(out.type).toBe("text");
		expect(out.value).toBe(marker);
		// A descriptor whose PNG is gone degrades to text, not a broken part.
		const gone = JSON.stringify({ v: 1, observation_id: "o", path: "/nonexistent/x.png", bytes: 0 });
		const out2 = (await tool.toModelOutput!({
			output: gone,
			toolCallId: "t1",
			input: {},
		})) as { type: string; value: string };
		expect(out2.type).toBe("text");
		expect(out2.value).toContain("unavailable");
	});
});

describe("ask_operator tool", () => {
	test("records the question for the engine and tells the model to end its turn", async () => {
		const asked: string[] = [];
		const tool = askOperatorTool({
			recordAsk: (q) => {
				asked.push(q);
				return { ok: true };
			},
		});
		const out = (await exec(tool, { question: "which file should I edit?" })) as Record<
			string,
			unknown
		>;
		expect(asked).toEqual(["which file should I edit?"]);
		expect(out["recorded"]).toBe(true);
	});

	test("an engine refusal surfaces as an error result", async () => {
		const tool = askOperatorTool({ recordAsk: () => ({ error: "child is done" }) });
		const out = (await exec(tool, { question: "q" })) as Record<string, unknown>;
		expect(out["error"]).toBe("child is done");
	});
});
