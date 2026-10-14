// Bounded outbound refusals (design/telegram.md → Roles and
// permissions). A refused stranger can summon the bot once per
// message, on the DM surface or by mention inside a member chat — the
// refusal line never amplifies: at most one unsettled send per
// (user, chat), a global slot cap, and each send on its own timeout.
// A wedged Telegram boundary can pin slots, never stall grammY
// polling or delay an operator's next().

import type { Api } from "grammy";
import { log } from "../log.ts";

const REFUSAL_SEND_SLOTS = 8;
const REFUSAL_TIMEOUT_MS = 30_000;

// Grammy's node shim types the signal param as abort-controller's
// AbortSignal; the runtime takes the global one. A derived alias keeps
// the call typed without importing the transitive shim package.
type GrammySignal = NonNullable<Parameters<Api["sendMessage"]>[3]>;

export function refusalDispatcher(refusalTimeoutMs: number) {
	// One entry per (user, chat) with an unsettled refusal send — dedup
	// and the slot cap ride the same map. The slot is held until the
	// send ACTUALLY settles (not merely timed out): a boundary that
	// ignores the abort keeps its slot, so abandoned requests stay
	// bounded.
	const pendingRefusals = new Map<string, Promise<void>>();
	return (api: Api, id: number, chat: number, text: string, threadId?: number): void => {
		const key = `${id}:${chat}`;
		if (pendingRefusals.has(key)) {
			log.info("refusal coalesced — already pending", {
				userId: id,
				chat,
				pending: pendingRefusals.size,
			});
			return;
		}
		if (pendingRefusals.size >= REFUSAL_SEND_SLOTS) {
			log.warn("refusal dropped — refusal send slots exhausted", {
				userId: id,
				chat,
				pending: pendingRefusals.size,
			});
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), refusalTimeoutMs);
		timer.unref?.();
		log.info("telegram refusal scheduled", {
			userId: id,
			chat,
			pending: pendingRefusals.size + 1,
		});
		const send = Promise.resolve()
			.then(() =>
				api.sendMessage(
					chat,
					text,
					threadId === undefined ? {} : { message_thread_id: threadId },
					controller.signal as unknown as GrammySignal,
				),
			)
			.then(() => {
				log.info("telegram refusal delivered", {
					userId: id,
					chat,
					pending: pendingRefusals.size,
				});
			})
			.catch((err: unknown) => {
				log.warn("telegram refusal failed", err, {
					userId: id,
					chat,
					pending: pendingRefusals.size,
				});
			})
			.finally(() => {
				clearTimeout(timer);
				pendingRefusals.delete(key);
			});
		pendingRefusals.set(key, send);
	};
}

const refusalDispatchers = new WeakMap<Api, ReturnType<typeof refusalDispatcher>>();

// The shared dispatcher — one pending map and one slot budget for
// every refusal the process sends, DM gate and member surface alike.
export function sendRefusal(
	api: Api,
	id: number,
	chat: number,
	text: string,
	threadId?: number,
): void {
	let dispatch = refusalDispatchers.get(api);
	if (dispatch === undefined) {
		dispatch = refusalDispatcher(REFUSAL_TIMEOUT_MS);
		refusalDispatchers.set(api, dispatch);
	}
	dispatch(api, id, chat, text, threadId);
}
