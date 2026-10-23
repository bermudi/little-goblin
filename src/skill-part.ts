// The explicit skill-invocation part (ruling 2026-10-21,
// design/skills.md → Skill invocation). A user-message part carrying a
// reference, not content — the note-part precedent. `{ name }` resolves
// against the catalog (manual-only included); `{ url, path }` pins a
// temp skill's server-fetched copy. Store format = wire format: the
// part persists with history; the body rides only the owning turn's
// model view.

import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { paths } from "./config.ts";
import { NAME_RE as SKILL_NAME_RE } from "./agent/skills.ts";

export { SKILL_NAME_RE };

export const SKILL_PART = "data-skill";

// A temp skill's cached copy: the fetch pipeline wrote it, keyed by
// the tarball digest. The wire ref must name that entry's own SKILL.md
// — <cache>/<digest>/<name>/SKILL.md — not merely a file under the
// cache root: a support file is unscored and unbounded by the body
// cap. Resolve before the shape check so absolute paths and `..`
// cannot escape (the attachment gate's precedent).
const DIGEST_RE = /^[0-9a-f]{64}$/;

export function isCachedSkillPath(path: string): boolean {
	const rel = relative(resolve(paths.skillcache()), resolve(path));
	const segs = rel.split(sep);
	return (
		segs.length === 3 &&
		DIGEST_RE.test(segs[0]!) &&
		SKILL_NAME_RE.test(segs[1]!) &&
		segs[1]!.length <= 64 &&
		segs[2] === "SKILL.md"
	);
}

export const skillPartDataSchema = z.union([
	z.object({ name: z.string().regex(SKILL_NAME_RE).max(64) }),
	z.object({
		url: z.string().url().startsWith("https://"),
		path: z.string().min(1).refine(isCachedSkillPath),
	}),
]);

export type CatalogSkillRef = { name: string };
export type TempSkillRef = { url: string; path: string };
export type SkillRef = CatalogSkillRef | TempSkillRef;

export function isTempSkillRef(d: SkillRef): d is TempSkillRef {
	return "url" in d;
}

// The model-view marker — every view shows the invocation happened;
// only the owning turn also gets the body. These strings never enter
// stored history text (the transcript renders the part as a chip), so
// they are free of the machinery-tag namespace on purpose.
export function skillMarkerText(name: string): string {
	return `[skill: ${name}]`;
}

// The temp marker's name comes from the cached descriptor — the part
// itself carries only {url, path}.
export function tempSkillMarkerText(name: string, url: string): string {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		// The wire validated the URL; an unparseable one keeps the full form.
	}
	return `[temp skill: ${name} (${host})]`;
}

// The descriptor the fetch pipeline writes beside the bytes — the
// preview's verdict rides injection from here, so the part stays lean.
export interface CachedSkillDescriptor {
	name: string;
	description: string;
	sourceUrl: string;
	fetchedAt: string;
	/**
	 * True once the preview's injection check ran and the verdict was
	 * stamped (including "unavailable"). Not operator consent — that is
	 * the channel's confirm. Injection refuses unstamped copies.
	 */
	previewed: boolean;
	verdict: {
		status: "clean" | "suspicious" | "malicious" | "unavailable";
		injection: number | null;
		severity: number | null;
	};
}

// Catalog variant: a two-line header keeps the injected body labeled.
export function catalogSkillBodyText(name: string, body: string): string {
	return `The operator explicitly invoked skill "${name}". Its SKILL.md follows — follow it for this request:\n\n${body}`;
}

// Temp variant: un-reviewed text, so the preamble names the source, the
// verdict, and the staged directory the model can reach with its tools.
export function tempSkillBodyText(
	ref: TempSkillRef,
	descriptor: CachedSkillDescriptor,
	body: string,
	dir: string,
): string {
	const v = descriptor.verdict;
	const verdict =
		v.status === "unavailable"
			? "injection check unavailable"
			: `injection check: ${v.status}`;
	return [
		`The operator explicitly invoked a TEMP skill fetched from ${descriptor.sourceUrl}.`,
		`It is NOT installed in the catalog. System One scored it: ${verdict}.`,
		`The whole skill directory is staged at ${dir} — SKILL.md below; its scripts and`,
		`supporting files are reachable there with read_file and bash. Follow it for this request:`,
		"",
		body,
	].join("\n");
}
