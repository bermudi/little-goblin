import { z } from "zod";
import { modelCatalogFor } from "../agent/models-dev.ts";
import { clampThinkingFor, thinkingLevelsFor } from "../agent/thinking.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import type { AuthStore } from "../auth.ts";
import { type Config, type ConfigRef, splitModelRef, thinkingLevels } from "../config.ts";
import { appIdSchema } from "../conversation-address.ts";
import type { ConversationStore } from "../conversation.ts";
import type { ModelSettings } from "../conversation-settings.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { Runtime } from "../runtime.ts";

import type { ResumeOps } from "../turn-resume.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { ProgramApproval } from "../program-approval.ts";
import type { ProgramOps } from "../program-ops.ts";
import type { AppPush } from "../app-push.ts";
import type { AppConfigView, AppNoteRewriteRequest } from "./app-wire.ts";
import type { OperatorDeps } from "./operator-deps.ts";

export const NO_STORE = { "cache-control": "no-store" };

export function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
}

/** A JSON body parsed against `schema`, or the refusal response for it. */
export async function parsedJson<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
	const refusedJson = jsonBodyRefusal(req);
	if (refusedJson !== null) return refusedJson;
	let json: unknown;
	try {
		json = await req.json();
	} catch {
		return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Response.json(
			{ error: z.prettifyError(parsed.error) },
			{ status: 422, headers: NO_STORE },
		);
	}
	return parsed.data;
}

/** A conversation id path segment — decoded and checked, or its 404. */
export function conversationFromSegment(segment: string): { id: string } | Response {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		decoded = "";
	}
	const parsed = appIdSchema.safeParse(decoded);
	if (!parsed.success) {
		return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
	}
	return { id: `app/${parsed.data}` };
}

export interface AppChannelDeps {
	store: ConversationStore;
	runtime: Runtime;
	projects: ProjectStore;
	notes: NoteStore;
	auth: Pick<AuthStore, "resolve">;
	configRef: ConfigRef;
	onConfigWritten(): void;
	transcribe?: (file: SpeechFile) => Promise<string | null>;
	speak?: (text: string) => Promise<Uint8Array[] | null>;
	// The context-window view's read handle (window-capture.ts); absent
	// = the window route answers 503.
	windowCapture?: ReturnType<typeof import("../window-capture.ts").openWindowCapture>;
	titleFor?: (text: string, avoid?: string) => Promise<string | null>;
	rewriteNote?: (
		noteId: string,
		input: AppNoteRewriteRequest,
		signal: AbortSignal,
	) => Promise<string>;
	operator?: Omit<OperatorDeps, "configRef" | "onConfigWritten">;
	resumeOps?: () => ResumeOps | undefined;
	approvals?: {
		program: Pick<ProgramApproval, "base" | "candidate" | "decide" | "pending">;
		mail: Pick<MailApproval, "decide" | "pending">;
	};
	programOps?: ProgramOps;
	push?: Pick<AppPush, "status" | "ensurePublicKey" | "register" | "unregister" | "notifyDone">;
	// The responsibility feed + controls (app-responsibilities.ts).
	// Absent = those routes refuse 503.
	responsibilities?: import("./app-responsibilities.ts").AppResponsibilityDeps;
}

export const configPatchBody = z
	.object({
		model: z.string().min(1).optional(),
		thinking: z.enum(thinkingLevels).optional(),
	})
	.refine((p) => p.model !== undefined || p.thinking !== undefined, {
		message: "nothing to write",
	});

export function configView(cfg: Config, settings: ModelSettings = cfg): AppConfigView {
	const { provider, modelId } = splitModelRef(settings.model);
	const p = cfg.providers[provider];
	const levels =
		p === undefined
			? [...thinkingLevels]
			: [...thinkingLevelsFor(p.kind, modelId, "baseUrl" in p ? p.baseUrl : undefined)];
	// thinking must be one of the offered rungs — the select renders its
	// value as an option, so a stale pair would fake a rung the model
	// can't express. The wire clamp lands on the same rung this shows.
	const thinking = clampThinkingFor(cfg.providers, settings.model, settings.thinking);
	return {
		model: settings.model,
		thinking,
		favorites: cfg.favorites,
		pickerModels: cfg.pickerModels ?? null,
		thinkingLevels: levels,
		catalog: modelCatalogFor(cfg),
	};
}
