import { z } from "zod";
import type {
	AppActivityResponse,
	AppApprovalsResponse,
	AppAttentionResponse,
	AppConversationList,
	AppNoteList,
} from "../../src/http/app-wire.ts";
import type {
	OperatorDelegationsResponse,
	OperatorProgramsResponse,
	SkillsResponse,
} from "../../src/http/operator-wire.ts";
import { ApiError, requestMeta } from "./api.ts";
import { makeSseParser } from "./sse.ts";

export interface LiveData {
	conversations: AppConversationList;
	notes: AppNoteList;
	attention: AppAttentionResponse;
	approvals: AppApprovalsResponse;
	activity: AppActivityResponse;
	programs: OperatorProgramsResponse;
	delegations: OperatorDelegationsResponse;
	skills: SkillsResponse;
}

export interface LiveTopicState<T> {
	data: T | null;
	error: Error | null;
}

export type LiveFeedStatus = "connecting" | "live" | "lost";

type Topic = keyof LiveData;

const TOPIC_PATH: Record<Topic, string> = {
	conversations: "/api/app/conversations",
	notes: "/api/app/notes",
	attention: "/api/app/attention",
	approvals: "/api/app/approvals",
	activity: "/api/app/activity",
	programs: "/api/app/programs",
	delegations: "/api/app/delegations",
	skills: "/api/app/skills",
};

const TOPICS = Object.keys(TOPIC_PATH) as Topic[];

const versionEventSchema = z.object({
	type: z.literal("versions"),
	versions: z.record(z.string(), z.string()),
});

export interface LiveTiming {
	backoffMs: number;
	backoffMaxMs: number;
	lostMs: number;
	firstEventMs: number;
	byteMs: number;
	retryMs: number;
}

const DEFAULT_TIMING: LiveTiming = {
	backoffMs: 250,
	backoffMaxMs: 10_000,
	lostMs: 3_000,
	firstEventMs: 10_000,
	byteMs: 40_000,
	retryMs: 10_000,
};

interface TopicRun<T> {
	state: LiveTopicState<T>;
	held: string | null;
	announced: string | null;
	changes: number;
	seen: number;
	seq: number;
	inFlight: boolean;
	retained: number;
	lastFailed: boolean;
	unauthorized: boolean;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
}

function run<T>(): TopicRun<T> {
	return {
		state: { data: null, error: null },
		held: null,
		announced: null,
		changes: 0,
		seen: 0,
		seq: 0,
		inFlight: false,
		retained: 0,
		lastFailed: false,
		unauthorized: false,
		retryTimer: undefined,
	};
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

export class LiveStore {
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private readonly topics: { [K in Topic]: TopicRun<LiveData[K]> } = {
		conversations: run(),
		notes: run(),
		attention: run(),
		approvals: run(),
		activity: run(),
		programs: run(),
		delegations: run(),
		skills: run(),
	};

	private readonly listeners = new Set<() => void>();
	private readonly timing: LiveTiming;
	private statusValue: LiveFeedStatus = "connecting";
	private running = false;
	private offline = false;
	private connectTimer: ReturnType<typeof setTimeout> | undefined;
	private feed: AbortController | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private firstEventTimer: ReturnType<typeof setTimeout> | undefined;
	private byteTimer: ReturnType<typeof setTimeout> | undefined;
	private lostTimer: ReturnType<typeof setTimeout> | undefined;
	private backoff: number;
	private feedDead = true;

	constructor(
		private readonly token: string | null,
		timing: Partial<LiveTiming> = {},
	) {
		this.timing = { ...DEFAULT_TIMING, ...timing };
		this.backoff = this.timing.backoffMs;
	}

	topic<K extends Topic>(t: K): LiveTopicState<LiveData[K]> {
		return this.topics[t].state;
	}

	status(): LiveFeedStatus {
		return this.statusValue;
	}

	version(t: Topic): string | null {
		return this.topics[t].announced;
	}

	retain(t: Topic): () => void {
		const top = this.topics[t];
		top.retained += 1;
		if (
			!top.inFlight &&
			(top.state.data === null || this.statusValue !== "live" || top.lastFailed)
		) {
			void this.fetchTopic(t);
		}
		this.maybeFetch(t);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			top.retained -= 1;
		};
	}

	refresh(...topics: Topic[]): Promise<void> {
		return Promise.all(topics.map((t) => this.fetchTopic(t))).then(() => undefined);
	}

	update<K extends Topic>(t: K, fn: (data: LiveData[K] | null) => LiveData[K] | null): void {
		const top = this.topics[t];
		const wasInFlight = top.inFlight;
		top.seq += 1;
		top.inFlight = false;
		this.setState(t, { data: fn(top.state.data), error: top.state.error });
		if (wasInFlight) void this.fetchTopic(t);
	}

	start(): () => void {
		if (this.running) return this.stop;
		this.running = true;
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.onVisibleChange);
			window.addEventListener("pageshow", this.onVisibleChange);
			window.addEventListener("online", this.onOnline);
			window.addEventListener("offline", this.onOffline);
		}
		this.connectTimer = setTimeout(() => {
			this.connectTimer = undefined;
			this.connect();
		}, 0);
		return this.stop;
	}

	private readonly stop = (): void => {
		if (!this.running) return;
		this.running = false;
		this.offline = false;
		if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
		this.connectTimer = undefined;
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.onVisibleChange);
			window.removeEventListener("pageshow", this.onVisibleChange);
			window.removeEventListener("online", this.onOnline);
			window.removeEventListener("offline", this.onOffline);
		}
		this.dropFeed();
		this.clearReconnect();
		this.clearLost();
		for (const t of TOPICS) {
			const top = this.topics[t];
			if (top.retryTimer !== undefined) clearTimeout(top.retryTimer);
			top.retryTimer = undefined;
		}
	};

	private readonly onVisibleChange = (): void => {
		if (!this.running) return;
		if (visible()) {
			this.connect();
		} else {
			this.dropFeed();
		}
	};

	private readonly onOnline = (): void => {
		this.offline = false;
		this.connect();
	};

	private readonly onOffline = (): void => {
		if (!this.running) return;
		this.offline = true;
		this.abortFeed();
		this.connect();
	};

	private abortFeed(): void {
		if (this.feed !== undefined) this.feed.abort();
		this.endFeed();
		if (this.statusValue === "live") {
			this.statusValue = "connecting";
			this.emit();
		}
	}

	private dropFeed(): void {
		this.abortFeed();
		this.clearLost();
		if (this.statusValue !== "connecting") {
			this.statusValue = "connecting";
			this.emit();
		}
	}

	private endFeed(): void {
		this.feed = undefined;
		this.feedDead = true;
		if (this.firstEventTimer !== undefined) clearTimeout(this.firstEventTimer);
		this.firstEventTimer = undefined;
		if (this.byteTimer !== undefined) clearTimeout(this.byteTimer);
		this.byteTimer = undefined;
	}

	private clearReconnect(): void {
		if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private clearLost(): void {
		if (this.lostTimer !== undefined) clearTimeout(this.lostTimer);
		this.lostTimer = undefined;
	}

	private scheduleReconnect(): void {
		if (!this.running || !visible() || this.reconnectTimer !== undefined) return;
		const wait = this.backoff;
		this.backoff = Math.min(this.backoff * 2, this.timing.backoffMaxMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, wait);
	}

	private armLost(): void {
		if (this.lostTimer !== undefined || this.statusValue === "lost") return;
		this.lostTimer = setTimeout(() => {
			this.lostTimer = undefined;
			if (visible() && this.statusValue !== "live") {
				this.statusValue = "lost";
				this.emit();
			}
		}, this.timing.lostMs);
	}

	private connect(): void {
		if (!this.running || !visible() || this.feed !== undefined) return;
		this.clearReconnect();
		this.armLost();
		if (this.offline) return;
		const controller = new AbortController();
		this.feed = controller;
		this.feedDead = true;
		this.firstEventTimer = setTimeout(() => {
			this.firstEventTimer = undefined;
			this.kill(controller, "sent no event");
		}, this.timing.firstEventMs);
		this.touch();
		void this.pump(controller);
	}

	private async pump(controller: AbortController): Promise<void> {
		try {
			const res = await fetch("/api/app/live", {
				headers: this.token === null ? {} : { authorization: `Bearer ${this.token}` },
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (res.status === 401 || res.status === 403) {
				this.stop();
				void this.refresh("conversations");
				return;
			}
			const type = res.headers.get("content-type") ?? "";
			if (!res.ok || res.body === null || !type.startsWith("text/event-stream")) {
				throw new Error(`live feed failed (${res.status} ${type})`);
			}
			const parse = makeSseParser((data) => this.onFrame(data, controller));
			const reader = res.body.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (controller.signal.aborted) return;
				this.touch();
				if (done) break;
				parse(value);
			}
			throw new Error("live feed closed");
		} catch (err) {
			if (controller.signal.aborted || !this.running) return;
			console.warn("app live feed disconnected", err);
		} finally {
			if (this.feed === controller) this.endFeed();
		}
		if (this.running && !controller.signal.aborted) {
			if (this.statusValue === "live") {
				this.statusValue = "connecting";
				this.emit();
			}
			if (visible()) {
				this.armLost();
				this.scheduleReconnect();
			} else {
				this.dropFeed();
			}
		}
	}

	private kill(controller: AbortController, reason: string): void {
		if (this.feed !== controller) return;
		console.warn(`app live feed ${reason}; reconnecting`);
		this.endFeed();
		controller.abort();
		if (this.statusValue === "live") {
			this.statusValue = "connecting";
			this.emit();
		}
		this.armLost();
		this.scheduleReconnect();
	}

	private touch(): void {
		if (this.byteTimer !== undefined) clearTimeout(this.byteTimer);
		this.byteTimer = setTimeout(() => {
			this.byteTimer = undefined;
			if (this.feed !== undefined) this.kill(this.feed, "went silent");
		}, this.timing.byteMs);
	}

	private onFrame(data: string, controller: AbortController): void {
		if (controller !== this.feed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.kill(controller, "sent a bad frame");
			return;
		}
		const event = versionEventSchema.safeParse(parsed);
		if (!event.success) {
			this.kill(controller, "sent a bad frame");
			return;
		}
		if (!this.feedDead) {
			this.applyVersions(event.data.versions);
			return;
		}
		this.feedDead = false;
		this.backoff = this.timing.backoffMs;
		if (this.firstEventTimer !== undefined) clearTimeout(this.firstEventTimer);
		this.firstEventTimer = undefined;
		this.clearLost();
		this.statusValue = "live";
		for (const t of TOPICS) {
			const top = this.topics[t];
			if (top.lastFailed && top.retained > 0 && !top.inFlight) void this.fetchTopic(t);
		}
		this.applyVersions(event.data.versions);
		this.emit();
	}

	private applyVersions(versions: Record<string, string>): void {
		let moved = false;
		for (const t of TOPICS) {
			const next = versions[t];
			if (next === undefined) continue;
			const top = this.topics[t];
			if (top.announced !== next) {
				top.announced = next;
				top.changes += 1;
				moved = true;
			}
			this.maybeFetch(t);
		}
		if (moved) this.emit();
	}

	private maybeFetch(t: Topic): void {
		const top = this.topics[t];
		if (
			top.retained > 0 &&
			!top.inFlight &&
			top.announced !== null &&
			top.announced !== top.held &&
			top.changes > top.seen
		) {
			void this.fetchTopic(t);
		}
	}

	private async fetchTopic<K extends Topic>(t: K): Promise<void> {
		const top = this.topics[t];
		top.inFlight = true;
		top.seen = top.changes;
		const seq = ++top.seq;
		try {
			const res = await requestMeta<LiveData[K]>(this.token, TOPIC_PATH[t]);
			if (seq !== top.seq) return;
			top.inFlight = false;
			top.lastFailed = false;
			top.unauthorized = false;
			top.held = res.version;
			this.setState(t, { data: res.data, error: null });
			this.maybeFetch(t);
		} catch (err) {
			if (seq !== top.seq) return;
			top.inFlight = false;
			top.lastFailed = true;
			if (err instanceof ApiError && err.status === 401) top.unauthorized = true;
			this.setState(t, {
				data: top.state.data,
				error: err instanceof Error ? err : new Error(String(err)),
			});
			this.maybeFetch(t);
			this.scheduleRetry(t);
		}
	}

	private scheduleRetry(t: Topic): void {
		const top = this.topics[t];
		if (top.unauthorized || top.retained === 0 || top.retryTimer !== undefined) return;
		top.retryTimer = setTimeout(() => {
			top.retryTimer = undefined;
			if (!this.running || top.unauthorized || top.retained === 0 || !top.lastFailed) return;
			if (visible() && !top.inFlight) {
				void this.fetchTopic(t);
			} else {
				this.scheduleRetry(t);
			}
		}, this.timing.retryMs);
	}

	private setState<K extends Topic>(t: K, state: LiveTopicState<LiveData[K]>): void {
		this.topics[t].state = state;
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
