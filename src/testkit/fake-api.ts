// Shared Telegram API edge fake — the partial-Api scaffold the tg/
// suites each hand-rolled. Records every call verbatim and answers with
// boundary-plausible defaults: sequential message ids, editMessageText
// writing back by id (the sinks rely on in-place edit), `true` for
// ack-shaped methods. Per-method handlers replace a default when a test
// controls the behavior; `before`/`failOn` cover gates and outages.
// Test support only — only *.test.ts files import this directory.

import type { Api } from "grammy";

export interface RecordedCall {
	method: string;
	args: unknown[];
}

export interface FakeApi {
	api: Api;
	calls: RecordedCall[];
	// Bodies of plain sendMessage calls; editMessageText writes back by
	// returned message id — in-place edit, like the wire.
	texts: string[];
}

type Handler = (...args: never[]) => unknown;

// send*/answer* shapes the tests' code under test consumes; everything
// else is an ack. message_id bases can be overridden per suite.
export function fakeApi(
	opts: {
		handlers?: Record<string, Handler>;
		before?: (method: string, args: unknown[]) => void | Promise<void>;
		failOn?: (method: string, args: unknown[]) => boolean;
		messageIdBase?: number;
	} = {},
): FakeApi {
	const calls: RecordedCall[] = [];
	const texts: string[] = [];
	let seq = 0;
	const nextId = () => (opts.messageIdBase ?? 0) + ++seq;
	const target = new Map<string, Handler>(Object.entries(opts.handlers ?? {}));
	const defaultReply = (method: string, args: unknown[]): unknown => {
		switch (method) {
			case "sendMessage":
			case "sendRichMessage":
				texts.push(
					typeof args[1] === "string"
						? args[1]
						: String((args[1] as { markdown?: string })?.markdown ?? ""),
				);
				return { message_id: nextId() };
			case "editMessageText": {
				const id = args[1];
				if (typeof id === "number" && id - 1 < texts.length && typeof args[2] === "string")
					texts[id - 1] = args[2];
				return { message_id: id };
			}
			case "sendVoice":
			case "sendPhoto":
			case "sendDocument":
			case "sendAudio":
			case "sendAnimation":
				return { message_id: nextId() };
			case "sendMediaGroup":
				return (args[1] as unknown[]).map(() => ({ message_id: nextId() }));
			case "answerGuestQuery":
				return { inline_message_id: "im-1" };
			default:
				return true;
		}
	};
	// Recording and the default/handler run synchronously — tests assert
	// right after a synchronous caller. Only an async `before` defers.
	const invoke = (method: string, args: unknown[]): Promise<unknown> => {
		calls.push({ method, args });
		const run = (): unknown => {
			if (opts.failOn?.(method, args)) throw new Error(`${method} failed`);
			const handler = target.get(method);
			if (handler) return (handler as (...a: unknown[]) => unknown)(...args);
			return defaultReply(method, args);
		};
		const pre = opts.before?.(method, args);
		if (pre !== undefined && typeof (pre as Promise<void>).then === "function")
			return (pre as Promise<void>).then(run);
		try {
			return Promise.resolve(run());
		} catch (err) {
			return Promise.reject(err);
		}
	};
	const api = new Proxy({} as Record<string, unknown>, {
		// An explicitly assigned member (per-test override, spyOn)
		// wins over the recording default.
		get(t, prop) {
			if (typeof prop !== "string") return undefined;
			if (Object.hasOwn(t, prop)) return t[prop];
			return (...args: unknown[]) => invoke(prop, args);
		},
		set(t, prop, value) {
			if (typeof prop === "string") t[prop] = value;
			return true;
		},
	}) as unknown as Api;
	return { api, calls, texts };
}

// Every call of one method's args, in order — the projection idiom the
// suites repeat (calls.filter(...).map(c => c.args)).
export function callArgs(calls: RecordedCall[], method: string): unknown[][] {
	return calls.filter((c) => c.method === method).map((c) => c.args);
}
