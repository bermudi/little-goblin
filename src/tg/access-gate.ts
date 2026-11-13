// The access gate: one verdict per update before any handler runs —
// operators pass, allowed guest DMs pass, strangers and groups are
// refused (docs/security.md → access gate). Callback taps from
// non-operators are answered so the tap's spinner never hangs.

import type { Api } from "grammy";
import type { Config } from "../config-schema.ts";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";
import { GUEST_REFUSAL, refusalDue } from "./guest.ts";
import { refusalDispatcher, sendRefusal } from "./refusals.ts";

export function accessGate(configRef: { current: Config }, opts?: { refusalTimeoutMs?: number }) {
	const dispatch =
		opts?.refusalTimeoutMs === undefined ? sendRefusal : refusalDispatcher(opts.refusalTimeoutMs);
	return async (
		ctx: {
			from?: { id: number } | undefined;
			chat?: { id: number; type: string } | undefined;
			update?: { callback_query?: { id: string } | undefined };
			api: Api;
		},
		next: () => Promise<void>,
	): Promise<void> => {
		if (!ctx.from) {
			log.debug("rejected update with no sender");
			return;
		}
		const cfg = configRef.current;
		const id = ctx.from.id;
		if (cfg.operators.includes(id)) {
			await next();
			return;
		}
		// A non-operator's callback tap lands here (ctx.chat is the message's chat);
		// it must be answered or the tap's spinner runs until Telegram expires it.
		if (ctx.update !== undefined && "callback_query" in ctx.update) {
			const q = ctx.update.callback_query;
			log.info("callback tap refused — not operator", { userId: id, chat: ctx.chat?.id });
			if (q !== undefined) {
				await withTimeout(
					ctx.api.answerCallbackQuery(q.id, { text: "operator only" }),
					"answerCallbackQuery",
				)
					.then(() => undefined)
					.catch((err: unknown) => log.debug("answerCallbackQuery failed", { error: String(err) }));
			}
			return;
		}
		if (ctx.chat?.type === "private") {
			if (cfg.guest === undefined || !cfg.allowedUsers.includes(id)) {
				log.info("dm refused — not an operator", {
					userId: id,
					guest: cfg.guest !== undefined,
				});
				if (refusalDue(id)) dispatch(ctx.api, id, id, GUEST_REFUSAL);
				return;
			}
			await next();
			return;
		}
		log.info("group message dropped — not operator", { userId: id, chat: ctx.chat?.id });
	};
}
