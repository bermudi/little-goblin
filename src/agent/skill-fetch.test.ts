import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchSkill,
	normalizeGithubSkillUrl,
	SkillFetchError,
	BODY_MAX_BYTES,
} from "./skill-fetch.ts";
import { readDescriptor } from "./skill-fetch.ts";

let dirs: string[] = [];
const useCache = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-skillcache-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("normalizeGithubSkillUrl", () => {
	test("tree directory", () => {
		expect(
			normalizeGithubSkillUrl("https://github.com/anthropics/skills/tree/main/skills/claude-api"),
		).toEqual({ owner: "anthropics", repo: "skills", ref: "main", dir: "skills/claude-api" });
	});

	test("tree SKILL.md leaf takes the parent dir", () => {
		expect(
			normalizeGithubSkillUrl("https://github.com/anthropics/skills/tree/main/skills/claude-api/SKILL.md"),
		).toEqual({ owner: "anthropics", repo: "skills", ref: "main", dir: "skills/claude-api" });
	});

	test("blob file takes the parent dir", () => {
		expect(
			normalizeGithubSkillUrl("https://github.com/o/r/blob/v1.2/lib/SKILL.md"),
		).toEqual({ owner: "o", repo: "r", ref: "v1.2", dir: "lib" });
	});

	test("repo root is a skill dir", () => {
		expect(normalizeGithubSkillUrl("https://github.com/o/r")).toEqual({
			owner: "o",
			repo: "r",
			ref: "HEAD",
			dir: "",
		});
		expect(normalizeGithubSkillUrl("https://github.com/o/r/tree/main")).toEqual({
			owner: "o",
			repo: "r",
			ref: "main",
			dir: "",
		});
	});

	test("raw file takes its directory", () => {
		expect(
			normalizeGithubSkillUrl("https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md"),
		).toEqual({ owner: "o", repo: "r", ref: "main", dir: "skills/x" });
	});

	test("query and fragment are stripped", () => {
		expect(
			normalizeGithubSkillUrl("https://github.com/o/r/tree/main/skills/x?plain=1#L1"),
		).toEqual({ owner: "o", repo: "r", ref: "main", dir: "skills/x" });
	});

	test("refusals", () => {
		expect(normalizeGithubSkillUrl("ftp://github.com/o/r/tree/main/x")).toBeNull();
		expect(normalizeGithubSkillUrl("https://gitlab.com/o/r/tree/main/x")).toBeNull();
		expect(normalizeGithubSkillUrl("https://github.com/o/r/wiki")).toBeNull();
		expect(normalizeGithubSkillUrl("https://github.com/o/r/blob/main")).toBeNull();
		expect(normalizeGithubSkillUrl("not a url")).toBeNull();
		expect(normalizeGithubSkillUrl("https://github.com/o")).toBeNull();
	});

	test("dot segments are URL-normalized before segmentation", () => {
		// The URL constructor resolves `..` before this code sees the
		// path — the traversal check is defense in depth, the
		// normalization is what actually holds.
		expect(normalizeGithubSkillUrl("https://github.com/o/r/tree/main/../x")).toEqual({
			owner: "o",
			repo: "r",
			ref: "x",
			dir: "",
		});
	});
});

// A real gzipped tarball via the system tar — the pipeline shells out to
// tar, so the fixture is one too.
const TOP = "r-main";

async function makeTarball(
	root: string,
	files: Record<string, string>,
): Promise<Uint8Array> {
	const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
	dirs.push(src);
	for (const [rel, content] of Object.entries(files)) {
		const p = join(src, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content);
	}
	const out = mkdtempSync(join(tmpdir(), "goblin-tarball-"));
	dirs.push(out);
	const ballPath = join(out, "ball.tgz");
	// The ball must land outside the tree it reads — tar refuses a
	// source directory that changes under it.
	// Canonical member names (r-main/...), like a codeload tarball —
	// `tar -c .` would prefix every member with ./
	const proc = Bun.spawn(["tar", "-czf", ballPath, TOP], { cwd: src, stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error("fixture tar failed");
	const bytes = await Bun.file(ballPath).bytes();
	rmSync(src, { recursive: true, force: true });
	dirs = dirs.filter((d) => d !== src);
	return bytes;
}

function tarballFetch(bytes: Uint8Array, status = 200): typeof fetch {
			return (async () => new Response(bytes as never, { status })) as unknown as typeof fetch;
}

describe("fetchSkill", () => {
	test("happy path: whole dir staged, descriptor written, digest-named", async () => {
		const cache = useCache();
		const ball = await makeTarball("x", {
			"r-main/skills/demo/SKILL.md": "---\nname: demo\ndescription: d\n---\nbody",
			"r-main/skills/demo/scripts/run.sh": "echo hi",
		});
		const fetched = await fetchSkill("https://github.com/o/r/tree/main/skills/demo", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(fetched.descriptor.name).toBe("demo");
		expect(fetched.bodyBytes).toBe(("---\nname: demo\ndescription: d\n---\nbody").length);
		expect(fetched.fileCount).toBe(2);
		expect(fetched.cached).toBe(false);
		const digestDir = join(cache, fetched.digest);
		expect(statSync(join(digestDir, "demo", "scripts", "run.sh")).isFile()).toBe(true);
		expect(readDescriptor(digestDir)?.name).toBe("demo");
		expect(readDescriptor(digestDir)?.verdict.status).toBe("unavailable");
		// No stray staging dirs left behind.
		expect(readdirSync(cache).every((n) => n === fetched.digest)).toBe(true);
	});

	test("second fetch of the same tarball hits the cache", async () => {
		const cache = useCache();
		const ball = await makeTarball("x", {
			"r-main/demo/SKILL.md": "---\nname: demo\ndescription: d\n---\nbody",
		});
		const first = await fetchSkill("https://github.com/o/r/tree/main/demo", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		const second = await fetchSkill("https://github.com/o/r/blob/main/demo/SKILL.md", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(second.cached).toBe(true);
		expect(second.digest).toBe(first.digest);
		expect(second.path).toBe(first.path);
	});

	test("name must match the directory", async () => {
		const cache = useCache();
		const ball = await makeTarball("x", {
			"r-main/wrong/SKILL.md": "---\nname: demo\ndescription: d\n---\nbody",
		});
		expect(
			fetchSkill("https://github.com/o/r/tree/main/wrong", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			}),
		).rejects.toThrow("does not match directory");
	});

	test("missing subtree is an invalid URL error, not a crash", async () => {
		const cache = useCache();
		const ball = await makeTarball("x", { "r-main/other/file.txt": "hi" });
		try {
			await fetchSkill("https://github.com/o/r/tree/main/nope", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("invalid");
		}
	});

	test("404 names the repo and ref", async () => {
		const cache = useCache();
		const fetch404 = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
		try {
			await fetchSkill("https://github.com/o/r/tree/main/demo", {
				fetchImpl: fetch404,
				cacheRoot: cache,
			});
			expect.unreachable();
		} catch (err) {
			expect((err as SkillFetchError).message).toContain("o/r@main");
		}
	});

	test("an oversize body is refused", async () => {
		const cache = useCache();
		const big = "x".repeat(BODY_MAX_BYTES + 1);
		const ball = await makeTarball("x", {
			"r-main/demo/SKILL.md": `---\nname: demo\ndescription: d\n---\n${big}`,
		});
		try {
			await fetchSkill("https://github.com/o/r/tree/main/demo", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			});
			expect.unreachable();
		} catch (err) {
			expect((err as SkillFetchError).status).toBe("oversized");
		}
	});

	test("a symlink inside the fetched dir is refused", async () => {
		const cache = useCache();
		const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
		dirs.push(src);
		mkdirSync(join(src, "r-main/demo"), { recursive: true });
		writeFileSync(join(src, "r-main/demo/SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody");
		const proc = Bun.spawn(["ln", "-s", "/etc", join(src, "r-main/demo/innocent")]);
		if ((await proc.exited) !== 0) throw new Error("fixture symlink failed");
		const ballPath = join(useCache(), "ball.tgz");
		const tar = Bun.spawn(["tar", "-czf", ballPath, "r-main"], {
			cwd: src,
			stdout: "ignore",
			stderr: "ignore",
		});
		if ((await tar.exited) !== 0) throw new Error("fixture tar failed");
		const ball = await Bun.file(ballPath).bytes();
		rmSync(src, { recursive: true, force: true });
		dirs = dirs.filter((d) => d !== src);
		try {
			await fetchSkill("https://github.com/o/r/tree/main/demo", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			});
			expect.unreachable();
		} catch (err) {
			expect((err as SkillFetchError).status).toBe("invalid");
			expect((err as SkillFetchError).message).toContain("symlink");
		}
	});
});
