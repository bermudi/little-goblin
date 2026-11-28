import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../../conversation.ts";
import { setLogFile } from "../../log.ts";
import { openNotes } from "../../notes.ts";
import { openProjects } from "../../projects.ts";
import { fenceTools } from "../../turn/tool-fence.ts";
import { useHome } from "../../testkit.ts";
import { noteTool } from "./note.ts";
import { bashTool } from "./bash.ts";
import { withGoblinCommands } from "./goblin-channel.ts";

setLogFile("/dev/null");

function setup(
	allowed = true,
	checkAuthority: () => void = () => {},
	afterNote?: () => void,
	block?: { started(): void; aborted(): void },
	hold?: { started(): void; release: Promise<void> },
): {
	bash: { execute(input: unknown, context: never): Promise<unknown> };
	notes: ReturnType<typeof openNotes>;
	home: string;
	close(): void;
} {
	const home = useHome("goblin-command-test-");
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const note = noteTool({ notes, projects, conversation: "test", projectId: null });
	const tools = {
		bash: bashTool("/tmp", "/tmp", true),
		...(allowed ? {
			note: {
				...note,
				execute: async (input: Parameters<typeof note.execute>[0], context: Parameters<typeof note.execute>[1]) => {
					if (block !== undefined) {
						block.started();
						await new Promise<never>((_resolve, reject) => {
							const signal = context.abortSignal;
							if (signal?.aborted) {
								block.aborted();
								reject(new Error("aborted"));
								return;
							}
							signal?.addEventListener("abort", () => {
								block.aborted();
								reject(new Error("aborted"));
							}, { once: true });
						});
					}
					if (hold !== undefined) {
						hold.started();
						await hold.release;
					}
					const output = await note.execute(input, context);
					afterNote?.();
					return output;
				},
			},
		} : {}),
	};
	withGoblinCommands(tools);
	const fenced = fenceTools({
		tools,
		convId: "test",
		epoch: 1,
		journal: undefined,
		checkAuthority,
	});
	return {
		bash: fenced.bash as { execute(input: unknown, context: never): Promise<unknown> },
		notes,
		home,
		close: () => store.db.close(),
	};
}

async function run(
	harness: ReturnType<typeof setup>,
	command: string,
	context: { toolCallId?: string; abortSignal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
	return await harness.bash.execute(
		{ command },
		{ toolCallId: context.toolCallId ?? "bash1", messages: [], context: {}, ...context } as never,
	) as Record<string, unknown>;
}

describe("goblin command channel at the bash boundary", () => {
	test("pipes, stdin, help, and hides the inherited channel from ordinary Bun", async () => {
		const h = setup();
		try {
			const output = await run(h, "goblin note list | tr a-z A-Z; n=$(goblin note list | wc -c); echo count=$n; printf 'hello' | goblin note create --title T --body -; bun -e 'console.log(typeof process.send)'; goblin --help; goblin note --help");
			expect(output.output).toContain("SCOPE");
			expect(output.output).toContain("count=");
			expect(output.output).toContain('"title": "T"');
			expect(output.output).toContain("undefined");
			expect(output.output).toContain("note");
			expect(output.output).toContain("--title");
			expect(output.calls).toHaveLength(3);
			const created = h.notes.list({ project: "loose" }).find((note) => note.title === "T");
			expect(created).toBeDefined();
			expect(h.notes.get(created!.id)?.body).toBe("hello");
		} finally {
			h.close();
		}
	});

	test("parallel commands serialize and retain their own replies", async () => {
		const h = setup();
		try {
			const output = await run(h, "goblin note create --title A & goblin note create --title B & wait");
			const ids = [...String(output.output).matchAll(/\"id\": \"([^\"]+)\"/g)].map((match) => match[1]);
			expect(ids).toHaveLength(2);
			expect(new Set(ids).size).toBe(2);
			expect(output.calls).toHaveLength(2);
		} finally {
			h.close();
		}
	});

	test("commands are refused when note is not in the assembled tools", async () => {
		const h = setup(false);
		try {
			const output = await run(h, "goblin note list");
			expect(output.output).toContain("goblin: note is not available in this chat");
			expect(output.exit_code).toBe(2);
			expect(output.calls).toBeUndefined();
		} finally {
			h.close();
		}
	});

	test("an unbound commands-on bash still runs and reports the missing command binding", async () => {
		const tool = bashTool("/tmp", "/tmp", true);
		const result = await tool.execute!(
			{ command: "printf shell; goblin note list" },
			{ toolCallId: "unbound" },
		) as Record<string, unknown>;
		expect(result.exit_code).toBe(2);
		expect(result.output).toContain("shellgoblin:");
		expect(result.calls).toBeUndefined();
	});

	test("schema flags coerce numbers, JSON arrays merge, and tool refusals exit one", async () => {
		const h = setup();
		try {
			await run(h, "goblin note create --title RANGE --body abc");
			const created = h.notes.list({ project: "loose" }).find((note) => note.title === "RANGE")!;
			const page = await run(h, `goblin note read --id ${created.id} --offset 1`);
			expect(page.exit_code).toBe(0);
			expect(page.output).toContain("Showing chars 1");
			const edited = await run(
				h,
				`goblin note replace_range --id ${created.id} --json '{"edits":[{"start":1,"end":2,"expected":"b","text":"B"}]}'`,
			);
			expect(edited.exit_code).toBe(0);
			expect(h.notes.get(created.id)?.body).toBe("aBc");
			const missing = await run(h, "goblin note read --id does-not-exist");
			expect(missing.exit_code).toBe(1);
			expect(missing.output).toContain("no such note");
			expect(missing.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test("the 51st call and an over-size stdin request return usage errors", async () => {
		const h = setup();
		try {
			const limited = await run(h, "for i in $(seq 1 51); do goblin note list >/dev/null || { code=$?; echo code=$code; exit $code; }; done");
			expect(limited.exit_code).toBe(2);
			expect(limited.output).toContain("call limit reached");
			expect(limited.calls).toHaveLength(50);
			const oversized = await run(h, "head -c 1048577 /dev/zero | goblin note create --title BIG --body -");
			expect(oversized.exit_code).toBe(2);
			expect(oversized.output).toContain("stdin exceeds 1 MiB");
			const oversizedRequest = await run(
				h,
				`big=$(printf '%120000s' x); goblin note list ${Array.from({ length: 9 }, () => `--bad "$big"`).join(" ")}`,
			);
			expect(oversizedRequest.exit_code).toBe(2);
			expect(oversizedRequest.output).toContain("request exceeds 1 MiB");
			expect(h.notes.list({ project: "loose" }).some((note) => note.title === "BIG")).toBe(false);
		} finally {
			h.close();
		}
	});

	test("a background process cannot call after its bash call returns", async () => {
		const h = setup();
		try {
			const resultPath = join(h.home, "late.result");
			const codePath = join(h.home, "late.code");
			await run(h, `(sleep 0.5; goblin note create --title LATE >${resultPath} 2>&1; echo $? >${codePath}) >/dev/null 2>&1 &`);
			await Bun.sleep(800);
			expect(h.notes.list({ project: "loose" }).some((note) => note.title === "LATE")).toBe(false);
			expect(existsSync(resultPath)).toBe(true);
			expect(readFileSync(resultPath, "utf8")).toContain("goblin: the bash call that owned this channel has ended");
			expect(readFileSync(codePath, "utf8").trim()).toBe("75");
		} finally {
			h.close();
		}
	});

	test("a call accepted before bash exits finishes before bash returns", async () => {
		let start!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { start = resolve; });
		const released = new Promise<void>((resolve) => { release = resolve; });
		const h = setup(true, () => {}, undefined, undefined, { started: start, release: released });
		try {
			let settled = false;
			const result = run(h, "goblin note create --title INFLIGHT >/dev/null 2>&1 & sleep 0.2").then((output) => {
				settled = true;
				return output;
			});
			await started;
			await Bun.sleep(600);
			expect(settled).toBe(false);
			expect(h.notes.list({ project: "loose" })).toHaveLength(0);
			release();
			const output = await result;
			expect(output.exit_code).toBe(0);
			expect((output.calls as { tool: string; ok: boolean }[]).map((call) => [call.tool, call.ok])).toEqual([["note", true]]);
			expect(h.notes.list({ project: "loose" }).map((note) => note.title)).toEqual(["INFLIGHT"]);
		} finally {
			h.close();
		}
	});

	test("authority is checked again before each nested call", async () => {
		let authorized = true;
		const h = setup(true, () => {
			if (!authorized) throw new Error("authority changed");
		}, () => { authorized = false; });
		try {
			const output = await run(h, "goblin note create --title FIRST; goblin note create --title SECOND");
			expect((output.calls as { ok: boolean }[]).map((call) => call.ok)).toEqual([true, false]);
			expect(h.notes.list({ project: "loose" }).map((note) => note.title)).toEqual(["FIRST"]);
			expect(output.output).toContain("authority changed");
		} finally {
			h.close();
		}
	});

	test("stop aborts an active dispatch and returns promptly", async () => {
		let start!: () => void;
		let aborted = false;
		const started = new Promise<void>((resolve) => { start = resolve; });
		const h = setup(true, () => {}, undefined, {
			started: start,
			aborted: () => { aborted = true; },
		});
		const resultPath = join(h.home, "late.result");
		const codePath = join(h.home, "late.code");
		const controller = new AbortController();
		try {
			const startedAt = Date.now();
			const result = run(
				h,
				`setsid /bin/bash -c 'sleep 0.5; goblin note create --title LATE >${resultPath} 2>&1; echo $? >${codePath}' >/dev/null 2>&1 & goblin note create --title HELD`,
				{ abortSignal: controller.signal },
			);
			await started;
			controller.abort();
			await result;
			await Bun.sleep(800);
			expect(aborted).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(5000);
			expect(h.notes.list({ project: "loose" })).toHaveLength(0);
			expect(readFileSync(resultPath, "utf8")).toContain("goblin: the bash call that owned this channel has ended");
			expect(readFileSync(codePath, "utf8").trim()).toBe("75");
		} finally {
			h.close();
		}
	});

	test("the commands-off bash output stays the legacy shape", async () => {
		const off = bashTool("/tmp");
		const output = await off.execute!({ command: "printf x; command -v goblin || true" }, { toolCallId: "off" });
		expect(off.description).not.toContain("goblin --help");
		expect(output).toEqual({ exit_code: 0, timed_out: undefined, truncated: undefined, output: "x" });
		expect(output).not.toHaveProperty("calls");
	});
});
