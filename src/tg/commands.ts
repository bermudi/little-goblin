// Commands are settings-only: /model /think /stop. No
// conversation-lifecycle commands — topics own that. Every settings change
// bumps the conversation epoch, fencing in-flight turns.

import type { Api } from "grammy";
import { splitModelRef, type Config, type ThinkingLevel } from "../config.ts";
import { thinkingLevelsFor } from "../agent/providers.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import { log } from "../log.ts";

export interface CommandDeps {
	api: Api;
	configRef: { current: Config };
	store: ConversationStore;
	runtime: Runtime;
	// This bot's own username — commands can be addressed /cmd@botname.
	botUsername: string;
}

function target(conv: Conversation) {
	return {
		...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
	};
}

function reply(deps: CommandDeps, conv: Conversation, text: string): void {
	deps.api.sendMessage(conv.chatId, text, target(conv)).catch((err: unknown) => {
		log.warn("command reply failed", { error: String(err) });
	});
}

// Apply a settings change: patch meta + bump epoch (fences in-flight
// turns) atomically.
function apply(deps: CommandDeps, conv: Conversation, patch: Parameters<ConversationStore["setMeta"]>[1]): void {
	deps.store.applySettings(conv.id, patch);
}

// Returns true if the text was a command and got handled.
export function handleCommand(
	deps: CommandDeps,
	conv: Conversation,
	text: string,
): boolean {
	const [rawCmd, ...rest] = text.trim().split(/\s+/);
	const at = rawCmd!.indexOf("@");
	// "/stop@otherbot" is not for this bot — consumed silently rather than
	// fed to the model as a user message.
	if (at !== -1 && rawCmd!.slice(at + 1).toLowerCase() !== deps.botUsername.toLowerCase()) {
		return true;
	}
	const cmd = at === -1 ? rawCmd! : rawCmd!.slice(0, at);
	const arg = rest.join(" ").trim();

	switch (cmd) {
		case "/stop": {
			deps.runtime.stop(conv.id);
			reply(deps, conv, "stopped");
			return true;
		}

		case "/model": {
			if (arg === "") {
				const current = conv.model ?? deps.configRef.current.model;
				const favs = deps.configRef.current.favorites.map((f) => `  ${f}`).join("\n");
				reply(
					deps,
					conv,
					`model: ${current}\nfavorites:\n${favs || "  (none)"}\n\n/model <ref> to switch · /model reset for the default`,
				);
				return true;
			}
			if (arg === "reset") {
				apply(deps, conv, { model: null });
				log.info("model override cleared", { conversation: conv.id });
				reply(deps, conv, `model → ${deps.configRef.current.model} (default)`);
				return true;
			}
			let ref: { provider: string; modelId: string };
			try {
				ref = splitModelRef(arg);
			} catch {
				reply(deps, conv, `model ref must be "<provider>/<model-id>", got "${arg}"`);
				return true;
			}
			if (!deps.configRef.current.providers[ref.provider]) {
				reply(
					deps,
					conv,
					`unknown provider in "${arg}" — providers: ${Object.keys(deps.configRef.current.providers).join(", ")}`,
				);
				return true;
			}
			apply(deps, conv, { model: arg });
			log.info("model override set", { conversation: conv.id, model: arg });
			reply(deps, conv, `model → ${arg}`);
			return true;
		}

		case "/think": {
			// Levels the conversation's model can actually express — the
			// vocabulary is wider than any single model's ladder.
			const ref = conv.model ?? deps.configRef.current.model;
			const { provider, modelId } = splitModelRef(ref);
			const p = deps.configRef.current.providers[provider];
			const valid = thinkingLevelsFor(
				p?.kind ?? "",
				modelId,
				p?.kind === "openai-compatible" ? p.baseUrl : undefined,
			);
			if (arg === "") {
				reply(
					deps,
					conv,
					`thinking: ${conv.thinking ?? deps.configRef.current.thinking}\n/think <${valid.join("|")}> · /think reset for the default`,
				);
				return true;
			}
			if (arg === "reset") {
				apply(deps, conv, { thinking: null });
				log.info("thinking override cleared", { conversation: conv.id });
				reply(deps, conv, `thinking → ${deps.configRef.current.thinking} (default)`);
				return true;
			}
			if (!(valid as readonly string[]).includes(arg)) {
				reply(deps, conv, `${modelId} supports: ${valid.join(", ")}`);
				return true;
			}
			apply(deps, conv, { thinking: arg as ThinkingLevel });
			log.info("thinking override set", { conversation: conv.id, thinking: arg });
			reply(deps, conv, `thinking → ${arg}`);
			return true;
		}
	}
	return false;
}

// The settings surface Telegram advertises — registered via
// setMyCommands at boot so autocomplete shows exactly what works.
// COMMAND_RE derives from this list: the two can never drift apart.
export const COMMANDS = [
	{ command: "model", description: "show or override the model" },
	{ command: "think", description: "show or override thinking level" },
	{ command: "stop", description: "fence the running turn" },
] as const;

export const COMMAND_RE = new RegExp(
	`^/(${COMMANDS.map((c) => c.command).join("|")})(@\\w+)?(\\s|$)`,
);
