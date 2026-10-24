// The owning-turn skill body resolver (ruling 2026-10-21,
// design/skills.md → Skill invocation): one function the model view
// calls per data-skill part. Catalog skills read live from the catalog
// (a mid-flight delete degrades to the marker); temp skills read the
// cached copy and refuse injection unless the descriptor carries a
// stamped System One verdict — an unstamped fetch can never reach the
// model. Sync by design: bounded local reads inside an already-async
// view build.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
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
	let descriptor: CachedSkillDescriptor | null;
	try {
		descriptor = readDescriptor(digestDir);
	} catch (err) {
		// Corrupt is not absent: the fetch path refuses a broken cache,
		// but this is the view path, and the part replays with history —
		// the missing-body ruling wins and the turn never dies for it.
		log.warn("temp skill body unavailable — descriptor unreadable", err, { path: ref.path });
		return { name: "unknown", body: null };
	}
	if (descriptor === null) {
		log.warn("temp skill body unavailable — no readable descriptor", { path: ref.path });
		return { name: "unknown", body: null };
	}
	// The descriptor still names the historical marker — but a
	// non-owning turn gets no body, whatever the verdict was.
	if (!includeBody) return { name: descriptor.name, body: null };
	// The ref must pin this descriptor's own SKILL.md — any other file
	// under the digest dir is an unscored support file (and can be far
	// over the body cap), never the body the operator previewed.
	if (basename(ref.path) !== "SKILL.md" || basename(skillDir) !== descriptor.name) {
		log.warn("temp skill body refused — path is not the descriptor's SKILL.md", {
			name: descriptor.name,
			path: ref.path,
		});
		return { name: descriptor.name, body: null };
	}
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
