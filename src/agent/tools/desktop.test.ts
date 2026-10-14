// The desktop native tool: flat action schema, derived (never taken)
// lease holders, per-action required fields, shot → audited path, and
// workspace containment on both file directions. The Desktops dep is
// faked at the interface — what the tests pin is that bad input never
// reaches the pool.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopError, type DesktopRow, type Desktops, type LeaseHolder } from "../../desktops.ts";
import { desktopInputSchema, desktopTool, type DesktopToolDeps } from "./desktop.ts";

const CONV = "dm:test";
const opts = { toolCallId: "t1", messages: [], context: {} };

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function fakeRow(over: Partial<DesktopRow> = {}): DesktopRow {
	return {
		name: "d1",
		container: "goblin-desk-d1",
		image: "localhost/goblin-desktop:1",
		network: false,
		reserved: false,
		leaseKind: null,
		leaseId: null,
		leaseExpiresAt: null,
		lastObsId: null,
		lastObsUsed: false,
		lastObsHash: null,
		lastActSig: null,
		lastActFrameHash: null,
		shotSeq: 0,
		createdAt: 1,
		lastUsedAt: 1,
		...over,
	};
}

function rig(over: Partial<Desktops>, workspace = mkdtempSync(join(tmpdir(), "goblin-dt-"))) {
	dirs.push(workspace);
	const calls: { name: string; args: unknown[] }[] = [];
	const rec =
		<A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
		(...a: A): R => {
			calls.push({ name, args: a });
			return fn(...a);
		};
	const desktops: Desktops = {
		allocate: rec("allocate", async () => ({ row: fakeRow() })),
		list: () => [fakeRow()],
		get: () => fakeRow(),
		claim: rec("claim", async () => fakeRow({ leaseKind: "conversation", leaseId: CONV })),
		release: rec("release", async () => {}),
		handoff: rec("handoff", async () => {}),
		reserve: rec("reserve", async () => {}),
		setNetwork: rec("setNetwork", async () => {}),
		destroy: rec("destroy", async () => {}),
		screenshot: rec("screenshot", async () => ({
			id: "obs-1",
			path: "/state/desktops/d1/shot-1.png",
			bytes: new Uint8Array([1]),
		})),
		inspect: rec("inspect", async () => ({ id: "obs-2", state: {} })),
		act: rec("act", async () => ({ result: {} })),
		cpIn: rec("cpIn", async () => ({})),
		catFile: rec("catFile", async () => ({ data: new TextEncoder().encode("desk-bytes") })),
		...over,
	};
	const deps: DesktopToolDeps = { conversation: CONV, workspace, desktops };
	return { tool: desktopTool(deps), calls, workspace };
}

describe("desktopInputSchema", () => {
	test("accepts every action's valid shape", () => {
		const valid = [
			{ action: "new", name: "d1" },
			{ action: "new", name: "d1", image: "localhost/goblin-desktop:1" },
			{ action: "list" },
			{ action: "shot", name: "d1" },
			{ action: "claim", name: "d1" },
			{ action: "claim", name: "d1", holder: "conversation" },
			{ action: "release", name: "d1" },
			{ action: "handoff", name: "d1", to_holder: "operator" },
			{ action: "handoff", name: "d1", to_holder: "conversation" },
			{ action: "reserve", name: "d1", reserved: true },
			{ action: "network", name: "d1", enabled: true },
			{ action: "import", name: "d1", from: "a.txt", to: "/home/desk/a.txt" },
			{ action: "export", name: "d1", from: "/home/desk/out.bin" },
			{ action: "destroy", name: "d1" },
		];
		for (const v of valid) expect(desktopInputSchema.safeParse(v).success).toBe(true);
	});

	test("rejects missing fields, bad names, flag-shaped images, forged holders", () => {
		const invalid = [
			{ action: "new" },
			{ action: "shot" },
			{ action: "claim", name: "D 1" },
			{ action: "new", name: "d1", image: "--privileged" },
			{ action: "claim", name: "d1", holder: "run:5" }, // forged holder id
			{ action: "claim", name: "d1", holder: "operator" }, // never act AS the operator
			{ action: "release", name: "d1", holder: "operator" },
			{ action: "destroy", name: "d1", holder: "operator" },
			{ action: "handoff", name: "d1", holder: "operator", to_holder: "conversation" },
			{ action: "handoff", name: "d1" }, // no to_holder
			{ action: "reserve", name: "d1" },
			{ action: "network", name: "d1" },
			{ action: "import", name: "d1", from: "a" }, // no to
			{ action: "export", name: "d1" }, // no from
			{ action: "act", name: "d1", tool: "click" }, // no act surface at all
		];
		for (const v of invalid) expect(desktopInputSchema.safeParse(v).success).toBe(false);
	});
});

describe("desktop tool", () => {
	test("shot returns the audited path and observation id, never bytes", async () => {
		const { tool } = rig({});
		const out = (await tool.execute!({ action: "shot", name: "d1" }, opts)) as Record<
			string,
			unknown
		>;
		expect(out.observation_id).toBe("obs-1");
		expect(String(out.path)).toContain("shot-1.png");
		expect(out.bytes).toBeUndefined();
	});

	test("claim always acts as this conversation — never as the operator", async () => {
		const { tool, calls } = rig({});
		await tool.execute!({ action: "claim", name: "d1" }, opts);
		await tool.execute!({ action: "claim", name: "d1", holder: "conversation" }, opts);
		const holders = calls.filter((c) => c.name === "claim").map((c) => c.args[1] as LeaseHolder);
		expect(holders).toEqual([
			{ kind: "conversation", id: CONV },
			{ kind: "conversation", id: CONV },
		]);
	});

	test("a claim that reconciled the desktop returns its note; a clean claim returns none", async () => {
		const note =
			"desktop container was gone — recreated fresh; its previous contents and lease are gone";
		const dirty = rig({
			claim: async () => ({
				...fakeRow({ leaseKind: "conversation", leaseId: CONV }),
				note,
			}),
		});
		const out = (await dirty.tool.execute!({ action: "claim", name: "d1" }, opts)) as Record<
			string,
			unknown
		>;
		expect(out.note).toBe(note);
		const clean = rig({});
		const cleanOut = (await clean.tool.execute!({ action: "claim", name: "d1" }, opts)) as Record<
			string,
			unknown
		>;
		expect(cleanOut.note).toBeUndefined();
	});

	test("the operator is a handoff destination only, never the acting holder", async () => {
		const { tool, calls } = rig({});
		// A forged self holder fails validation in execute's re-parse —
		// the pool is never reached.
		for (const raw of [
			{ action: "release", name: "d1", holder: "operator" },
			{ action: "destroy", name: "d1", holder: "operator" },
			{ action: "handoff", name: "d1", holder: "operator", to_holder: "conversation" },
		]) {
			const out = (await tool.execute!(raw as never, opts)) as Record<string, unknown>;
			expect(String(out.error)).toContain("invalid desktop call");
		}
		expect(calls.length).toBe(0);
	});

	test("handoff requires both ends — from derived, to from the enum", async () => {
		const { tool, calls } = rig({});
		await tool.execute!({ action: "handoff", name: "d1", to_holder: "operator" }, opts);
		const args = calls.find((c) => c.name === "handoff")!.args;
		expect(args[1]).toEqual({ kind: "conversation", id: CONV });
		expect(args[2]).toEqual({ kind: "operator" });
	});

	test("import refuses out-of-workspace sources before cpIn", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-dt-"));
		const { tool, calls } = rig({}, ws);
		const out = (await tool.execute!(
			{ action: "import", name: "d1", from: "../outside.txt", to: "/home/desk/x" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("outside the workspace");
		expect(calls.some((c) => c.name === "cpIn")).toBe(false);
	});

	test("import stages a copy — cpIn never sees the workspace path", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-dt-"));
		writeFileSync(join(ws, "payload.txt"), "x");
		const { tool, calls } = rig({}, ws);
		const out = (await tool.execute!(
			{ action: "import", name: "d1", from: "payload.txt", to: "/home/desk/payload.txt" },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		const cp = calls.find((c) => c.name === "cpIn")!.args;
		expect(cp[0]).toBe("d1");
		expect(String(cp[1])).not.toBe(join(ws, "payload.txt")); // staged copy
		expect(cp[2]).toBe("/home/desk/payload.txt");
	});

	test("export lands under the workspace via the boundary helper", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-dt-"));
		const { tool, calls } = rig({}, ws);
		const out = (await tool.execute!(
			{ action: "export", name: "d1", from: "/home/desk/out.bin", to: "deskout/o.bin" },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		expect(out.exported).toBe(join("deskout", "o.bin"));
		expect(calls.find((c) => c.name === "catFile")!.args[1]).toBe("/home/desk/out.bin");
		const bad = (await tool.execute!(
			{ action: "export", name: "d1", from: "/home/desk/out.bin", to: "../evil" },
			opts,
		)) as Record<string, unknown>;
		expect(String(bad.error)).toContain("outside the workspace");
	});

	test("pool refusals surface as errors, not throws", async () => {
		const { tool } = rig({
			release: async () => {
				throw new DesktopError("desktop d1 is controlled by run #7");
			},
		});
		const out = (await tool.execute!({ action: "release", name: "d1" }, opts)) as Record<
			string,
			unknown
		>;
		expect(String(out.error)).toContain("controlled by run #7");
	});
});
