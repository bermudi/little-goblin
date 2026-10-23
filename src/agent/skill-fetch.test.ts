import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BODY_MAX_BYTES,
	DIRS_MAX,
	fetchSkill,
	normalizeGithubSkillUrl,
	readDescriptor,
	SkillFetchError,
	stampVerdict,
} from "./skill-fetch.ts";

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
			normalizeGithubSkillUrl(
				"https://github.com/anthropics/skills/tree/main/skills/claude-api/SKILL.md",
			),
		).toEqual({ owner: "anthropics", repo: "skills", ref: "main", dir: "skills/claude-api" });
	});

	test("blob file takes the parent dir", () => {
		expect(normalizeGithubSkillUrl("https://github.com/o/r/blob/v1.2/lib/SKILL.md")).toEqual({
			owner: "o",
			repo: "r",
			ref: "v1.2",
			dir: "lib",
		});
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
		expect(normalizeGithubSkillUrl("https://github.com/o/r/tree/main/skills/x?plain=1#L1")).toEqual(
			{ owner: "o", repo: "r", ref: "main", dir: "skills/x" },
		);
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
// tar, so the fixture is one too. `top` is the archive's top-level
// component, like codeload's <repo>-<ref>.
async function makeTarball(
	files: Record<string, string>,
	top = "r-main",
	opts?: { emptyDirs?: string[]; transform?: string },
): Promise<Uint8Array> {
	const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
	dirs.push(src);
	for (const [rel, content] of Object.entries(files)) {
		const p = join(src, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content);
	}
	for (const d of opts?.emptyDirs ?? []) {
		mkdirSync(join(src, d), { recursive: true });
	}
	const out = mkdtempSync(join(tmpdir(), "goblin-tarball-"));
	dirs.push(out);
	const ballPath = join(out, "ball.tgz");
	// The ball must land outside the tree it reads — tar refuses a
	// source directory that changes under it. `tar -c .` would prefix
	// every member with ./.
	const argv = ["tar", "-czf", ballPath];
	if (opts?.transform !== undefined) argv.push("--transform", opts.transform);
	argv.push(top);
	const proc = Bun.spawn(argv, {
		cwd: src,
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await proc.exited) !== 0) throw new Error("fixture tar failed");
	const bytes = await Bun.file(ballPath).bytes();
	rmSync(src, { recursive: true, force: true });
	dirs = dirs.filter((d) => d !== src);
	return bytes;
}

function tarballFetch(bytes: Uint8Array, status = 200): typeof fetch {
	return (async () => new Response(bytes as never, { status })) as unknown as typeof fetch;
}

const sha256hex = (data: Uint8Array | string): string =>
	createHash("sha256").update(data).digest("hex");

const DEMO_URL = "https://github.com/o/r/tree/main/demo";
const demoBody = "---\nname: demo\ndescription: d\n---\nbody";

const withSpawnSpy = async (
	ball: Uint8Array,
	url = DEMO_URL,
): Promise<{ err: SkillFetchError; extracted: number; cache: string }> => {
	const cache = useCache();
	let extracted = 0;
	const real = Bun.spawn;
	const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
		if ((args[0] as string[]).includes("-xzf")) extracted++;
		return (real as (...a: unknown[]) => unknown)(...args);
	}) as never);
	try {
		await fetchSkill(url, { fetchImpl: tarballFetch(ball), cacheRoot: cache });
		expect.unreachable();
	} catch (err) {
		expect(err).toBeInstanceOf(SkillFetchError);
		return { err: err as SkillFetchError, extracted, cache };
	} finally {
		spy.mockRestore();
	}
};

describe("fetchSkill", () => {
	test("happy path: whole dir staged, descriptor written, digest-named", async () => {
		const cache = useCache();
		const ball = await makeTarball({
			"r-main/skills/demo/SKILL.md": "---\nname: demo\ndescription: d\n---\nbody",
			"r-main/skills/demo/scripts/run.sh": "echo hi",
		});
		const fetched = await fetchSkill("https://github.com/o/r/tree/main/skills/demo", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(fetched.descriptor.name).toBe("demo");
		expect(fetched.descriptor.previewed).toBe(false);
		expect(fetched.bodyBytes).toBe(demoBody.length);
		expect(fetched.fileCount).toBe(2);
		expect(fetched.cached).toBe(false);
		// The digest is the cache-identity recipe, not the tarball hash.
		const expected = sha256hex(`${sha256hex(ball)}\0https://github.com/o/r/tree/main/skills/demo`);
		expect(fetched.digest).toBe(expected);
		const digestDir = join(cache, fetched.digest);
		expect(statSync(join(digestDir, "demo", "scripts", "run.sh")).isFile()).toBe(true);
		expect(readDescriptor(digestDir)?.name).toBe("demo");
		// No stray staging dirs left behind.
		expect(readdirSync(cache).every((n) => n === fetched.digest)).toBe(true);
	});

	test("sibling subtrees of one tarball cache apart; equivalent URLs share", async () => {
		const cache = useCache();
		const ball = await makeTarball({
			"r-main/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\nA",
			"r-main/skills/beta/SKILL.md": "---\nname: beta\ndescription: b\n---\nB",
		});
		const alpha = await fetchSkill("https://github.com/o/r/tree/main/skills/alpha", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		const beta = await fetchSkill("https://github.com/o/r/tree/main/skills/beta", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(alpha.digest).not.toBe(beta.digest);
		expect(alpha.descriptor.name).toBe("alpha");
		expect(beta.descriptor.name).toBe("beta");
		expect(readFileSync(alpha.path, "utf8")).toContain("---\nA");
		expect(readFileSync(beta.path, "utf8")).toContain("---\nB");
		// The blob form of the same skill lands in the same cache entry.
		const blobForm = await fetchSkill("https://github.com/o/r/blob/main/skills/alpha/SKILL.md", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(blobForm.digest).toBe(alpha.digest);
		expect(blobForm.path).toBe(alpha.path);
		expect(blobForm.cached).toBe(true);
	});

	test("one fetch per fetchSkill — the extracted body is the bytes fetched", async () => {
		const cache = useCache();
		const ballA = await makeTarball({ "r-main/demo/SKILL.md": `${demoBody}-A` });
		const ballB = await makeTarball({ "r-main/demo/SKILL.md": `${demoBody}-B` });
		let calls = 0;
		const alternating = (async () => {
			calls++;
			return new Response((calls === 1 ? ballA : ballB) as never);
		}) as unknown as typeof fetch;
		const fetched = await fetchSkill(DEMO_URL, { fetchImpl: alternating, cacheRoot: cache });
		expect(calls).toBe(1);
		expect(readFileSync(fetched.path, "utf8")).toContain("body-A");
		expect(fetched.digest).toBe(sha256hex(`${sha256hex(ballA)}\0${DEMO_URL}`));
	});

	test("the archive's own top component wins over the synthesized repo-ref", async () => {
		const cache = useCache();
		// codeload for tag v5.3.0 roots the tree at r-5.3.0 — dots in the
		// version, not the synthesized "r-v5.3.0".
		const ball = await makeTarball({ "r-5.3.0/demo/SKILL.md": demoBody }, "r-5.3.0");
		const fetched = await fetchSkill("https://github.com/o/r/tree/v5.3.0/demo", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(fetched.descriptor.name).toBe("demo");
	});

	test("a repo-root skill extracts under the real top too", async () => {
		const cache = useCache();
		const ball = await makeTarball({
			"r-main/SKILL.md": "---\nname: r\ndescription: root skill\n---\nR",
		});
		const fetched = await fetchSkill("https://github.com/o/r/tree/main", {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		expect(fetched.descriptor.name).toBe("r");
		expect(readFileSync(fetched.path, "utf8")).toContain("---\nR");
	});

	test("name must match the directory", async () => {
		const cache = useCache();
		const ball = await makeTarball({
			"r-main/wrong/SKILL.md": "---\nname: demo\ndescription: d\n---\nbody",
		});
		expect(
			fetchSkill("https://github.com/o/r/tree/main/wrong", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			}),
		).rejects.toThrow("does not match directory");
	});

	test("ordinary support names — spaces, parens, dotdirs, @scope — extract intact", async () => {
		const cache = useCache();
		const ball = await makeTarball({
			"r-main/demo/SKILL.md": demoBody,
			"r-main/demo/scripts/a helper (v1).sh": "echo helper",
			"r-main/demo/.config/default.json": "{}",
			"r-main/demo/@scope/tool.txt": "scoped",
		});
		const fetched = await fetchSkill(DEMO_URL, {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		const dir = fetched.dir;
		expect(readFileSync(join(dir, "scripts", "a helper (v1).sh"), "utf8")).toBe("echo helper");
		expect(readFileSync(join(dir, ".config", "default.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(dir, "@scope", "tool.txt"), "utf8")).toBe("scoped");
	});

	test("missing subtree is an invalid URL error, not a crash", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/other/file.txt": "hi" });
		try {
			await fetchSkill("https://github.com/o/r/tree/main/nope", {
				fetchImpl: tarballFetch(ball),
				cacheRoot: cache,
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("invalid");
			expect((err as SkillFetchError).message).toContain("nope");
		}
	});

	test("404 names the repo and ref", async () => {
		const cache = useCache();
		const fetch404 = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl: fetch404, cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			expect((err as SkillFetchError).message).toContain("o/r@main");
		}
	});

	test("an oversize body is refused before extraction", async () => {
		const big = "x".repeat(BODY_MAX_BYTES + 1);
		const ball = await makeTarball({
			"r-main/demo/SKILL.md": `---\nname: demo\ndescription: d\n---\n${big}`,
		});
		const { err, extracted, cache } = await withSpawnSpy(ball);
		expect(err.status).toBe("oversized");
		expect(extracted).toBe(0);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("an oversized download stream throws SkillFetchError and releases the reader", async () => {
		const cache = useCache();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				c.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl, cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("oversized");
		}
		expect(cancelled).toBe(true);
	});

	test("a malformed archive is a typed invalid, not a crash", async () => {
		const cache = useCache();
		const garbage = new TextEncoder().encode("definitely not a gzip stream".repeat(100));
		try {
			await fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(garbage), cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("invalid");
		}
		// Nothing published, nothing staged.
		expect(readdirSync(cache)).toHaveLength(0);
	});
});

describe("fetchSkill pre-flight refusals", () => {
	test("a highly compressible >10MiB file refuses from the listing, not the disk", async () => {
		const ball = await makeTarball({
			"r-main/demo/SKILL.md": demoBody,
			"r-main/demo/big.bin": "\0".repeat(11 * 1024 * 1024),
		});
		const { err, extracted, cache } = await withSpawnSpy(ball);
		expect(err.status).toBe("oversized");
		// Pre-flight refused: no extraction ran, no payload exists anywhere.
		expect(extracted).toBe(0);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("over 500 selected files refuses before extraction", async () => {
		const files: Record<string, string> = { "r-main/demo/SKILL.md": demoBody };
		for (let i = 0; i < 501; i++) files[`r-main/demo/f${i}.txt`] = "x";
		const ball = await makeTarball(files);
		const { err, extracted, cache } = await withSpawnSpy(ball);
		expect(err.status).toBe("oversized");
		expect(extracted).toBe(0);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("over 500 empty selected directories refuses before extraction", async () => {
		// Empty dirs only — the file cap cannot be the tripwire.
		const emptyDirs: string[] = [];
		for (let i = 0; i <= DIRS_MAX; i++) emptyDirs.push(`r-main/demo/d${i}`);
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody }, "r-main", {
			emptyDirs,
		});
		const { err, extracted, cache } = await withSpawnSpy(ball);
		expect(err.status).toBe("oversized");
		expect(err.message).toContain("directories");
		expect(extracted).toBe(0);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("a traversal member inside the selection refuses before extraction", async () => {
		// --transform rewrites the member name at create time — a real
		// archive whose selected entry climbs out.
		const ball = await makeTarball(
			{ "r-main/demo/SKILL.md": demoBody, "r-main/demo/good.txt": "x" },
			"r-main",
			{ transform: "s|demo/good\\.txt|demo/../escape.txt|" },
		);
		const { err, extracted, cache } = await withSpawnSpy(ball);
		expect(err.status).toBe("invalid");
		expect(extracted).toBe(0);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("a mixed top-level archive refuses — one shared prefix or none", async () => {
		const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
		dirs.push(src);
		mkdirSync(join(src, "r-main/demo"), { recursive: true });
		writeFileSync(join(src, "r-main/demo/SKILL.md"), demoBody);
		mkdirSync(join(src, "othertop"), { recursive: true });
		writeFileSync(join(src, "othertop/evil.txt"), "x");
		const out = mkdtempSync(join(tmpdir(), "goblin-tarball-"));
		dirs.push(out);
		const ballPath = join(out, "ball.tgz");
		const proc = Bun.spawn(["tar", "-czf", ballPath, "r-main", "othertop"], {
			cwd: src,
			stdout: "ignore",
			stderr: "ignore",
		});
		if ((await proc.exited) !== 0) throw new Error("fixture tar failed");
		const ball = await Bun.file(ballPath).bytes();
		const { err, extracted } = await withSpawnSpy(ball);
		expect(err.status).toBe("invalid");
		expect(err.message).toContain("top-level");
		expect(extracted).toBe(0);
	});

	test("a symlink inside the selected subtree is refused before extraction", async () => {
		const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
		dirs.push(src);
		mkdirSync(join(src, "r-main/demo"), { recursive: true });
		writeFileSync(join(src, "r-main/demo/SKILL.md"), demoBody);
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
		const { err, extracted } = await withSpawnSpy(ball);
		expect(err.status).toBe("invalid");
		expect(err.message).toContain("link");
		expect(extracted).toBe(0);
	});

	test("a hardlink inside the selected subtree is refused before extraction", async () => {
		const src = mkdtempSync(join(tmpdir(), "goblin-tarsrc-"));
		dirs.push(src);
		mkdirSync(join(src, "r-main/demo"), { recursive: true });
		writeFileSync(join(src, "r-main/demo/SKILL.md"), demoBody);
		const proc = Bun.spawn([
			"ln",
			join(src, "r-main/demo/SKILL.md"),
			join(src, "r-main/demo/again"),
		]);
		if ((await proc.exited) !== 0) throw new Error("fixture hardlink failed");
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
		const { err, extracted } = await withSpawnSpy(ball);
		expect(err.status).toBe("invalid");
		expect(extracted).toBe(0);
	});

	test("a nested SKILL.md is not the root body", async () => {
		const ball = await makeTarball({
			"r-main/demo/nested/SKILL.md": demoBody,
			"r-main/demo/readme.txt": "x",
		});
		const { err, extracted } = await withSpawnSpy(ball);
		expect(err.status).toBe("invalid");
		expect(err.message).toContain("not found");
		expect(extracted).toBe(0);
	});
});

describe("descriptor integrity", () => {
	test("readDescriptor: missing is null, malformed and schema-bad and ENOTDIR throw", async () => {
		const cache = useCache();
		expect(readDescriptor(join(cache, "absent"))).toBeNull();
		mkdirSync(join(cache, "bad"), { recursive: true });
		writeFileSync(join(cache, "bad", "skill.json"), "{not json");
		expect(() => readDescriptor(join(cache, "bad"))).toThrow(/skill\.json/);
		writeFileSync(join(cache, "bad", "skill.json"), JSON.stringify({ name: 42 }));
		expect(() => readDescriptor(join(cache, "bad"))).toThrow(/skill\.json/);
		// skill.json behind a non-directory path — a real fs error, not absent.
		writeFileSync(join(cache, "filedir"), "x");
		expect(() => readDescriptor(join(cache, "filedir"))).toThrow(/skill\.json|ENOTDIR/);
	});

	test("a published dir without a descriptor fails the cache hit, not a re-extract", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const digest = sha256hex(`${sha256hex(ball)}\0${DEMO_URL}`);
		mkdirSync(join(cache, digest, "demo"), { recursive: true });
		writeFileSync(join(cache, digest, "demo", "SKILL.md"), demoBody);
		let fetches = 0;
		const counting = (async () => {
			fetches++;
			return new Response(ball as never);
		}) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl: counting, cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("invalid");
			expect((err as SkillFetchError).message).toContain("descriptor");
		}
		// The incumbent is untouched — no repair, no re-extract over it.
		expect(readFileSync(join(cache, digest, "demo", "SKILL.md"), "utf8")).toBe(demoBody);
	});

	test("stamping a missing descriptor throws; a stamped verdict flips previewed", async () => {
		const cache = useCache();
		expect(() =>
			stampVerdict(cache, "nosuchdigest", {
				status: "clean",
				injection: 0.1,
				severity: 0.1,
			}),
		).toThrow(/no descriptor/);
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const fetched = await fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache });
		const stamped = stampVerdict(cache, fetched.digest, {
			status: "unavailable",
			injection: null,
			severity: null,
		});
		expect(stamped.previewed).toBe(true);
		expect(stamped.verdict.status).toBe("unavailable");
		expect(readDescriptor(join(cache, fetched.digest))?.previewed).toBe(true);
	});

	test("a stamped verdict is immutable — a later stamp keeps the first", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const fetched = await fetchSkill(DEMO_URL, {
			fetchImpl: tarballFetch(ball),
			cacheRoot: cache,
		});
		const first = stampVerdict(cache, fetched.digest, {
			status: "malicious",
			injection: 0.9,
			severity: 0.9,
		});
		// A second preview's different score must not overwrite what an
		// outstanding confirmation's card showed.
		const second = stampVerdict(cache, fetched.digest, {
			status: "clean",
			injection: 0,
			severity: 0,
		});
		expect(second).toEqual(first);
		expect(second.verdict.status).toBe("malicious");
		expect(readDescriptor(join(cache, fetched.digest))?.verdict.status).toBe("malicious");
	});

	test("a corrupt descriptor after a good publish fails the cache hit, incumbent untouched", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const first = await fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache });
		const digestDir = join(cache, first.digest);
		const descPath = join(digestDir, "skill.json");
		writeFileSync(descPath, "{corrupt");
		try {
			await fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			// Strict readDescriptor throws with the path — not a typed
			// fetch refusal, never a silent re-extract.
			expect((err as Error).message).toContain("skill.json");
		}
		expect(readFileSync(descPath, "utf8")).toBe("{corrupt");
	});

	test("a cache path that is a plain file is a broken cache, not an extract target", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const digest = sha256hex(`${sha256hex(ball)}\0${DEMO_URL}`);
		writeFileSync(join(cache, digest), "not a dir");
		try {
			await fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache });
			expect.unreachable();
		} catch (err) {
			expect((err as SkillFetchError).status).toBe("invalid");
			expect((err as SkillFetchError).message).toContain("broken cache");
		}
		expect(readFileSync(join(cache, digest), "utf8")).toBe("not a dir");
	});

	test("concurrent identical fetches publish once — one incumbent, no staging left", async () => {
		const cache = useCache();
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const [a, b] = await Promise.all([
			fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache }),
			fetchSkill(DEMO_URL, { fetchImpl: tarballFetch(ball), cacheRoot: cache }),
		]);
		expect(a.digest).toBe(b.digest);
		// Exactly one published dir; both callers got a valid descriptor.
		const entries = readdirSync(cache);
		expect(entries).toEqual([a.digest]);
		expect(readDescriptor(join(cache, a.digest))?.name).toBe("demo");
		expect(a.descriptor.name).toBe("demo");
		expect(b.descriptor.name).toBe("demo");
		expect(readFileSync(a.path, "utf8")).toBe(demoBody);
		expect(readFileSync(b.path, "utf8")).toBe(demoBody);
	});
});

describe("download deadline", () => {
	test("headers stalled past the deadline reject unreachable — the signal aborted", async () => {
		const cache = useCache();
		let signal: AbortSignal | undefined;
		const fetchImpl = ((_: unknown, opts?: { signal?: AbortSignal }) => {
			signal = opts?.signal;
			return new Promise<Response>((_res, rej) => {
				signal!.addEventListener("abort", () => rej(signal!.reason));
			});
		}) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl, cacheRoot: cache, downloadTimeoutMs: 50 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("unreachable");
			expect((err as SkillFetchError).message).toContain("deadline");
			expect((err as SkillFetchError).message).toContain("codeload.github.com/o/r");
		}
		expect(signal!.aborted).toBe(true);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("a stalled body settles unreachable — the reader is cancelled", async () => {
		const cache = useCache();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start() {
				// Never enqueues — the deadline must do the settling.
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl, cacheRoot: cache, downloadTimeoutMs: 50 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("unreachable");
		}
		expect(cancelled).toBe(true);
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("a trickling body cannot evade the single deadline", async () => {
		const cache = useCache();
		const stream = new ReadableStream<Uint8Array>({
			async pull(c) {
				await new Promise((r) => setTimeout(r, 20));
				c.enqueue(new Uint8Array(8));
			},
		});
		const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl, cacheRoot: cache, downloadTimeoutMs: 60 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("unreachable");
		}
		expect(readdirSync(cache)).toHaveLength(0);
	});

	test("a mid-body transport error maps to unreachable", async () => {
		const cache = useCache();
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(4));
				c.error(new Error("socket died"));
			},
		});
		const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
		try {
			await fetchSkill(DEMO_URL, { fetchImpl, cacheRoot: cache, downloadTimeoutMs: 5_000 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(SkillFetchError);
			expect((err as SkillFetchError).status).toBe("unreachable");
		}
	});

	test("a completed body is never aborted after the deadline — the timer cleared", async () => {
		const cache = useCache();
		let signal: AbortSignal | undefined;
		const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
		const fetchImpl = ((_: unknown, opts?: { signal?: AbortSignal }) => {
			signal = opts?.signal;
			return Promise.resolve(new Response(ball as never));
		}) as unknown as typeof fetch;
		const fetched = await fetchSkill(DEMO_URL, {
			fetchImpl,
			cacheRoot: cache,
			downloadTimeoutMs: 40,
		});
		expect(fetched.descriptor.name).toBe("demo");
		await new Promise((r) => setTimeout(r, 100));
		expect(signal!.aborted).toBe(false);
	});
});

describe("tar phase deadlines", () => {
	test.each(["-tvzf", "-xzf"] as const)(
		"a hung %s child is killed at the deadline and typed oversized",
		async (flag) => {
			const cache = useCache();
			const ball = await makeTarball({ "r-main/demo/SKILL.md": demoBody });
			const real = Bun.spawn;
			const spawned: Bun.Subprocess[] = [];
			const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], opts: unknown) => {
				if (argv[0] === "tar" && argv.includes(flag)) {
					const proc = real(["sleep", "60"], opts as Parameters<typeof Bun.spawn>[1]);
					spawned.push(proc);
					return proc;
				}
				return (real as (...a: unknown[]) => Bun.Subprocess)(argv, opts);
			}) as never);
			try {
				await fetchSkill(DEMO_URL, {
					fetchImpl: tarballFetch(ball),
					cacheRoot: cache,
					tarTimeoutMs: 100,
				});
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(SkillFetchError);
				const e = err as SkillFetchError;
				expect(e.status).toBe("oversized");
				expect(e.message).toContain(
					flag === "-tvzf" ? "tar listing exceeded" : "tar extraction exceeded",
				);
			} finally {
				spy.mockRestore();
			}
			expect(spawned).toHaveLength(1);
			// The deadline's kill reaped the child — exit collected.
			expect(await spawned[0]!.exited).not.toBe(0);
			expect(readdirSync(cache)).toHaveLength(0);
		},
	);
});
