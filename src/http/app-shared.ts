// Shared plumbing for the app channel's route modules: the deps
// contract (AppChannelDeps), the no-store header every JSON response
// carries, the JSON-body CSRF backstop, and the two config pieces the
// conversations and config modules both read.

import { z } from "zod";
import { thinkingLevelsFor } from "../agent/providers.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import type { AuthStore } from "../auth.ts";
import { type Config, type ConfigRef, splitModelRef, thinkingLevels } from "../config.ts";
import { type ConversationStore, type ModelSettings } from "../conversation.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { Runtime } from "../runtime.ts";
import type { AppConfigView, AppNoteRewriteRequest } from "./app-wire.ts";
import type { OperatorDeps } from "./operator.ts";

export const NO_STORE = { "cache-control": "no-store" };

// JSON-body mutations must say what they are (#75): application/json
// is beyond a no-cors form or fetch (those carry text/plain,
// urlencoded, or multipart), so the claim itself is a CSRF backstop
// behind the origin gate. Applies in both auth modes — wire contract,
// not trust. Multipart uploads and bodyless routes (stop, delete)
// never read JSON and never see this check.
export function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
}

export interface AppChannelDeps {
	store: ConversationStore;
	runtime: Runtime;
	// The project domain (design/projects.md) — list/create/get/patch
	// and the conversation-binding checks in POST /conversations.
	projects: ProjectStore;
	// The notes surface — the /api/app/notes routes and the data-note
	// intake expansion on chat POST (the server reads the note; the
	// client only names it).
	notes: NoteStore;
	// auth.jsonl resolution — the record config.appToken names.
	auth: Pick<AuthStore, "resolve">;
	// Live config + shared post-write hook for app defaults. Conversation
	// settings live separately in SQLite and never rewrite this file.
	configRef: ConfigRef;
	onConfigWritten(): void;
	// Speech→text for speech-flagged attachments, the same seam tg
	// intake runs on voice notes. Absent = transcription unconfigured —
	// the ref keeps speech:true with no transcript and materialization
	// degrades to the path reference.
	transcribe?: (file: SpeechFile) => Promise<string | null>;
	// Reply read-aloud — synthesizeSpeech over the live tts block.
	// Absent or a null return = speech unavailable (503 to the client).
	speak?: (text: string) => Promise<Uint8Array[] | null>;
	// First-turn naming via titleModel — the same closure the tg lane
	// uses for implicit topics. Absent = no auto-titling.
	titleFor?: (text: string) => Promise<string | null>;
	// Selection rewrite — one generate call, no write (design/projects.md
	// → AI rewrite). Absent = the route refuses 503.
	rewriteNote?: (
		noteId: string,
		input: AppNoteRewriteRequest,
		signal: AbortSignal,
	) => Promise<string>;
	// The operator surface (operator.ts) — shared verbatim with the mini
	// app's /api/* routes; configRef/onConfigWritten already live on this
	// deps object so the bundle carries only the extra seams. Absent =
	// the operator routes refuse 503.
	operator?: Omit<OperatorDeps, "configRef" | "onConfigWritten">;
}

// The composer's two knobs. A patch with neither is a client bug —
// refuse rather than write a no-op through the file.
export const configPatchBody = z
	.object({
		model: z.string().min(1).optional(),
		thinking: z.enum(thinkingLevels).optional(),
	})
	.refine((p) => p.model !== undefined || p.thinking !== undefined, {
		message: "nothing to write",
	});

// The composer's readout: the live model ref and thinking rung, the
// favorites list to switch between, and the rungs the active model can
// actually express (thinkingLevelsFor — same table the mini app reads).
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
