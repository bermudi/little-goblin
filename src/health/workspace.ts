import { closeSync, constants, openSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	errno,
	failure,
	ProbeError,
	readBounded,
	result,
	type HealthReport,
	type HealthResult,
} from "./shared.ts";

export function workspace(home: string, phase: HealthReport["phase"]): HealthResult[] {
	return [
		["workspace", "directory", true],
		["state", "directory", true],
		["workspace/skills", "directory", true],
		["workspace/skills-proposed", "directory", true],
		["workspace/attachments", "directory", true],
		["workspace/SOUL.md", "file", true],
		["workspace/AGENTS.md", "file", true],
		["workspace/USER.md", "file", false],
	].map(([name, kind, required]) => {
		const start = performance.now(),
			path = join(home, String(name)),
			scope = `caller-home:${home}`,
			id = `workspace.${String(name).replaceAll("/", ".")}`;
		try {
			if (kind === "file") readBounded(path, 128 * 1024);
			else {
				if (!statSync(path).isDirectory()) throw new ProbeError("not-directory");
				const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
				closeSync(fd);
			}
			return result(id, scope, "pass", `Readable expected ${kind}: ${name}`, start);
		} catch (error) {
			if (errno(error) === "ENOENT")
				return result(
					id,
					scope,
					!required || phase === "preflight" ? "skip" : "fail",
					`${name}: ENOENT; ${!required ? "optional prompt" : phase === "preflight" ? "boot-created layout not yet required" : "required installed layout missing"}`,
					start,
				);
			return failure(id, scope, error, start, `Inspect ${name}`);
		}
	});
}
