// The owning-turn skill body resolver (ruling 2026-10-21,
// design/skills.md → Skill invocation): one function the model view
// calls per data-skill part. Catalog skills read live from the catalog
// (a mid-flight delete degrades to the marker); temp skills read the
// cached copy and refuse injection unless the descriptor carries a
// stamped System One verdict — an unstamped fetch can never reach the
// model. Sync by design: bounded local reads inside an already-async
// view build.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import {
	catalogSkillBodyText,
	isTempSkillRef,
	tempSkillBodyText,
	type CachedSkillDescriptor,
	type SkillRef,
} from "../skill-part.ts";
import { readSkillBody } from "./skills.ts";
import { readDescriptor } from "./skill-fetch.ts";

export function resolveSkillRef(
	ref: SkillRef,
	includeBody = true,
): { name: string; body: string | null } {
	if (!isTempSkillRef(ref)) {
		// Historical invocations resolve the marker name only — the body
		// is never re-read for a non-owning turn.
		if (!includeBody) return { name: ref.name, body: null };
		const found = readSkillBody(paths.skills(), ref.name);
		if (found === null) {
			log.warn("skill body unavailable — not in the catalog", { skill: ref.name });
			return { name: ref.name, body: null };
		}
		return { name: ref.name, body: catalogSkillBodyText(ref.name, found.body) };
	}

	// <cache>/<digest>/<name>/SKILL.md — descriptor one level up.
	const skillDir = dirname(ref.path);
	const digestDir = dirname(skillDir);
	const descriptor: CachedSkillDescriptor | null = readDescriptor(digestDir);
	if (descriptor === null) {
		log.warn("temp skill body unavailable — no readable descriptor", { path: ref.path });
		return { name: "unknown", body: null };
	}
	// The descriptor still names the historical marker — but a
	// non-owning turn gets no body, whatever the verdict was.
	if (!includeBody) return { name: descriptor.name, body: null };
	if (!descriptor.previewed) {
		log.warn("temp skill body refused — verdict never stamped", {
			name: descriptor.name,
			path: ref.path,
		});
		return { name: descriptor.name, body: null };
	}
	let body: string;
	try {
		body = readFileSync(ref.path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log.warn("temp skill body unavailable — cached copy gone", {
				name: descriptor.name,
				path: ref.path,
			});
			return { name: descriptor.name, body: null };
		}
		throw err;
	}
	return {
		name: descriptor.name,
		body: tempSkillBodyText(ref, descriptor, body, skillDir),
	};
}
