import { z } from "zod";
import { clampThinkingFor, thinkingLevelsFor } from "../agent/thinking.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import type { AuthStore } from "../auth.ts";
import { type Config, type ConfigRef, splitModelRef, thinkingLevels } from "../config.ts";
import { type ConversationStore, type ModelSettings } from "../conversation.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { Runtime } from "../runtime.ts";
import type { ResumeOps } from "../turn-resume.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { ProgramApproval } from "../program-approval.ts";
import type { ProgramOps } from "../program-ops.ts";
import type { AppPush } from "../app-push.ts";
import type { AppConfigView, AppNoteRewriteRequest } from "./app-wire.ts";
import type { OperatorDeps } from "./operator.ts";

export const NO_STORE = { "cache-control": "no-store" };

export function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
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
	titleFor?: (text: string) => Promise<string | null>;
	rewriteNote?: (
		noteId: string,
		input: AppNoteRewriteRequest,
		signal: AbortSignal,
	) => Promise<string>;
	operator?: Omit<OperatorDeps, "configRef" | "onConfigWritten">;
	resumeOps?: () => ResumeOps | undefined;
	approvals?: {
		program: Pick<ProgramApproval, "candidate" | "decide" | "pending">;
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
		thinkingLevels: levels,
	};
}
