import { z } from "zod";
import { thinkingLevelsFor } from "../agent/thinking.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import type { AuthStore } from "../auth.ts";
import { type Config, type ConfigRef, splitModelRef, thinkingLevels } from "../config.ts";
import { type ConversationStore, type ModelSettings } from "../conversation.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { Runtime } from "../runtime.ts";
import type { ResumeOps } from "../turn-resume.ts";
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
	titleFor?: (text: string) => Promise<string | null>;
	rewriteNote?: (
		noteId: string,
		input: AppNoteRewriteRequest,
		signal: AbortSignal,
	) => Promise<string>;
	operator?: Omit<OperatorDeps, "configRef" | "onConfigWritten">;
	resumeOps?: () => ResumeOps | undefined;
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
	return {
		model: settings.model,
		thinking: settings.thinking,
		favorites: cfg.favorites,
		thinkingLevels:
			p === undefined
				? [...thinkingLevels]
				: [...thinkingLevelsFor(p.kind, modelId, "baseUrl" in p ? p.baseUrl : undefined)],
	};
}
