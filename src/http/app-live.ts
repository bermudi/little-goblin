import { log } from "../log.ts";
import { every, type Timer } from "../timing.ts";
import { activityBody } from "./app-activity.ts";
import { approvalsBody } from "./app-approvals.ts";
import { attentionBody, proposedSkills } from "./app-attention.ts";
import { conversationListBody } from "./app-conversations.ts";
import {
	APP_LIVE_TOPICS,
	type AppLiveEvent,
	type AppLiveTopic,
	type AppLiveVersions,
} from "./app-live-topics.ts";
import { noteListVersioned } from "./app-notes.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";
import { eventStream } from "./app-sse.ts";
import { type AppLive, versionOf } from "./live-version.ts";
import { delegationsBody, programsBody } from "./operator-programs.ts";
import { skillsBody } from "./operator-skills.ts";

const LIVE_TICK_MS = 500;
const LIVE_SWEEP_MS = 10_000;
const LIVE_KEEPALIVE_MS = 15_000;
const FAST_TOPICS = APP_LIVE_TOPICS.filter((t) => t !== "skills");

type AppLiveDeps = Omit<AppChannelDeps, "live">;

export function openAppLive(
	deps: AppLiveDeps,
	opts: { tickMs?: number; sweepMs?: number } = {},
): AppLive {
	const tickMs = opts.tickMs ?? LIVE_TICK_MS;
	const sweepMs = opts.sweepMs ?? LIVE_SWEEP_MS;
	const qDataVersion = deps.store.db.query<{ data_version: number }, []>(
		"PRAGMA data_version",
	);
	const qTotalChanges = deps.store.db.query<{ n: number }, []>(
		"SELECT total_changes() AS n",
	);

	let proposed = () => proposedSkills(deps);
	const readProposed = () => {
		try {
			const list = proposedSkills(deps);
			proposed = () => list;
		} catch (err) {
			proposed = () => {
				throw err;
			};
		}
	};

	const readers: Record<AppLiveTopic, () => unknown> = {
		conversations: () => conversationListBody(deps),
		notes: () => noteListVersioned(deps),
		attention: () => attentionBody(deps, proposed()),
		approvals: () => approvalsBody(deps),
		activity: () => activityBody(deps),
		programs: () => (deps.operator === undefined ? null : programsBody(deps.operator)),
		delegations: () => (deps.operator === undefined ? null : delegationsBody(deps.operator)),
		skills: () => (deps.operator === undefined ? null : skillsBody(deps.operator)),
	};

	const listeners = new Set<(versions: AppLiveVersions) => void>();
	const failing = new Set<AppLiveTopic>();
	let versions = {} as AppLiveVersions;
	let timers: Timer[] = [];
	let lastStamp = "";

	const stamp = (): string =>
		`${qDataVersion.get()?.data_version ?? 0}:${qTotalChanges.get()?.n ?? 0}:${deps.runtime.busyConversations().join()}`;

	const readTopic = (topic: AppLiveTopic): string => {
		try {
			const body = readers[topic]();
			if (failing.delete(topic)) log.info("app live topic reader recovered", { topic });
			return versionOf(body);
		} catch (err) {
			if (!failing.has(topic)) {
				failing.add(topic);
				log.warn("app live topic reader failing", err, { topic });
			}
			return `error:${versionOf(err instanceof Error ? err.message : String(err))}`;
		}
	};

	const read = (topics: readonly AppLiveTopic[]): AppLiveVersions => {
		const next = { ...versions };
		for (const topic of topics) next[topic] = readTopic(topic);
		return next;
	};

	const publish = (next: AppLiveVersions) => {
		const prev = versions;
		versions = next;
		if (APP_LIVE_TOPICS.every((t) => prev[t] === next[t])) return;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch (err) {
				log.error("app live listener failed", err);
			}
		}
	};

	const tick = () => {
		const nowStamp = stamp();
		if (nowStamp === lastStamp) return;
		lastStamp = nowStamp;
		publish(read(FAST_TOPICS));
	};

	const sweep = () => {
		lastStamp = stamp();
		readProposed();
		publish(read(APP_LIVE_TOPICS));
	};

	return {
		subscribe(listener) {
			if (timers.length === 0) {
				sweep();
				timers = [
					every(tickMs, "app live tick", tick, { unref: true }),
					every(sweepMs, "app live sweep", sweep, { unref: true }),
				];
			} else {
				tick();
			}
			listeners.add(listener);
			return {
				versions,
				unsubscribe() {
					listeners.delete(listener);
					if (listeners.size === 0) {
						for (const timer of timers) timer.cancel();
						timers = [];
					}
				},
			};
		},
	};
}

export async function handleLiveRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	if (url.pathname !== "/api/app/live") return null;
	if (req.method !== "GET") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	return eventStream<AppLiveEvent>(req, {
		keepaliveMs: LIVE_KEEPALIVE_MS,
		label: "app live",
		open(push) {
			const subscription = deps.live.subscribe((versions) => push({ type: "versions", versions }));
			push({ type: "versions", versions: subscription.versions });
			log.info("app live attach");
			return subscription.unsubscribe;
		},
		onClose() {
			log.info("app live detach");
		},
	});
}
