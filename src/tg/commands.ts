// Commands are settings-only: /model /think /cd /stop. No
// conversation-lifecycle commands — topics own that. Every settings change
// bumps the conversation epoch, fencing in-flight turns.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Api } from "grammy";
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "../config.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import { log } from "../log.ts";

export interface CommandDeps {
	api: Api;
	configRef: { current: Config };
	store: ConversationStore;
	runtime: Runtime;
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

// Apply a settings change: write meta + bump epoch (fences in-flight turns).
function apply(deps: CommandDeps, conv: Conversation, patch: Parameters<ConversationStore["setMeta"]>[1]): void {
	deps.store.setMeta(conv.id, patch);
	deps.store.bumpEpoch(conv.id);
}

// Returns true if the text was a command and got handled.
export function handleCommand(
	deps: CommandDeps,
	conv: Conversation,
	text: string,
): boolean {
	const [rawCmd, ...rest] = text.trim().split(/\s+/);
	const cmd = rawCmd!.split("@")[0]!; // strip /cmd@botname suffix
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
			if (arg === "") {
				reply(
					deps,
					conv,
					`thinking: ${conv.thinking ?? deps.configRef.current.thinking}\n/think <${thinkingLevels.join("|")}> · /think reset for the default`,
				);
				return true;
			}
			if (arg === "reset") {
				apply(deps, conv, { thinking: null });
				log.info("thinking override cleared", { conversation: conv.id });
				reply(deps, conv, `thinking → ${deps.configRef.current.thinking} (default)`);
				return true;
			}
			if (!(thinkingLevels as readonly string[]).includes(arg)) {
				reply(deps, conv, `level must be one of: ${thinkingLevels.join(", ")}`);
				return true;
			}
			apply(deps, conv, { thinking: arg as ThinkingLevel });
			log.info("thinking override set", { conversation: conv.id, thinking: arg });
			reply(deps, conv, `thinking → ${arg}`);
			return true;
		}

		case "/cd": {
			if (arg === "") {
				reply(deps, conv, `cwd: ${conv.cwd}\n/cd <path> to change`);
				return true;
			}
			const abs = isAbsolute(arg) ? arg : resolve(conv.cwd, arg);
			if (!existsSync(abs) || !statSync(abs).isDirectory()) {
				reply(deps, conv, `not a directory: ${abs}`);
				return true;
			}
			apply(deps, conv, { cwd: abs });
			log.info("cwd set", { conversation: conv.id, cwd: abs });
			reply(deps, conv, `cwd → ${abs}`);
			return true;
		}
	}
	return false;
}

export const COMMAND_RE = /^\/(model|think|cd|stop)(@\w+)?(\s|$)/;
