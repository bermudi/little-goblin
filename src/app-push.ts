// App Web Push: per-device subscriptions plus terminal-turn rings. The app
// channel owns registration and delivery; Telegram remains a separate bell.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	generateVAPIDKeys,
	sendNotification,
	type PushSubscription,
	type RequestOptions,
	type SendResult,
	type VapidKeys,
} from "web-push";
import type { AuthStore } from "./auth.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { appIdOf } from "./conversation-address.ts";
import { log } from "./log.ts";
import { type OperatorReminder, REMINDER_EVERY_MS, reminderText } from "./reminders/index.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";

export const APP_PUSH_VAPID = "app-push-vapid";

const vapidSchema = z.object({
	publicKey: z.string().min(1),
	privateKey: z.string().min(1),
});

export const pushSubscriptionSchema = z.object({
	endpoint: z
		.url()
		.max(4096)
		.refine(
			(endpoint) => {
				try {
					return new URL(endpoint).protocol === "https:";
				} catch {
					return false;
				}
			},
			{ message: "push endpoint must be https" },
		),
	expirationTime: z.number().int().nullable().optional(),
	keys: z.object({
		p256dh: z.string().min(1).max(1024),
		auth: z.string().min(1).max(1024),
	}),
});

export type AppPushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export interface AppPushSubscriptionView {
	endpointHash: string;
	userAgent: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AppPushStatus {
	configured: boolean;
	subscriptions: AppPushSubscriptionView[];
}

interface SubscriptionRow {
	endpoint_hash: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	expiration_time: number | null;
	user_agent: string | null;
	created_at: string;
	updated_at: string;
}

interface AppPushDeps {
	auth: Pick<AuthStore, "has" | "resolve">;
	storeSecret?: ((name: string, value: string) => void) | undefined;
	store: Pick<ConversationStore, "get" | "lastEntry" | "lastSeq">;
	/** VAPID subject — an https contact URL or mailto. */
	subject(): string;
	send?: (
		subscription: PushSubscription,
		payload: string,
		options: RequestOptions,
	) => Promise<SendResult>;
	generateKeys?: () => VapidKeys;
}

export interface AppPush {
	status(): Promise<AppPushStatus>;
	ensurePublicKey(): Promise<string>;
	register(
		subscription: AppPushSubscriptionInput,
		userAgent: string | null,
	): Promise<{ endpointHash: string }>;
	unregister(endpoint: string): boolean;
	notifyDone(conv: Conversation, done: TurnDone): Promise<void>;
	/** True when at least one subscribed device has this reminder. */
	notifyReminder(reminder: OperatorReminder): Promise<boolean>;
}

function endpointHash(endpoint: string): string {
	return createHash("sha256").update(endpoint).digest("hex");
}

function asView(row: SubscriptionRow): AppPushSubscriptionView {
	return {
		endpointHash: row.endpoint_hash,
		userAgent: row.user_agent,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function subscriptionFor(row: SubscriptionRow): PushSubscription {
	return {
		endpoint: row.endpoint,
		...(row.expiration_time === null ? {} : { expirationTime: row.expiration_time }),
		keys: { p256dh: row.p256dh, auth: row.auth },
	};
}

function statusCodeOf(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null || !("statusCode" in err)) return undefined;
	const code = (err as { statusCode?: unknown }).statusCode;
	return typeof code === "number" ? code : undefined;
}

export function openAppPush(db: Database, deps: AppPushDeps): AppPush {
	const qList = db.query<SubscriptionRow, []>(
		`SELECT endpoint_hash, endpoint, p256dh, auth, expiration_time, user_agent, created_at, updated_at
		 FROM app_push_subscriptions ORDER BY created_at, endpoint_hash`,
	);
	const qUpsert = db.query(
		`INSERT INTO app_push_subscriptions
		 (endpoint_hash, endpoint, p256dh, auth, expiration_time, user_agent, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(endpoint_hash) DO UPDATE SET
			endpoint = excluded.endpoint,
			p256dh = excluded.p256dh,
			auth = excluded.auth,
			expiration_time = excluded.expiration_time,
			user_agent = excluded.user_agent,
			updated_at = excluded.updated_at`,
	);
	const qDelete = db.query("DELETE FROM app_push_subscriptions WHERE endpoint_hash = ?");
	const qDelivered = db.query<{ n: number }, [string, string]>(
		"SELECT COUNT(*) AS n FROM app_push_deliveries WHERE notification_key = ? AND endpoint_hash = ?",
	);
	const qMarkDelivered = db.query(
		"INSERT OR IGNORE INTO app_push_deliveries (notification_key, endpoint_hash, sent_at) VALUES (?, ?, ?)",
	);

	const send = deps.send ?? sendNotification;
	const doneKeys = new WeakMap<TurnDone, string | null>();
	const inFlight = new Map<string, Promise<void>>();

	async function vapid(generate: boolean): Promise<VapidKeys | null> {
		if (!deps.auth.has(APP_PUSH_VAPID)) {
			if (!generate) return null;
			const storeSecret = deps.storeSecret;
			if (storeSecret === undefined) {
				throw new Error("app push VAPID key is absent and auth writes are not wired");
			}
			const keys = (deps.generateKeys ?? generateVAPIDKeys)();
			// The auth file write must precede the in-memory put in the callback;
			// this module deliberately never logs either half of the pair.
			storeSecret(APP_PUSH_VAPID, JSON.stringify(vapidSchema.parse(keys)));
			log.info("app push VAPID key generated", { auth: APP_PUSH_VAPID });
			return keys;
		}
		const raw = await deps.auth.resolve(APP_PUSH_VAPID);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`auth record ${APP_PUSH_VAPID} must contain the VAPID pair as JSON`);
		}
		return vapidSchema.parse(parsed);
	}

	function notificationKey(conv: Conversation, done: TurnDone): string | null {
		const prior = doneKeys.get(done);
		if (prior !== undefined) return prior;
		let key: string | null;
		if (done.kind === "fenced") {
			key = null;
		} else if (done.kind === "error") {
			key = `error:${conv.id}:${deps.store.lastSeq(conv.id) ?? 0}:${randomUUID()}`;
		} else {
			const assistant = deps.store.lastEntry(conv.id, "assistant");
			key = `completed:${conv.id}:${assistant?.seq ?? deps.store.lastSeq(conv.id) ?? 0}`;
		}
		doneKeys.set(done, key);
		return key;
	}

	async function notifyDone(conv: Conversation, done: TurnDone): Promise<void> {
		if (done.kind === "fenced") return;
		const appId = appIdOf(conv.id);
		if (appId === null || deps.store.get(conv.id) === null) return;
		const key = notificationKey(conv, done);
		if (key === null) return;
		await ring(
			key,
			{
				title: "goblin",
				body: done.kind === "completed" ? "A background turn finished" : "A background turn failed",
				url: `/app/c/${appId}`,
			},
			{ ttl: 3600, fields: { conversation: conv.id, outcome: done.kind } },
		);
	}

	async function notifyReminder(reminder: OperatorReminder): Promise<boolean> {
		const appId = appIdOf(reminder.conversationId);
		await ring(
			reminder.key,
			{
				title: "goblin",
				body: reminderText(reminder.stage),
				url: appId === null ? "/app/" : `/app/c/${appId}`,
			},
			{
				// A phone off overnight should still get it; the next step replaces it anyway.
				replaces: reminder.series,
				ttl: REMINDER_EVERY_MS / 1000,
				fields: {
					conversation: reminder.conversationId,
					responsibility: reminder.responsibilityId,
					outcome: `reminder:${reminder.stage}`,
				},
			},
		);
		return qList.all().some((row) => (qDelivered.get(reminder.key, row.endpoint_hash)?.n ?? 0) > 0);
	}

	async function ring(
		key: string,
		message: { title: string; body: string; url: string },
		opts: { ttl: number; fields: Record<string, string>; replaces?: string },
	): Promise<void> {
		const subscriptions = qList.all();
		if (subscriptions.length === 0) {
			log.info("app push skipped — no device subscribed", { key, ...opts.fields });
			return;
		}
		const pending = subscriptions.filter((row) => qDelivered.get(key, row.endpoint_hash)?.n === 0);
		if (pending.length === 0) return;

		const prior = inFlight.get(key);
		if (prior !== undefined) return prior;
		const task = (async () => {
			let pair: VapidKeys;
			try {
				pair = (await vapid(true))!;
			} catch (err) {
				log.error("app push send skipped — VAPID unavailable", err, opts.fields);
				return;
			}
			const replaces = opts.replaces ?? key;
			const payload = JSON.stringify({
				...message,
				tag: replaces,
				...(opts.replaces === undefined ? {} : { renotify: true }),
			});
			for (const row of pending) {
				try {
					await send(subscriptionFor(row), payload, {
						vapidDetails: {
							subject: deps.subject(),
							publicKey: pair.publicKey,
							privateKey: pair.privateKey,
						},
						TTL: opts.ttl,
						timeout: 10_000,
						urgency: "normal",
						topic: createHash("sha256").update(replaces).digest("base64url").slice(0, 32),
					});
					qMarkDelivered.run(key, row.endpoint_hash, new Date().toISOString());
					log.info("app push sent", { ...opts.fields, endpointHash: row.endpoint_hash });
				} catch (err) {
					const status = statusCodeOf(err);
					if (status === 404 || status === 410) {
						qDelete.run(row.endpoint_hash);
						log.info("app push subscription pruned — endpoint gone", {
							...opts.fields,
							endpointHash: row.endpoint_hash,
							status,
						});
						continue;
					}
					log.warn("app push send failed — subscription retained for retry", {
						...opts.fields,
						endpointHash: row.endpoint_hash,
						status: status ?? null,
					});
				}
			}
		})();
		inFlight.set(key, task);
		try {
			await task;
		} finally {
			inFlight.delete(key);
		}
	}

	return {
		async status() {
			return {
				configured: deps.auth.has(APP_PUSH_VAPID),
				subscriptions: qList.all().map(asView),
			};
		},
		async ensurePublicKey() {
			return (await vapid(true))!.publicKey;
		},
		async register(subscription, userAgent) {
			await vapid(true);
			const hash = endpointHash(subscription.endpoint);
			const now = new Date().toISOString();
			const existing = qList.all().find((row) => row.endpoint_hash === hash);
			qUpsert.run(
				hash,
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				subscription.expirationTime ?? null,
				userAgent,
				existing?.created_at ?? now,
				now,
			);
			log.info("app push subscription registered", {
				endpointHash: hash,
				replaced: existing !== undefined,
			});
			return { endpointHash: hash };
		},
		unregister(endpoint) {
			const parsed = z.url().safeParse(endpoint);
			if (!parsed.success) return false;
			const hash = endpointHash(parsed.data);
			const removed = qDelete.run(hash).changes > 0;
			if (removed) log.info("app push subscription removed", { endpointHash: hash });
			return removed;
		},
		notifyDone,
		notifyReminder,
	};
}

export function appPushSink(push: Pick<AppPush, "notifyDone">, conv: Conversation): TurnSink {
	return {
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		onDone(done) {
			return push.notifyDone(conv, done);
		},
	};
}
