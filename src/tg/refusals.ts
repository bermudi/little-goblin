import type { Api } from "grammy";
import { log } from "../log.ts";

const REFUSAL_SEND_SLOTS = 8;
const REFUSAL_TIMEOUT_MS = 30_000;

// Grammy's node shim types the signal param as abort-controller's AbortSignal,
// not the global — a derived alias avoids importing the transitive shim.
type GrammySignal = NonNullable<Parameters<Api["sendMessage"]>[3]>;

export function refusalDispatcher(refusalTimeoutMs: number) {
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
