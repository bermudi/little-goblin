import { z } from "zod";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { defineTool } from "../../tool.ts";
import { boundedRun, spawnProc, type BoundedProc } from "../../proc.ts";
import { paths } from "../../home-layout.ts";
import { log } from "../../log.ts";
import { skillNameSchema } from "../../skill-provenance.ts";
import { truncatedFooter, trySpill, windowText } from "./truncate.ts";
import { commandBindingFor, commandRuntime } from "./goblin-channel.ts";
import { TOOL_NAMES, policyOf } from "../tool-policy.ts";

const MAX_CAPTURE = 4 * 1024 * 1024;
const OUTPUT_BUDGET = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const COMMAND_SENTENCE = ` Some of Goblin's tools run as commands here: ${TOOL_NAMES.filter((name) => policyOf(name).command).join(", ")}. \`goblin --help\` shows how to call them.`;

export interface SkillWrites {
	dirs: string[];
	conversation: string;
	record(skill: string): void;
}

type Fingerprint = string;

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

function skillSnapshot(dirs: string[]): Map<string, Fingerprint> {
	const snapshot = new Map<string, Fingerprint>();
	dirs.forEach((dir, dirIndex) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (err) {
			if (isMissing(err)) return;
			throw err;
		}
		for (const name of names) {
			if (!skillNameSchema.safeParse(name).success) continue;
			const root = join(dir, name);
			try {
				if (!lstatSync(root).isDirectory()) continue;
			} catch (err) {
				if (isMissing(err)) continue;
				throw err;
			}
			const files: [string, number, number][] = [];
			const walk = (path: string): boolean => {
				let entries: string[];
				try {
					entries = readdirSync(path);
				} catch (err) {
					if (isMissing(err)) return false;
					throw err;
				}
				for (const entry of entries) {
					const abs = join(path, entry);
					let stat;
					try {
						stat = lstatSync(abs);
					} catch (err) {
						if (isMissing(err)) continue;
						throw err;
					}
					if (stat.isSymbolicLink()) continue;
					const rel = relative(root, abs).split(sep).join("/");
					if (stat.isDirectory()) walk(abs);
					else if (stat.isFile()) files.push([rel, stat.size, stat.mtimeMs]);
				}
				return true;
			};
			if (!walk(root)) continue;
			files.sort(([a], [b]) => a.localeCompare(b));
			snapshot.set(`${dirIndex}/${name}`, JSON.stringify(files));
		}
	});
	return snapshot;
}

function recordSkillWrites(
	before: Map<string, Fingerprint>,
	after: Map<string, Fingerprint>,
	writes: SkillWrites,
	toolCallId: string,
): void {
	const names = new Set<string>();
	for (const [key, fingerprint] of after) {
		const previous = before.get(key);
		if (previous === fingerprint) continue;
		if (previous === undefined && key.startsWith("0/")) continue;
		names.add(key.slice(key.indexOf("/") + 1));
	}
	for (const name of names) {
		try {
			writes.record(name);
			log.info("skill write attributed", { conversation: writes.conversation, tool: "bash", toolCallId, skill: name });
		} catch (err) {
			log.error("skill provenance record failed", err, { tool: "bash", toolCallId, skill: name });
		}
	}
}

function skillReadCandidates(command: string, cwd: string): string[] {
	const found = new Set<string>();
	for (const match of command.matchAll(/"([^"]*SKILL\.md)"|'([^']*SKILL\.md)'|[^\s'"`;|&<>()]*SKILL\.md/g)) {
		const candidate = match[1] ?? match[2] ?? match[0];
		const expanded = candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : candidate;
		found.add(resolve(cwd, expanded));
	}
	return [...found];
}

export const bashTool = (
	cwd: string,
	descriptionCwd = cwd,
	hooks: { onRead?: (abs: string) => void; skillWrites?: SkillWrites; commands?: boolean } = {},
) => {
	const commands = hooks.commands === true;
	let bashToolRef: object;
	const tool = defineTool({
		description:
			(descriptionCwd === paths.workspace()
				? "Run a shell command in the deployment workspace — the fixed working directory shared by every conversation. Use `cd` inside the command to work elsewhere. Returns combined stdout/stderr and the exit code. For dependency health checks, run `../doctor --json`; diagnosis does not authorize repairs or restarts. It is also the file tool: read with cat or sed -n, and write or edit with heredocs, sed or a short script."
				: `Run a shell command in this conversation's working directory — the project directory the environment line names. Use \`cd\` inside the command to work elsewhere. Returns combined stdout/stderr and the exit code. For dependency health checks, run \`${paths.doctorShim()} --json\`; diagnosis does not authorize repairs or restarts. It is also the file tool: read with cat or sed -n, and write or edit with heredocs, sed or a short script.`) +
			(commands ? COMMAND_SENTENCE : ""),
		input: z.object({
			command: z.string(),
			timeout_ms: z.number().int().positive().optional(),
		}),
		execute: async ({ command, timeout_ms }, options) => {
			const { abortSignal, toolCallId } = options;
			let before: Map<string, Fingerprint> | undefined;
			try {
				if (hooks.skillWrites !== undefined) before = skillSnapshot(hooks.skillWrites.dirs);
			} catch (err) {
				log.error("skill write snapshot failed", err, { tool: "bash", toolCallId, phase: "before" });
			}
			const binding = commands ? commandBindingFor(bashToolRef) : undefined;
			const nested = commands ? new AbortController() : undefined;
			const forwardAbort = (): void => nested?.abort(abortSignal?.reason);
			if (nested !== undefined && abortSignal?.aborted) forwardAbort();
			else if (nested !== undefined) abortSignal?.addEventListener("abort", forwardAbort, { once: true });
			const runtime = commands
				? commandRuntime({
						tools: binding?.tools ?? {},
						dispatch: binding?.dispatch ?? (() => ({ error: "goblin command dispatch is not bound" })),
						toolCallId,
						...(binding?.conversation === undefined ? {} : { conversation: binding.conversation }),
						...(nested === undefined ? {} : { abortSignal: nested.signal }),
					})
				: undefined;
			let proc: Bun.ReadableSubprocess;
			try {
				proc = spawnProc(
					["/bin/bash", "-c", command],
					cwd,
					undefined,
					"new",
					runtime === undefined
						? undefined
						: (message: unknown, child: Bun.Subprocess) =>
								runtime.handle(message, (reply) => child.send(reply)),
					runtime?.env,
				);
			} catch (err) {
				abortSignal?.removeEventListener("abort", forwardAbort);
				runtime?.close();
				return { error: `spawn failed: ${(err as Error).message}` };
			}
			let result: BoundedProc;
			let finished = false;
			try {
				result = await boundedRun(proc, {
					timeoutMs: Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
					maxOutput: MAX_CAPTURE,
					...(abortSignal ? { abortSignal } : {}),
				});
				finished = !result.timedOut && !result.killed;
			} finally {
				if (!finished) nested?.abort(new Error("bash call was killed or timed out"));
				try {
					if (runtime !== undefined) {
						await runtime.settle();
						proc.disconnect();
						runtime.close();
					}
				} finally {
					abortSignal?.removeEventListener("abort", forwardAbort);
				}
				if (before !== undefined && hooks.skillWrites !== undefined) {
					try {
						recordSkillWrites(before, skillSnapshot(hooks.skillWrites.dirs), hooks.skillWrites, toolCallId);
					} catch (err) {
						log.error("skill write snapshot or record failed", err, { tool: "bash", toolCallId, phase: "after" });
					}
				}
			}
			if (hooks.onRead !== undefined) {
				for (const abs of skillReadCandidates(command, cwd)) {
					try {
						hooks.onRead(abs);
					} catch (err) {
						log.error("skill read record failed", err, { tool: "bash", toolCallId, path: abs });
					}
				}
			}
			const combined = result.stdout + result.stderr;
			let output = combined;
			let truncated = result.truncated;
			if (combined.length > OUTPUT_BUDGET) {
				const window = windowText(combined, OUTPUT_BUDGET, 0.25).window;
				const file = trySpill(paths.bashcache(), combined);
				if (file !== null) {
					log.info("bash output spilled", {
						file,
						chars: combined.length,
						captureCut: result.truncated,
					});
				}
				output = window + truncatedFooter(file, combined.length);
				truncated = true;
			}
			if (result.truncated) {
				output +=
					"\n\n[output exceeded the capture cap or was cut before it finished — the output above and any saved file are incomplete; background processes may still be running]";
			}
			return {
				exit_code: result.timedOut ? null : result.exitCode,
				timed_out: result.timedOut || undefined,
				truncated: truncated || undefined,
				output,
				...(runtime && runtime.outputCalls().length > 0 ? { calls: runtime.outputCalls() } : {}),
			};
		},
	});
	bashToolRef = tool;
	return tool;
};
