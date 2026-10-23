import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import {
	INLINE_ITEM_MAX_BYTES,
	type MediaPosition,
	materializeAttachments,
} from "../agent/attachments.ts";
import { log } from "../log.ts";
import { messageText, type RecallContext, withMemoryBlocks } from "../memory/mod.ts";
import { NOTE_PART, noteFence, notePartDataSchema } from "../notes.ts";
import {
	SKILL_PART,
	isTempSkillRef,
	skillMarkerText,
	skillPartDataSchema,
	tempSkillMarkerText,
	type SkillRef,
} from "../skill-part.ts";

export interface ViewContext {
	convId: string;
	tools: ToolSet;
	modalities: Set<string> | undefined;
	carries: (mediaType: string, position: MediaPosition) => boolean;
	/**
	 * Resolves an invocation: the display name (the descriptor's, for a
	 * temp skill) and the injected body — preamble plus SKILL.md — or
	 * null when the body cannot ride (skill deleted, temp verdict
	 * unstamped). includeBody=false resolves the marker name only, never
	 * reading the body — historical invocations stay markers. The
	 * resolver owns refusal logging; the view logs the actual injection.
	 */
	skillRef: (ref: SkillRef, includeBody: boolean) => { name: string; body: string | null };
}

function unconvertiblePlaceholder(m: UIMessage): UIMessage {
	return {
		id: m.id,
		role: m.role,
		parts: [
			{
				type: "text",
				text: `[this message could not be prepared for the model (${m.role} role) — it is kept in history; any attachment it carried may still be readable with read_file or bash tools]`,
			},
		],
	};
}

function systemEventAsUser(m: UIMessage): UIMessage {
	return {
		id: m.id,
		role: "user",
		parts: [{ type: "text", text: `[system event: ${messageText(m)}]` }],
	};
}

function notePartsAsText(ctx: ViewContext, m: UIMessage): UIMessage {
	if (!m.parts.some((p) => p.type === NOTE_PART)) return m;
	return {
		...m,
		parts: m.parts.map((p) => {
			if (p.type !== NOTE_PART) return p;
			const parsed = notePartDataSchema.safeParse((p as { data?: unknown }).data);
			if (!parsed.success) {
				log.warn("malformed note part — degrading to placeholder", {
					conversation: ctx.convId,
					message: m.id,
				});
				return {
					type: "text" as const,
					text: "[an attached note could not be rendered — its stored data was malformed]",
				};
			}
			const d = parsed.data;
			const title = d.title.replace(/"/g, "'");
			return {
				type: "text" as const,
				text: `Attached note "${title}" (id ${d.id}, rev ${d.rev} as of this message):\n${noteFence(d)}`,
			};
		}),
	};
}

// Skill invocation parts render as markers in every model view
// (ruling 2026-10-21); the body rides only the owning turn's output —
// the caller appends what resolveBodies returns for owned refs.
// Malformed data degrades to a placeholder like notes.
function skillPartsAsText(
	ctx: ViewContext,
	m: UIMessage,
	includeBody: boolean,
): { message: UIMessage; invocations: SkillInvocation[] } {
	if (!m.parts.some((p) => p.type === SKILL_PART)) return { message: m, invocations: [] };
	const invocations: SkillInvocation[] = [];
	const message: UIMessage = {
		...m,
		parts: m.parts.map((p) => {
			if (p.type !== SKILL_PART) return p;
			const parsed = skillPartDataSchema.safeParse((p as { data?: unknown }).data);
			if (!parsed.success) {
				log.warn("malformed skill part — degrading to placeholder", {
					conversation: ctx.convId,
					message: m.id,
				});
				return {
					type: "text" as const,
					text: "[a skill invocation could not be rendered — its stored data was malformed]",
				};
			}
			const resolved = ctx.skillRef(parsed.data, includeBody);
			invocations.push({ ...resolved, ref: parsed.data });
			return {
				type: "text" as const,
				text: isTempSkillRef(parsed.data)
					? tempSkillMarkerText(resolved.name, parsed.data.url)
					: skillMarkerText(resolved.name),
			};
		}),
	};
	return { message, invocations };
}

interface SkillInvocation {
	name: string;
	body: string | null;
	ref: SkillRef;
}

// Mirrors convertToModelMessages' ignoreIncompleteToolCalls keep-set — if the SDK's set changes, this must follow or the drop log drifts.
export function incompleteToolCallIds(m: UIMessage): string[] {
	const ids: string[] = [];
	for (const p of m.parts) {
		if (!p.type.startsWith("tool-")) continue;
		const tool = p as { toolCallId?: unknown; state?: unknown; preliminary?: unknown };
		const kept =
			tool.state === "approval-responded" ||
			tool.state === "output-denied" ||
			tool.state === "output-error" ||
			(tool.state === "output-available" && tool.preliminary !== true);
		if (!kept) ids.push(typeof tool.toolCallId === "string" ? tool.toolCallId : p.type);
	}
	return ids;
}

export async function buildModelView(
	ctx: ViewContext,
	options: {
		entries: { seq: number; message: UIMessage }[];
		prior: RecallContext[];
		current: RecallContext | null;
		partial: UIMessage | null;
		/** Seqs this turn injected — only these get skill bodies (ruling 2026-10-21: owning-turn only). */
		ownedSeqs?: readonly number[] | ReadonlySet<number>;
		assertAuthority(): void;
	},
): Promise<ModelMessage[]> {
	const view = withMemoryBlocks(options.entries, options.prior, options.current);
	if (options.partial !== null) view.push(options.partial);
	const prepared = await materializeAttachments(
		view,
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	options.assertAuthority();
	const owned = new Set(options.ownedSeqs ?? []);
	// Seq maps by object identity + view index, never by UIMessage.id —
	// ids are app-controlled and can duplicate. withMemoryBlocks returns
	// the same message objects it was given (inserted recall blocks are
	// new objects with no seq), and materializeAttachments preserves
	// order/cardinality even where it clones — so index i in prepared is
	// index i in view, and view[i] is either an original entry message
	// (identifiable by reference) or an inserted block.
	const seqByMessage = new Map(options.entries.map((e) => [e.message, e.seq]));
	const seqByIndex = view.map((m) => seqByMessage.get(m) ?? null);
	const messages: ModelMessage[] = [];
	const partialId = options.partial?.id ?? null;
	for (const [i, m] of prepared.entries()) {
		const entrySeq = seqByIndex[i] ?? null;
		// Bodies are a user-input privilege as well as an owned one — a
		// non-user entry carrying a data-skill part never injects.
		const includeBody = entrySeq !== null && m.role === "user" && owned.has(entrySeq);
		const { message: skillMarked, invocations } = skillPartsAsText(
			ctx,
			m.role === "system" ? systemEventAsUser(m) : m,
			includeBody,
		);
		const rendered = notePartsAsText(ctx, skillMarked);
		const unfinished = incompleteToolCallIds(rendered);
		if (unfinished.length > 0 && m.id === partialId) {
			log.info("resume partial ends on an unfinished tool call — dropped from the model view", {
				conversation: ctx.convId,
				message: m.id,
				toolCalls: unfinished,
			});
		} else if (unfinished.length > 0) {
			log.warn("unfinished tool call in durable history — dropped from the model view", {
				conversation: ctx.convId,
				message: m.id,
				toolCalls: unfinished,
			});
		}
		try {
			messages.push(
				...(await convertToModelMessages([rendered], {
					tools: ctx.tools,
					ignoreIncompleteToolCalls: true,
				})),
			);
		} catch (err) {
			log.warn("message unconvertible — degrading to placeholder", err, {
				conversation: ctx.convId,
				message: m.id,
				role: m.role,
			});
			messages.push(
				...(await convertToModelMessages([unconvertiblePlaceholder(rendered)], {
					tools: ctx.tools,
					ignoreIncompleteToolCalls: true,
				})),
			);
		}
		if (includeBody) {
			messages.push(...injectedBodies(ctx, invocations));
		}
	}
	const merged = mergeConsecutiveUserModels(messages);

	log.info("model request", {
		conversation: ctx.convId,
		messages: merged.length,
	});
	return merged;
}

// The owning turn's tail: one appended user message per resolved
// invocation, immediately after the invoking message's own content.
// A null body (refused or unreadable) contributes nothing — the marker
// in the invoking message stands alone.
function injectedBodies(ctx: ViewContext, invocations: SkillInvocation[]): ModelMessage[] {
	const bodies: ModelMessage[] = [];
	for (const inv of invocations) {
		if (inv.body === null) continue;
		log.info("skill body injected", {
			conversation: ctx.convId,
			skill: inv.name,
			temp: isTempSkillRef(inv.ref),
			bytes: inv.body.length,
		});
		bodies.push({ role: "user", content: inv.body });
	}
	return bodies;
}

export async function convertSteeredMessage(
	ctx: ViewContext,
	message: UIMessage,
): Promise<ModelMessage[]> {
	const materialized = await materializeAttachments(
		[message],
		ctx.modalities,
		INLINE_ITEM_MAX_BYTES,
		ctx.carries,
	);
	const out: ModelMessage[] = [];
	for (const m of materialized) {
		const { message: skillMarked, invocations } = skillPartsAsText(ctx, m, true);
		out.push(
			...(await convertToModelMessages([notePartsAsText(ctx, skillMarked)], {
				tools: ctx.tools,
				ignoreIncompleteToolCalls: true,
			})),
		);
		// A claimed steer is owned by construction — the claiming turn
		// is the only one that folds it in.
		out.push(...injectedBodies(ctx, invocations));
	}
	return out;
}

function mergeConsecutiveUserModels(messages: ModelMessage[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (m.role === "user" && prev?.role === "user") {
			const prevContent =
				typeof prev.content === "string"
					? [{ type: "text" as const, text: prev.content }]
					: prev.content;
			const content =
				typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			prev.content = [...prevContent, ...content];
		} else {
			out.push(m);
		}
	}
	return out;
}
