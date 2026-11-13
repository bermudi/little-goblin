import { readFileSync } from "node:fs";
import { z } from "zod";
import { fetchSkill, SkillFetchError, stampVerdict } from "../agent/skill-fetch.ts";
import { paths } from "../config.ts";
import { checkInjection } from "../injection.ts";
import { log } from "../log.ts";
import { liveStateOf, skillDiskPresence, skillNameSchema } from "../skill-provenance.ts";
import { listSkills, readSkillFile } from "../stateview.ts";
import type { OperatorRequest } from "./operator.ts";
import { fail, json, methodNotAllowed, readBody, SEGMENT_SCHEMA } from "./operator-http.ts";
import type {
	SkillDecideResponse,
	SkillForgetResponse,
	SkillPreviewResponse,
	ThreadSkillItem,
	ThreadSkillsResponse,
} from "./operator-wire.ts";

const REL_PATH_SCHEMA = z
	.string()
	.min(1)
	.max(4096)
	.refine((v) => v.split("/").every((part) => SEGMENT_SCHEMA.safeParse(part).success), {
		error: "invalid relative path",
	});

const conversationBody = z.object({ conversation: z.string().min(1).max(256) });

export async function skillsRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, actor, who, req, tail, url } = r;

	if (tail === "skills") {
		if (req.method !== "GET") return methodNotAllowed();
		return json(listSkills(paths.skills(), paths.skillsProposed()));
	}

	if (tail === "skills/from") {
		if (req.method !== "GET") return methodNotAllowed();
		const sources = deps.skillSources;
		if (sources === undefined) return fail("skill provenance unavailable", 503);
		const conversation = z
			.string()
			.min(1)
			.max(256)
			.safeParse(url.searchParams.get("conversation") ?? "");
		if (!conversation.success) return fail("expected conversation (1-256 chars)", 422);
		const items: ThreadSkillItem[] = sources.forConversation(conversation.data).map((row) => {
			const presence = skillDiskPresence(sources.skillsDir, sources.proposedDir, row.skill);
			return {
				skill: row.skill,
				state: liveStateOf(presence),
				pending: presence.proposed,
				kind: row.kind,
				firstAt: row.firstAt,
				lastAt: row.lastAt,
			};
		});
		log.debug("thread skills served", {
			...who,
			via: actor.via,
			conversation: conversation.data,
			returned: items.length,
		});
		const body: ThreadSkillsResponse = { items };
		return json(body);
	}

	if (tail === "skills/forget-thread") {
		if (req.method !== "POST") return methodNotAllowed();
		if (deps.skillSources === undefined) return fail("skill provenance unavailable", 503);
		const parsed = await readBody(req, conversationBody);
		if (parsed instanceof Response) return parsed;
		const removed = deps.skillSources.forgetConversation(parsed.conversation);
		log.info(`thread skill provenance forgotten via ${actor.via}`, {
			...who,
			conversation: parsed.conversation,
			removed,
		});
		const body: SkillForgetResponse = { ok: true, removed };
		return json(body);
	}

	if (tail === "skills/file") {
		if (req.method !== "GET") return methodNotAllowed();
		const origin = z
			.union([z.literal("skills"), z.literal("proposed")])
			.safeParse(url.searchParams.get("origin") ?? "skills");
		if (!origin.success) return fail("bad origin", 400);
		const name = SEGMENT_SCHEMA.safeParse(url.searchParams.get("name") ?? "");
		if (!name.success) return fail("bad name", 400);
		const rel = REL_PATH_SCHEMA.safeParse(url.searchParams.get("path") ?? "SKILL.md");
		if (!rel.success) return fail("bad path", 400);
		const file = readSkillFile(
			paths.skills(),
			paths.skillsProposed(),
			origin.data,
			name.data,
			rel.data,
		);
		if (file === null) return fail("not found", 404);
		return json(file);
	}

	if (tail === "skills/preview") {
		if (req.method !== "POST") return methodNotAllowed();
		const preview = deps.skillFetch;
		if (preview === undefined) {
			return fail("temp skills unavailable — the System One gate is not wired", 503);
		}
		const parsed = await readBody(
			req,
			z.object({ url: z.string().url().startsWith("https://").max(2048) }),
		);
		if (parsed instanceof Response) return parsed;
		try {
			const fetched = await fetchSkill(parsed.url, {
				...(preview.fetchImpl !== undefined ? { fetchImpl: preview.fetchImpl } : {}),
				...(preview.cacheRoot !== undefined ? { cacheRoot: preview.cacheRoot } : {}),
			});
			// Identical cached bytes keep their first verdict — a
			// re-preview shows what injection will inject, and no second
			// score can move an outstanding confirm's advisory.
			let verdict: SkillPreviewResponse["verdict"];
			if (fetched.descriptor.previewed) {
				verdict = fetched.descriptor.verdict;
			} else {
				// Score exactly the bytes the part will pin: read back
				// from the published copy, never an in-memory
				// intermediate, and no head-cut sampling.
				const body = readFileSync(fetched.path, "utf8");
				const scored = await checkInjection(preview.gate, body, {
					maxChars: body.length,
				});
				verdict = stampVerdict(
					preview.cacheRoot ?? paths.skillcache(),
					fetched.digest,
					scored,
				).verdict;
			}
			const responseBody: SkillPreviewResponse = {
				name: fetched.descriptor.name,
				description: fetched.descriptor.description,
				sourceUrl: fetched.descriptor.sourceUrl,
				path: fetched.path,
				dir: fetched.dir,
				digest: fetched.digest,
				bodyBytes: fetched.bodyBytes,
				fileCount: fetched.fileCount,
				dirBytes: fetched.dirBytes,
				cached: fetched.cached,
				verdict,
			};
			log.info("skill preview served", {
				...who,
				via: actor.via,
				url: parsed.url,
				name: fetched.descriptor.name,
				verdict: verdict.status,
				cached: fetched.cached,
			});
			return json(responseBody);
		} catch (err) {
			if (err instanceof SkillFetchError) {
				const status = err.status === "oversized" ? 413 : err.status === "unreachable" ? 502 : 422;
				return fail(err.message, status);
			}
			throw err;
		}
	}

	if (tail === "skills/decide") {
		if (req.method !== "POST") return methodNotAllowed();
		const decisions = deps.skillDecisions;
		if (decisions === undefined) return fail("skill decisions unavailable", 503);
		const parsed = await readBody(
			req,
			z.object({
				name: skillNameSchema,
				action: z.enum(["install", "discard"]),
			}),
		);
		if (parsed instanceof Response) return parsed;
		const outcome = decisions.decide(parsed.name, parsed.action);
		if (!outcome.ok) {
			return outcome.reason === "gone"
				? fail("proposal not found", 404)
				: fail(outcome.reason, 409);
		}
		log.info("skill proposal decided via operator door", {
			...who,
			via: actor.via,
			skill: parsed.name,
			action: outcome.action,
			...(outcome.action === "install" ? { replaced: outcome.replaced } : {}),
		});
		const body: SkillDecideResponse = {
			ok: true,
			skill: parsed.name,
			action: outcome.action,
			replaced: outcome.action === "install" ? outcome.replaced : false,
			state: outcome.action === "install" ? "installed" : "gone",
		};
		return json(body);
	}

	return null;
}
