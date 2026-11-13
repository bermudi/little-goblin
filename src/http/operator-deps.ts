import type { Config } from "../config-schema.ts";
import type { DelegationLifecycle } from "../delegation-lifecycle.ts";
import type { DelegationsStore } from "../delegations.ts";
import type { HindsightClient } from "../memory/hindsight.ts";
import type { MemoryContexts } from "../memory/mod.ts";
import type { BlockedRetention, MemoryQueue, MemoryQueueCounts } from "../memory/queue.ts";
import type { ProgramsStore } from "../programs.ts";
import type { SkillAction, SkillDecision } from "../skill-decisions.ts";
import type { SkillSourceRow } from "../skill-provenance.ts";
import type { System1Client } from "../system1.ts";
import type { ChatGptStatus } from "./operator-wire.ts";

export interface OperatorDeps {
	configRef: { current: Config };
	onConfigWritten(): void;
	beforeConfigWritten?(previous: Config, next: Config): void;
	memory?: {
		target?: { baseUrl: string; bankId: string };
		counts(): MemoryQueueCounts;
		deletingAll(): number;
		blockedDetail(): BlockedRetention[];
		lastRecallOk(): boolean | null;
		lastRecallAt(): string | null;
		client?: HindsightClient;
		clientForTarget?: (target: string) => HindsightClient | null;
		contexts?: MemoryContexts;
		queue?: MemoryQueue;
		/** null = the conversation no longer exists; title null = never named. */
		conversationTitle?: (id: string) => { title: string | null } | null;
		withWorkerPaused?: <T>(fn: () => Promise<T>) => Promise<T>;
	};
	programs?: Pick<ProgramsStore, "list">;
	delegations?: Pick<DelegationsStore, "list" | "active"> | null;
	// The lifecycle's operator stop; absent = the stop route answers 503.
	stopDelegation?: DelegationLifecycle["stopByOperator"];
	// auth.jsonl record names only — values never cross this surface.
	authNames?: () => string[];
	secrets?: {
		has(name: string): boolean;
		isCommand(name: string): boolean;
		store(name: string, value: string): void;
	};
	service?: {
		version: string;
		startedAt: string;
		restartHints(): string[];
	};
	skillSources?: {
		forConversation(conversationId: string): SkillSourceRow[];
		forgetConversation(conversationId: string): number;
		skillsDir: string;
		proposedDir: string;
	};
	skillDecisions?: {
		decide(skill: string, action: SkillAction): SkillDecision;
	};
	// Temp-skill preview (ruling 2026-10-21): the System One gate scores
	// the fetched body; absent = the endpoint answers 503. fetchImpl and
	// cacheRoot exist for tests.
	skillFetch?: {
		gate: Pick<System1Client, "decide">;
		fetchImpl?: typeof fetch;
		cacheRoot?: string;
	};
	// In-app ChatGPT sign-in (device code) — absent = the accounts
	// routes answer 503.
	chatgpt?: {
		status(): ChatGptStatus;
		start(): Promise<ChatGptStatus>;
		cancel(): ChatGptStatus;
		signOut(): ChatGptStatus;
	};
}

export type OperatorActor = { via: "mini-app"; userId: number } | { via: "app" };

// One operator request, as every area route sees it.
export interface OperatorRequest {
	deps: OperatorDeps;
	actor: OperatorActor;
	who: { userId?: number };
	req: Request;
	tail: string;
	url: URL;
}
