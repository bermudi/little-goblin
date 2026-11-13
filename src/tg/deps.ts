// The adapter's leaf contract: the auth token name and the dependency
// bag every tg module builds on (bot assembly, intake, flush, the
// /skill doors). It must stay import-free of them — `BotDeps` living in
// bot.ts would close bot → intake → bot (#451's cycle trap).

import type { SpeechFile } from "../agent/transcribe.ts";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import type { TtsConfig } from "../config-schema.ts";
import type { ConversationStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import type { System1Client } from "../system1.ts";
import type { ResumeOps } from "../turn-resume.ts";
import type { CommandMemoryDeps } from "./commands.ts";
import type { TelegramMailApproval } from "./mail-approval.ts";
import type { TelegramProgramApproval } from "./program-approval.ts";

export const AUTH_TELEGRAM_TOKEN = "telegram";

export interface BotDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	runtime: Runtime;
	titleFor(text: string): Promise<string | null>;
	transcribe(file: SpeechFile): Promise<string | null>;
	synthesize(text: string, config: TtsConfig): Promise<Uint8Array[]>;
	memory?: CommandMemoryDeps;
	mail?: () => TelegramMailApproval | undefined;
	programApproval?: () => TelegramProgramApproval | undefined;
	followUpGate?: () => Pick<System1Client, "decide"> | undefined;
	resumeOps?: () => ResumeOps | undefined;
}
