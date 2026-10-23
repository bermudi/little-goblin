// Temp-skill fetch pipeline (ruling 2026-10-21, design/skills.md →
// Skill invocation): a GitHub skill URL becomes a validated, whole-dir
// copy under state/skillcache/<digest>/<name>/ — never a catalog
// entry, never a proposal. Cache, not state: deletable without
// ceremony.
//
// The tarball downloads ONCE into a capped buffer; its sha256 plus the
// canonical source URL form the cache identity, so tree/blob/raw forms
// of the same skill share one entry while sibling subtrees do not.
// Before any payload byte is extracted, the archive's own listing is
// pre-flight validated — one safe top-level prefix, canonical paths,
// regular files and dirs only inside the selected subtree, and the
// file/dir/size caps all enforced from declared entries, so a hostile
// or merely huge archive is refused without writing a single payload
// file. The System One injection verdict is scored by the caller (the
// route owns the gate client) and stamped into the descriptor via
// stampVerdict, so the injected preamble quotes what the operator
// confirmed on the preview card.

import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	mkdtempSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { log } from "../log.ts";
import { boundedRun } from "../proc.ts";
import { durableWriteBytes, durableWriteFile } from "../durable.ts";
import { NAME_RE as SKILL_NAME_RE, parseSkill, readHead } from "./skills.ts";
import type { CachedSkillDescriptor } from "../skill-part.ts";
import { paths } from "../config.ts";

// Bounds enforced from the listing BEFORE any extraction write —
// resource refusal is a typed oversized/invalid, never a disk event.
export const BODY_MAX_BYTES = 256 * 1024;
export const DIR_MAX_BYTES = 10 * 1024 * 1024;
export const FILES_MAX = 500;
// Inode-only payloads are still payloads: directories count too.
export const DIRS_MAX = 500;
// The tarball is the whole repo — a one-file subtree still downloads
// all of it — so the download cap must clear real repos, not subtrees.
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
// Listing captures are bounded the same way as the payload caps; a
// hostile archive cannot trade file-count for listing size.
const LISTING_MAX_BYTES = 8 * 1024 * 1024;
const LISTING_ERR_BYTES = 64 * 1024;
// One application deadline covers the whole download — headers and the
// complete streamed body — and each tar subprocess gets its own. A
// trickling response cannot evade a per-chunk timeout by resetting it.
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TAR_TIMEOUT_MS = 60_000;

// GitHub URL forms (verified against anthropics/skills):
//   github.com/{o}/{r}/tree/{ref}/{dir}             directory
//   github.com/{o}/{r}/blob/{ref}/{path}            file — its parent dir wins
//   github.com/{o}/{r}[/tree/{ref}]                 repo-root skill
//   raw.githubusercontent.com/{o}/{r}/{ref}/{path}  file — parent dir wins
// A slash-bearing ref is ambiguous with the dir path in these URL
// shapes (GitHub disambiguates server-side); we take the first segment
// as the ref, and the tarball 404 names the refusal.
export interface GithubSkillSource {
	owner: string;
	repo: string;
	ref: string;
	/** Directory inside the repo; "" is the repo root. */
	dir: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const safeSegment = (p: string): boolean => p !== "." && p !== ".." && SEGMENT_RE.test(p);

function cleanSegments(path: string): string[] | null {
	const parts = path.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.some((p) => p === ".." || !SEGMENT_RE.test(p))) return null;
	return parts;
}

export function normalizeGithubSkillUrl(raw: string): GithubSkillSource | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	const head = url.pathname.split("#")[0]!.split("?")[0]!;
	const segments = cleanSegments(head);
	if (segments === null || segments.length < 2) return null;
	const [owner, repo] = segments as [string, string];
	const rest = segments.slice(2);

	if (url.host === "github.com") {
		if (rest.length === 0) return { owner, repo, ref: "HEAD", dir: "" };
		const [kind, ref, ...dirParts] = rest;
		if (kind !== "tree" && kind !== "blob") return null;
		if (ref === undefined || !SEGMENT_RE.test(ref)) return null;
		// blob names a file: the skill dir is its parent. tree names the
		// dir itself — but a SKILL.md leaf under tree takes the parent
		// too (GitHub redirects it; operators paste what the browser
		// showed them).
		let dirRest = dirParts;
		if (kind === "blob" || dirParts.at(-1)?.toLowerCase() === "skill.md") {
			if (dirParts.length === 0) return null;
			dirRest = dirParts.slice(0, -1);
		}
		if (dirRest.some((p) => !SEGMENT_RE.test(p))) return null;
		return { owner, repo, ref, dir: dirRest.join("/") };
	}
	if (url.host === "raw.githubusercontent.com") {
		const [ref, ...pathParts] = rest;
		if (ref === undefined || !SEGMENT_RE.test(ref)) return null;
		if (pathParts.length === 0) return null;
		const dirParts = pathParts.slice(0, -1);
		if (dirParts.some((p) => !SEGMENT_RE.test(p))) return null;
		return { owner, repo, ref, dir: dirParts.join("/") };
	}
	return null;
}

export interface FetchedSkill {
	descriptor: CachedSkillDescriptor;
	/** Absolute path of the cached SKILL.md — the part pins this. */
	path: string;
	/** Absolute path of the cached skill dir — the injected preamble names it. */
	dir: string;
	bodyBytes: number;
	fileCount: number;
	dirBytes: number;
	/**
	 * Cache identity — sha256(archiveDigest + "\0" + canonical source
	 * URL). Equivalent URL forms share it; different subtrees of one
	 * tarball do not.
	 */
	digest: string;
	cached: boolean;
}

export interface SkillFetchDeps {
	fetchImpl?: typeof fetch;
	/** Overrides state/skillcache — tests only. */
	cacheRoot?: string;
	now?: () => Date;
	/** Download (fetch + body) deadline override — tests only. */
	downloadTimeoutMs?: number;
	/** tar listing/extraction deadline override — tests only. */
	tarTimeoutMs?: number;
}

export class SkillFetchError extends Error {
	constructor(
		message: string,
		readonly status: "unreachable" | "unsupported" | "invalid" | "oversized",
	) {
		super(message);
	}
}

function canonicalSourceUrl(s: GithubSkillSource): string {
	return `https://github.com/${s.owner}/${s.repo}/tree/${s.ref}${s.dir === "" ? "" : `/${s.dir}`}`;
}

function sha256hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function fetchSkill(rawUrl: string, deps: SkillFetchDeps = {}): Promise<FetchedSkill> {
	const started = Date.now();
	const source = normalizeGithubSkillUrl(rawUrl);
	if (source === null) {
		throw new SkillFetchError(
			"not a recognized GitHub skill URL (tree, blob, raw, or repo root)",
			"unsupported",
		);
	}
	const cacheRoot = deps.cacheRoot ?? paths.skillcache();
	const fetchImpl = deps.fetchImpl ?? fetch;
	const now = deps.now ?? (() => new Date());
	mkdirSync(cacheRoot, { recursive: true });

	// One download serves both the identity digest and the extraction —
	// never a second fetch that could race a changed upstream.
	const bytes = await download(source, fetchImpl, deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
	const archiveDigest = sha256hex(bytes);
	const digest = sha256hex(`${archiveDigest}\0${canonicalSourceUrl(source)}`);
	const finalDir = join(cacheRoot, digest);

	const incumbentStat = statSyncOrNull(finalDir);
	if (incumbentStat != null && !incumbentStat.isDirectory()) {
		throw new SkillFetchError(
			`cache entry ${finalDir} is not a directory — broken cache`,
			"invalid",
		);
	}
	if (incumbentStat?.isDirectory() === true) {
		// A published dir without a descriptor is a broken cache —
		// fail loud, never re-extract over it or patch the incumbent.
		const descriptor = readDescriptor(finalDir);
		if (descriptor === null) {
			throw new SkillFetchError(
				`cached skill at ${finalDir} has no descriptor — refusing to serve it`,
				"invalid",
			);
		}
		const dir = join(finalDir, descriptor.name);
		const walked = rewalk(dir);
		log.info("skill fetched", {
			url: rawUrl,
			digest,
			name: descriptor.name,
			bodyBytes: walked.bodyBytes,
			cached: true,
			ms: Date.now() - started,
		});
		return { descriptor, path: join(dir, "SKILL.md"), dir, cached: true, ...walked, digest };
	}

	// stagingRoot is ours from birth to death — the finally owns it on
	// success, publish races, and every refusal. The incumbent cache
	// dir is never touched by a loser.
	const stagingRoot = mkdtempSync(join(cacheRoot, ".fetch-"));
	try {
		const extracted = await extract(
			source,
			bytes,
			stagingRoot,
			now,
			deps.tarTimeoutMs ?? TAR_TIMEOUT_MS,
		);
		let descriptor = extracted.descriptor;
		let walked: Walked = {
			bodyBytes: extracted.bodyBytes,
			fileCount: extracted.fileCount,
			dirBytes: extracted.dirBytes,
		};
		let dir = join(finalDir, extracted.name);
		let raced = false;
		try {
			renameSync(extracted.publishDir, finalDir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
			// Lost a publish race — the incumbent wins. Re-read and
			// validate IT; never fall back to the copy we extracted.
			raced = true;
			const incumbent = readDescriptor(finalDir);
			if (incumbent === null) {
				throw new SkillFetchError(
					`publish race lost to a descriptor-less cache at ${finalDir}`,
					"invalid",
				);
			}
			descriptor = incumbent;
			dir = join(finalDir, incumbent.name);
			walked = rewalk(dir);
		}
		log.info("skill fetched", {
			url: rawUrl,
			digest,
			name: descriptor.name,
			bodyBytes: walked.bodyBytes,
			dirBytes: walked.dirBytes,
			files: walked.fileCount,
			cached: raced,
			ms: Date.now() - started,
		});
		return {
			descriptor,
			path: join(dir, "SKILL.md"),
			dir,
			...walked,
			digest,
			cached: raced,
		};
	} finally {
		cachedCleanup(stagingRoot);
	}
}

// Stamp the preview's System One verdict onto the cached copy, before
// the card renders — previewed flips true even when status is
// "unavailable": the check ran (consent is the channel's confirm, not
// this stamp). The descriptor is the only place the verdict lives —
// the part carries just {url, path}, and injection reads what the
// operator saw. The stamp is immutable: identical cached bytes keep
// their first verdict, so a later preview can never change what an
// outstanding confirmation's card showed — the fresh score drops.
export function stampVerdict(
	cacheRoot: string,
	digest: string,
	verdict: CachedSkillDescriptor["verdict"],
): CachedSkillDescriptor {
	const dir = join(cacheRoot, digest);
	const existing = readDescriptor(dir);
	if (existing === null) {
		throw new Error(`cannot stamp a verdict — no descriptor at ${dir}/skill.json`);
	}
	if (existing.previewed) {
		log.info("skill verdict already stamped — the first verdict stands", {
			digest,
			kept: existing.verdict.status,
			dropped: verdict.status,
		});
		return existing;
	}
	const stamped: CachedSkillDescriptor = {
		...existing,
		previewed: true,
		verdict: {
			status: verdict.status,
			injection: verdict.injection,
			severity: verdict.severity,
		},
	};
	durableWriteFile(join(dir, "skill.json"), JSON.stringify(stamped, null, "\t"));
	return stamped;
}

const descriptorSchema = z.object({
	name: z.string().regex(SKILL_NAME_RE).max(64),
	description: z.string(),
	sourceUrl: z.string(),
	fetchedAt: z.string(),
	// Older records predate the flag — default false fails closed
	// (unstamped), matching an unreadable descriptor.
	previewed: z.boolean().default(false),
	verdict: z.object({
		status: z.enum(["clean", "suspicious", "malicious", "unavailable"]),
		injection: z.number().nullable(),
		severity: z.number().nullable(),
	}),
});

// null ONLY when the file is absent. Malformed JSON, a schema
// violation, or any other fs failure throws with the path — a
// corrupt descriptor is a broken cache, not a cache miss.
export function readDescriptor(dir: string): CachedSkillDescriptor | null {
	const file = join(dir, "skill.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`skill descriptor unreadable at ${file}: ${stringify(err)}`, {
			cause: err,
		});
	}
	const parsed = descriptorSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`skill descriptor invalid at ${file}: ${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}

async function download(
	source: GithubSkillSource,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<Uint8Array> {
	const tarballUrl = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
	// One deadline for headers AND the complete body: the controller
	// aborts the fetch and (via the reader wiring in sizeCapped)
	// cancels the body stream — a ReadableStream that ignores fetch's
	// signal still settles.
	const controller = new AbortController();
	const deadline = new SkillFetchError(
		`tarball download exceeded the ${timeoutMs}ms deadline for ${tarballUrl}`,
		"unreachable",
	);
	const timer = setTimeout(() => controller.abort(deadline), timeoutMs);
	try {
		let response: Response;
		try {
			response = await fetchImpl(tarballUrl, {
				redirect: "follow",
				signal: controller.signal,
			});
		} catch (err) {
			if (controller.signal.aborted) throw deadline;
			throw new SkillFetchError(`tarball fetch failed: ${stringify(err)}`, "unreachable");
		}
		if (!response.ok) {
			throw new SkillFetchError(
				`tarball fetch returned ${response.status} for ${source.owner}/${source.repo}@${source.ref}` +
					(source.ref.includes("/")
						? " (slash-bearing refs are ambiguous in tree/blob URLs — paste the raw.githubusercontent form)"
						: ""),
				response.status === 404 ? "invalid" : "unreachable",
			);
		}
		return await sizeCapped(response, DOWNLOAD_MAX_BYTES, controller.signal, deadline);
	} catch (err) {
		if (err instanceof SkillFetchError) {
			log.warn("skill download rejected", { url: tarballUrl, reason: err.message });
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// GNU tar's verbose listing, pinned by env LC_ALL=C + TAR_OPTIONS="":
//   -rw-r--r-- 1000/1001      8587 2026-10-21 17:51:18 repo-5.3.0/SKILL.md
//   drwxr-xr-x 1000/1001         0 2026-10-21 17:51:18 repo-5.3.0/demo/
// Links carry " -> target" / " link to target" suffixes; anything the
// shape doesn't describe is a typed invalid, never a guess.
const TAR_ENV = { ...process.env, LC_ALL: "C", TAR_OPTIONS: "" };
const LISTING_RE =
	/^([bcdhlpsS-])[rwxStTs-]{9}\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(.+)$/;

interface TarEntry {
	kind: "file" | "dir" | "link" | "other";
	path: string;
	size: number;
}

function parseListing(text: string): TarEntry[] {
	const entries: TarEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const m = LISTING_RE.exec(line);
		if (m === null) {
			throw new SkillFetchError(`unrecognized tar listing line: ${line.slice(0, 120)}`, "invalid");
		}
		const size = Number(m[2]);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new SkillFetchError(`tar listing size out of range: ${m[2]}`, "invalid");
		}
		let raw = m[3]!;
		let link = m[1] === "l" || m[1] === "h";
		const arrow = raw.indexOf(" -> ");
		const linkTo = raw.indexOf(" link to ");
		if (arrow !== -1) {
			raw = raw.slice(0, arrow);
			link = true;
		} else if (linkTo !== -1) {
			raw = raw.slice(0, linkTo);
			link = true;
		}
		const kind: TarEntry["kind"] = link
			? "link"
			: m[1] === "d"
				? "dir"
				: m[1] === "-"
					? "file"
					: "other";
		entries.push({ kind, path: raw, size });
	}
	return entries;
}

// List the archive before a single payload byte is written: discover
// the real top-level prefix (never the synthesized repo-ref), require
// canonical paths inside the selected subtree, and count declared
// sizes against the resource caps. The extraction command runs only
// on success. detached:new-group so boundedRun's kill takes the whole
// group; the deadline is the listing's own.
async function listEntries(ballPath: string, timeoutMs: number): Promise<TarEntry[]> {
	const tar = Bun.spawn(
		["tar", "-tvzf", ballPath, "--numeric-owner", "--full-time", "--quoting-style=escape"],
		{ stdout: "pipe", stderr: "pipe", env: TAR_ENV, detached: true },
	);
	const r = await boundedRun(tar, { timeoutMs, maxOutput: LISTING_MAX_BYTES });
	if (r.timedOut) {
		throw new SkillFetchError(`tar listing exceeded the ${timeoutMs}ms deadline`, "oversized");
	}
	if (r.truncated || r.killed || r.exitCode === null) {
		throw new SkillFetchError(
			`tar listing output exceeds the ${LISTING_MAX_BYTES}-byte cap`,
			"oversized",
		);
	}
	if (r.exitCode !== 0) {
		throw new SkillFetchError(
			`tar listing failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 200)}`,
			"invalid",
		);
	}
	return parseListing(r.stdout);
}

interface Preflight {
	/** The real top-level component the archive names — never synthesized. */
	prefix: string;
	/** prefix + optional /dir — the extraction member. */
	member: string;
	declaredSkillBytes: number;
	declaredFiles: number;
	declaredDirs: number;
	declaredDirBytes: number;
}

function preflight(entries: TarEntry[], source: GithubSkillSource): Preflight {
	if (entries.length === 0) {
		throw new SkillFetchError("tarball lists no entries", "invalid");
	}
	// One safe common top-level prefix across every entry — codeload's
	// shape, and the only shape a member extraction can anchor.
	let prefix: string | null = null;
	for (const e of entries) {
		if (e.path.startsWith("/")) {
			throw new SkillFetchError(`absolute path in tarball: ${e.path.slice(0, 80)}`, "invalid");
		}
		const top = e.path.split("/")[0]!;
		if (!safeSegment(top)) {
			throw new SkillFetchError(
				`unsafe top-level entry in tarball: ${top.slice(0, 80)}`,
				"invalid",
			);
		}
		if (prefix === null) prefix = top;
		else if (prefix !== top) {
			throw new SkillFetchError(
				`tarball mixes top-level prefixes (${prefix} vs ${top})`,
				"invalid",
			);
		}
	}
	const member = prefix! + (source.dir === "" ? "" : `/${source.dir}`);

	let declaredSkillBytes = 0;
	let declaredFiles = 0;
	let declaredDirs = 0;
	let declaredDirBytes = 0;
	let sawSkillMd = false;
	for (const e of entries) {
		let path = e.path;
		if (e.kind === "dir" && path.endsWith("/")) path = path.slice(0, -1);
		if (path !== member && !path.startsWith(member + "/")) continue;
		// Selected descendants: canonical paths only — the safety bar is
		// traversal and ambiguity (empty/dot/dotdot segments, control
		// bytes, and the backslash escapes the listing hides them
		// behind), NOT the URL's name rule. Support files legitimately
		// carry spaces, parens and dots. The member root itself has no
		// relative segments.
		if (path !== member) {
			const rel = path.slice(member.length + 1);
			for (const seg of rel.split("/")) {
				if (seg === "" || seg === "." || seg === ".." || /[\x00-\x1f\x7f\\]/.test(seg)) {
					throw new SkillFetchError(
						`unsafe path in selected skill: ${path.slice(0, 120)}`,
						"invalid",
					);
				}
			}
		}
		if (e.kind === "link") {
			throw new SkillFetchError(`link inside selected skill: ${path.slice(0, 120)}`, "invalid");
		}
		if (e.kind === "other") {
			throw new SkillFetchError(
				`special entry inside selected skill: ${path.slice(0, 120)}`,
				"invalid",
			);
		}
		if (e.kind === "dir") {
			// Every occurrence counts — a duplicated name pays twice.
			declaredDirs++;
			if (declaredDirs > DIRS_MAX) {
				throw new SkillFetchError(`skill has over ${DIRS_MAX} directories`, "oversized");
			}
			continue;
		}
		declaredFiles++;
		declaredDirBytes += e.size;
		if (declaredFiles > FILES_MAX) {
			throw new SkillFetchError(`skill has over ${FILES_MAX} files`, "oversized");
		}
		if (declaredDirBytes > DIR_MAX_BYTES) {
			throw new SkillFetchError(`skill dir is over ${DIR_MAX_BYTES} bytes`, "oversized");
		}
		if (path === `${member}/SKILL.md`) {
			sawSkillMd = true;
			declaredSkillBytes = e.size;
			if (e.size > BODY_MAX_BYTES) {
				throw new SkillFetchError(
					`SKILL.md is ${e.size} bytes — over the ${BODY_MAX_BYTES} temp-skill cap`,
					"oversized",
				);
			}
		}
	}
	if (!sawSkillMd) {
		throw new SkillFetchError(
			`skill directory ${source.dir === "" ? "(repo root)" : source.dir} not found in ${source.owner}/${source.repo}@${source.ref}`,
			"invalid",
		);
	}
	return {
		prefix: prefix!,
		member,
		declaredSkillBytes,
		declaredFiles,
		declaredDirs,
		declaredDirBytes,
	};
}

async function extract(
	source: GithubSkillSource,
	bytes: Uint8Array,
	stagingRoot: string,
	now: () => Date,
	tarTimeoutMs: number,
): Promise<
	{
		publishDir: string;
		descriptor: CachedSkillDescriptor;
		name: string;
	} & Walked
> {
	const tarballUrl = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
	try {
		const ballPath = join(stagingRoot, "ball.tgz");
		durableWriteBytes(ballPath, bytes);

		// Pre-flight: the archive's own listing decides whether a single
		// payload byte is ever written.
		const entries = await listEntries(ballPath, tarTimeoutMs);
		const flight = preflight(entries, source);

		const extractDir = join(stagingRoot, "x");
		mkdirSync(extractDir);
		const tar = Bun.spawn(
			[
				"tar",
				"-xzf",
				ballPath,
				"-C",
				extractDir,
				"--no-same-owner",
				"--no-same-permissions",
				"--no-wildcards",
				"--anchored",
				"--",
				flight.member,
			],
			{ stdout: "pipe", stderr: "pipe", env: TAR_ENV, detached: true },
		);
		const run = await boundedRun(tar, { timeoutMs: tarTimeoutMs, maxOutput: LISTING_ERR_BYTES });
		if (run.timedOut) {
			throw new SkillFetchError(
				`tar extraction exceeded the ${tarTimeoutMs}ms deadline`,
				"oversized",
			);
		}
		if (run.truncated || run.killed || run.exitCode === null) {
			throw new SkillFetchError(
				`tar extraction output exceeds the ${LISTING_ERR_BYTES}-byte cap`,
				"oversized",
			);
		}
		const stderr = run.stderr;
		if (run.exitCode !== 0) {
			throw new SkillFetchError(
				`skill directory ${source.dir === "" ? "(repo root)" : source.dir} not found in ${source.owner}/${source.repo}@${source.ref}` +
					(stderr.trim() ? ` (tar: ${stderr.trim().slice(0, 200)})` : ""),
				"invalid",
			);
		}

		const subtree = realpathSync(
			join(extractDir, flight.prefix, source.dir === "" ? "." : source.dir),
		);
		const realRoot = realpathSync(extractDir);
		if (!subtree.startsWith(realRoot + "/")) {
			throw new SkillFetchError("extracted skill dir escaped the extraction root", "invalid");
		}
		const walked = walkSubtree(subtree);

		const skillMd = join(subtree, "SKILL.md");
		const parsed = parseSkill(readHead(skillMd));
		if ("err" in parsed) {
			throw new SkillFetchError(`invalid SKILL.md frontmatter: ${parsed.err}`, "invalid");
		}
		// Spec rule: the name matches the directory — for a repo-root
		// skill, the repo itself is that directory.
		const expectedName = source.dir === "" ? source.repo : basename(source.dir);
		if (parsed.fm.name !== expectedName) {
			throw new SkillFetchError(
				`skill name "${parsed.fm.name}" does not match directory "${expectedName}"`,
				"invalid",
			);
		}

		// Publish layout: <staging>/publish/<name>/** + skill.json beside
		// it — the whole publish dir renames to <cache>/<digest>.
		const publishDir = join(stagingRoot, "publish");
		mkdirSync(publishDir);
		renameSync(subtree, join(publishDir, parsed.fm.name));
		rmSync(extractDir, { recursive: true, force: true });
		const descriptor: CachedSkillDescriptor = {
			name: parsed.fm.name,
			description: parsed.fm.description,
			sourceUrl: canonicalSourceUrl(source),
			fetchedAt: now().toISOString(),
			// The route scores and stamps after validation; previewed
			// stays false until the verdict stamp lands.
			previewed: false,
			verdict: { status: "unavailable", injection: null, severity: null },
		};
		durableWriteFile(join(publishDir, "skill.json"), JSON.stringify(descriptor, null, "\t"));
		return { publishDir, descriptor, name: parsed.fm.name, ...walked };
	} catch (err) {
		if (err instanceof SkillFetchError) {
			log.warn("skill fetch rejected", { url: tarballUrl, reason: err.message });
		}
		throw err;
	}
}

interface Walked {
	bodyBytes: number;
	fileCount: number;
	dirBytes: number;
}

// Re-read a published dir for the cached=true path — same bounds, so a
// tampered-with cache fails loudly instead of injecting oversize bytes.
function rewalk(dir: string): Walked {
	const walked = walkSubtree(realpathSync(dir));
	if (
		walked.bodyBytes > BODY_MAX_BYTES ||
		walked.fileCount > FILES_MAX ||
		walked.dirBytes > DIR_MAX_BYTES
	) {
		throw new SkillFetchError("cached skill no longer within caps", "oversized");
	}
	return walked;
}

// Regular files and real directories only — a symlink (or worse) inside
// a fetched skill is refused, matching the catalog's links-are-
// second-class rule; the staging move must not carry links anywhere.
// Post-extraction defense in depth — pre-flight already refused links
// and specials from the listing.
function walkSubtree(root: string): Walked {
	const rootMd = join(root, "SKILL.md");
	let bodyBytes = 0;
	let fileCount = 0;
	let dirBytes = 0;
	const visit = (path: string): void => {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			throw new SkillFetchError(`symlink inside fetched skill: ${basename(path)}`, "invalid");
		}
		if (stats.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry));
			return;
		}
		if (!stats.isFile()) {
			throw new SkillFetchError(
				`non-regular file inside fetched skill: ${basename(path)}`,
				"invalid",
			);
		}
		fileCount++;
		dirBytes += stats.size;
		if (fileCount > FILES_MAX) {
			throw new SkillFetchError(`skill has over ${FILES_MAX} files`, "oversized");
		}
		if (dirBytes > DIR_MAX_BYTES) {
			throw new SkillFetchError(`skill dir is over ${DIR_MAX_BYTES} bytes`, "oversized");
		}
		// The root SKILL.md only — a nested same-named file is not the body.
		if (path === rootMd) bodyBytes = stats.size;
	};
	visit(root);
	if (bodyBytes === 0) throw new SkillFetchError("no SKILL.md in the skill directory", "invalid");
	return { bodyBytes, fileCount, dirBytes };
}

async function sizeCapped(
	response: Response,
	cap: number,
	signal: AbortSignal,
	deadline: SkillFetchError,
): Promise<Uint8Array> {
	const body = response.body;
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	// A plain ReadableStream ignores fetch's signal — the abort listener
	// cancels the reader directly so a stalled body still settles the
	// pending read. Cancel cleanup is never awaited: a slow or failed
	// cancel is logged, never allowed to replace the typed deadline.
	const onAbort = () => {
		void reader.cancel(signal.reason).catch((err: unknown) => {
			log.warn("skill download body cancel failed", { error: stringify(err) });
		});
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let done: boolean;
			let value: Uint8Array | undefined;
			try {
				({ done, value } = await reader.read());
			} catch (err) {
				if (signal.aborted) throw deadline;
				throw new SkillFetchError(`tarball body read failed: ${stringify(err)}`, "unreachable");
			}
			if (signal.aborted) throw deadline;
			if (done) break;
			total += value!.byteLength;
			if (total > cap) {
				throw new SkillFetchError(`download exceeds the ${cap}-byte cap`, "oversized");
			}
			chunks.push(value!);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		// Any early exit leaves buffered bytes behind — release them.
		void reader.cancel().catch((err: unknown) => {
			log.warn("skill download body cancel failed", { error: stringify(err) });
		});
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function statSyncOrNull(path: string): ReturnType<typeof statSync> | null {
	try {
		return statSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

function cachedCleanup(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (err) {
		log.warn("skill fetch staging cleanup failed", { path, error: stringify(err) });
	}
}

function stringify(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
