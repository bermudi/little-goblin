// The reviewer's staging area — confinement, the private skills-tree
// copy, change attribution, and skills-ref validation. Everything here
// is stateless filesystem mechanics under the staging root
// (workspace/.reviewer-staging/<id>/skills); the queue and the run
// orchestration stay in reviewer.ts, which is the only importer of the
// copy/validate seams (skill-decisions.ts reads stagingRoot for the
// swap-trash rule).

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { editFileTool } from "./agent/tools/edit.ts";
import { readFileTool } from "./agent/tools/read.ts";
import { writeFileTool } from "./agent/tools/write.ts";
import { resolvePath } from "./agent/tools/paths.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

// A skills tree bigger than this is already wrong — skip the review
// (loud) rather than copy it.
const MAX_STAGING_FILES = 512;
const MAX_STAGING_BYTES = 2 * 1024 * 1024;
// Same filesystem as skills-proposed/ so the proposal swap is a real
// rename; dot-prefixed so no catalog scan sees it.
const STAGING_DIRNAME = ".reviewer-staging";

export function stagingRoot(workspaceDir: string): string {
	return join(workspaceDir, STAGING_DIRNAME);
}

// Boot-time hygiene: staging from a killed run is garbage — except
// `.replaced-*` entries, which park the displaced half of a two-rename
// swap. Those are recoverable operator state, not garbage: keep them
// and say so, never delete silently.
export function cleanupStaging(workspaceDir: string): void {
	const root = stagingRoot(workspaceDir);
	let names: string[];
	try {
		names = readdirSync(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const name of names) {
		const path = join(root, name);
		if (name.startsWith(".replaced-")) {
			log.warn("stranded swap backup kept for manual recovery", { path });
			continue;
		}
		rmSync(path, { recursive: true, force: true });
	}
}

// ---------- confinement ----------
//
// Lexical (`..`) first, then real resolution — an existing symlink inside
// the root that points out must not carry a read or write out with it. A
// candidate resolves through its deepest existing ancestor (a
// not-yet-existing tail can't introduce a symlink). TOCTOU on the
// operator's own tree is out of scope; in staging the tree is a fresh
// copy the review is the only writer of.
export function confineTools(tools: ToolSet, root: string): ToolSet {
	const resolved = resolve(root);
	const realRoot = realpathSync(resolved);
	for (const t of Object.values(tools)) {
		const execute = t.execute?.bind(t);
		if (execute === undefined) continue;
		t.execute = (input: unknown, options: ToolExecutionOptions<unknown>) => {
			const path = (input as { path?: unknown } | null)?.path;
			if (typeof path !== "string" || escapesRoot(resolved, realRoot, path)) {
				const shown = typeof path === "string" ? path.slice(0, 200) : "(missing)";
				return Promise.resolve({ error: `path escapes the skills directory: ${shown}` } as never);
			}
			return execute(input as never, options);
		};
	}
	return tools;
}

function escapesRoot(root: string, realRoot: string, path: string): boolean {
	const abs = resolvePath(root, path);
	if (abs !== root && !abs.startsWith(root + sep)) return true;
	return !realUnder(realRoot, abs);
}

// True when `abs` (after resolving symlinks) stays inside `realRoot`.
function realUnder(realRoot: string, abs: string): boolean {
	let dir = dirname(abs);
	let tail = basename(abs);
	for (;;) {
		let real: string;
		try {
			real = realpathSync(dir);
		} catch {
			// Climb to the deepest existing ancestor; at the filesystem
			// root without a match, or anything unreadable, refuse.
			const parent = dirname(dir);
			if (parent === dir) return false;
			tail = join(basename(dir), tail);
			dir = parent;
			continue;
		}
		const realAbs = tail === "" ? real : join(real, tail);
		return realAbs === realRoot || realAbs.startsWith(realRoot + sep);
	}
}

// `written`, when passed, collects the staging-root-relative paths the
// write tools actually wrote — the review's attribution set, for changed
// detection and the log lines. Recorded from each tool's *result* path:
// a refused or failed write reports no path and records nothing.
export function reviewTools(skillsDir: string, written?: Set<string>): ToolSet {
	const tools = confineTools(
		{
			read_file: readFileTool(skillsDir),
			write_file: writeFileTool(skillsDir),
			edit_file: editFileTool(skillsDir),
		},
		skillsDir,
	);
	if (written === undefined) return tools;
	const root = resolve(skillsDir);
	for (const name of ["write_file", "edit_file"] as const) {
		const t = tools[name];
		if (t === undefined) continue;
		const execute = t.execute?.bind(t);
		if (execute === undefined) continue;
		t.execute = async (input: unknown, options: ToolExecutionOptions<unknown>) => {
			const result = await execute(input as never, options);
			const path = (result as { path?: unknown } | null | undefined)?.path;
			if (typeof path === "string") {
				const abs = resolve(path);
				if (abs !== root && abs.startsWith(root + sep)) written.add(relative(root, abs));
			}
			return result;
		};
	}
	return tools;
}

// ---------- staging copy ----------

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// Distinct type so the caller can tell policy from mechanical failure
// and log the true cause.
export class StagingBudgetError extends Error {
	constructor(files: number, bytes: number) {
		super(`skills tree exceeds the staging budget (${files} files / ${bytes} bytes)`);
		this.name = "StagingBudgetError";
	}
}

// Returns path → sha256 of the copy; in-root symlinks are flattened by
// content, out-of-root entries refused. Throws over budget — the caller
// skips the review loud.
export function copySkillsTree(skillsDir: string, stagedDir: string): Map<string, string> {
	const manifest = new Map<string, string>();
	mkdirSync(stagedDir, { recursive: true });
	// A missing live root copies as an empty catalog — first skill ever.
	if (!existsSync(skillsDir)) return manifest;
	const realRoot = realpathSync(skillsDir);
	let bytes = 0;
	const walk = (srcRel: string): void => {
		const srcAbs = srcRel === "." ? skillsDir : join(skillsDir, srcRel);
		for (const dirent of readdirSync(srcAbs, { withFileTypes: true })) {
			const rel = srcRel === "." ? dirent.name : `${srcRel}/${dirent.name}`;
			// Only flatten links whose resolved target stays in the skills
			// tree. Never copy external content into the model's staging area.
			// Broken links and entries vanished mid-walk are logged and skipped.
			const source = join(skillsDir, rel);
			let real: string;
			let stats: Stats;
			try {
				real = realpathSync(source);
				stats = statSync(source);
			} catch (err) {
				log.warn("reviewer staging skipped unresolved skills-tree entry", err, {
					path: rel,
				});
				continue;
			}
			if (real !== realRoot && !real.startsWith(realRoot + sep)) {
				log.warn("reviewer staging skipped out-of-root skills-tree entry", { path: rel });
				continue;
			}
			if (stats.isDirectory()) {
				mkdirSync(join(stagedDir, rel), { recursive: true });
				walk(rel);
			} else if (stats.isFile()) {
				const content = readFileSync(join(skillsDir, rel));
				manifest.set(rel, sha256(content));
				mkdirSync(dirname(join(stagedDir, rel)), { recursive: true });
				writeFileSync(join(stagedDir, rel), content);
				chmodSync(join(stagedDir, rel), stats.mode & 0o777);
				bytes += content.byteLength;
				if (manifest.size > MAX_STAGING_FILES || bytes > MAX_STAGING_BYTES) {
					throw new StagingBudgetError(MAX_STAGING_FILES, MAX_STAGING_BYTES);
				}
			}
		}
	};
	walk(".");
	return manifest;
}

// Written paths that differ from the copied manifest (or are new), plus
// their combined staged size — attribution-scoped to the review's own
// writes.
export function changedPaths(
	stagedDir: string,
	manifest: Map<string, string>,
	written: Set<string>,
): { changed: string[]; bytes: number } {
	const changed: string[] = [];
	let bytes = 0;
	for (const rel of [...written].sort()) {
		const abs = join(stagedDir, rel);
		let stats;
		try {
			stats = statSync(abs);
		} catch {
			// Written, then gone from staging — only the review writes
			// there, so this is a tool lie; don't propose it.
			continue;
		}
		const prev = manifest.get(rel);
		if (prev !== undefined && sha256(readFileSync(abs)) === prev) continue;
		changed.push(rel);
		bytes += stats.size;
	}
	return { changed, bytes };
}

// ---------- validate ----------

interface ValidateOutcome {
	ok: boolean;
	output: string;
}

export async function validateSkill(
	deps: { skillsRefBin?: string },
	cwd: string,
	skill: string,
): Promise<ValidateOutcome> {
	const bin = deps.skillsRefBin ?? "skills-ref";
	let proc: ReturnType<typeof spawnProc>;
	try {
		proc = spawnProc([bin, "validate", `./skills/${skill}`], cwd);
	} catch (err) {
		return { ok: false, output: `cannot run ${bin}: ${(err as Error).message}` };
	}
	const result = await boundedRun(proc, { timeoutMs: 30_000, maxOutput: 64 * 1024 });
	const output = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
	if (result.timedOut) return { ok: false, output: "validation timed out" };
	if (result.exitCode === null) return { ok: false, output: "validation could not be reaped" };
	return result.exitCode === 0
		? { ok: true, output }
		: { ok: false, output: output === "" ? `exit ${result.exitCode}` : output };
}
