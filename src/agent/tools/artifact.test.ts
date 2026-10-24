import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useHome } from "../../testkit.ts";
import { paths } from "../../config.ts";
import { artifactTool } from "./artifact.ts";

let home: string;
let workspace: string;
beforeEach(() => {
	home = useHome("goblin-artifact-");
	workspace = join(home, "ws");
	mkdirSync(workspace, { recursive: true });
});

const exec = (t: unknown, input: unknown): Promise<{ artifact?: unknown; error?: string }> =>
	(t as { execute: (i: unknown, o: unknown) => Promise<never> }).execute(input, {
		toolCallId: "tc-artifact",
		messages: [],
		context: {},
	});

function artifactOf(out: { artifact?: unknown }): {
	path: string;
	name: string;
	mediaType: string;
	size: number;
	source: { target: string; path: string };
	title?: string;
} {
	if (out.artifact === undefined) throw new Error("no artifact in output");
	return out.artifact as never;
}

describe("artifact — workspace source", () => {
	test("publishing snapshots the file into the attachment store", async () => {
		writeFileSync(join(workspace, "report.md"), "# first");
		const t = artifactTool({ conversation: "app/x", workspace });
		const out = await exec(t, {
			source: { target: "workspace", path: "report.md" },
			title: "Report",
		});
		const a = artifactOf(out);
		expect(a.name).toBe("report.md");
		expect(a.title).toBe("Report");
		expect(a.mediaType.startsWith("text/markdown")).toBe(true);
		expect(a.size).toBe(7);
		expect(a.source).toEqual({ target: "workspace", path: "report.md" });
		// The stored copy lives under the attachment root — served by basename.
		expect(a.path.startsWith(paths.attachments())).toBe(true);
		expect(readFileSync(a.path, "utf8")).toBe("# first");
		// Immutable: editing the source afterwards changes nothing stored.
		writeFileSync(join(workspace, "report.md"), "# rewritten");
		expect(readFileSync(a.path, "utf8")).toBe("# first");
	});

	test("absolute paths inside the workspace work; escapes refuse", async () => {
		writeFileSync(join(workspace, "a.txt"), "a");
		const t = artifactTool({ conversation: "app/x", workspace });
		const ok = await exec(t, { source: { target: "workspace", path: join(workspace, "a.txt") } });
		expect(artifactOf(ok).name).toBe("a.txt");
		const outside = await exec(t, { source: { target: "workspace", path: "../x" } });
		expect(outside.error).toContain("outside the workspace");
		const missing = await exec(t, { source: { target: "workspace", path: "nope" } });
		expect(missing.error).toContain("not found");
	});

	test("auth.jsonl and .git files can never be published", async () => {
		writeFileSync(join(workspace, "auth.jsonl"), "{}");
		mkdirSync(join(workspace, ".git"), { recursive: true });
		writeFileSync(join(workspace, ".git", "config"), "x");
		const t = artifactTool({ conversation: "app/x", workspace });
		expect(
			(await exec(t, { source: { target: "workspace", path: "auth.jsonl" } })).error,
		).toContain("never served");
		expect(
			(await exec(t, { source: { target: "workspace", path: ".git/config" } })).error,
		).toContain(".git");
	});

	test("a symlink escaping the workspace refuses on realpath", async () => {
		writeFileSync(join(home, "outside.txt"), "secret");
		symlinkSync(join(home, "outside.txt"), join(workspace, "link.txt"));
		const t = artifactTool({ conversation: "app/x", workspace });
		const out = await exec(t, { source: { target: "workspace", path: "link.txt" } });
		expect(out.error).toContain("outside the workspace");
	});

	test("unknown extensions store as octet-stream", async () => {
		writeFileSync(join(workspace, "blob.xyz123"), new Uint8Array([1, 2, 3]));
		const t = artifactTool({ conversation: "app/x", workspace });
		const a = artifactOf(await exec(t, { source: { target: "workspace", path: "blob.xyz123" } }));
		expect(a.mediaType).toBe("application/octet-stream");
	});
});

describe("artifact — sandbox source", () => {
	test("no sandbox wired refuses cleanly", async () => {
		const t = artifactTool({ conversation: "app/x", workspace });
		const out = await exec(t, { source: { target: "sandbox", path: "/work/x.md" } });
		expect(out.error).toBe("sandbox is not configured");
	});

	test("bytes cross through catFile, never through context", async () => {
		const seen: string[] = [];
		const sandboxes = {
			catFile: async (conv: string, path: string) => {
				seen.push(`${conv}:${path}`);
				return { path, data: new Uint8Array([104, 105]) };
			},
		};
		const t = artifactTool({ conversation: "app/x", workspace, sandboxes: sandboxes as never });
		const out = await exec(t, { source: { target: "sandbox", path: "/work/hi.txt" } });
		const a = artifactOf(out);
		expect(seen).toEqual(["app/x:/work/hi.txt"]);
		expect(readFileSync(a.path).toString()).toBe("hi");
	});
});
