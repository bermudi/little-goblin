// Delegation family contracts and boot wiring. The family's modules import
// these types: delegation-paths.ts (the lead predicate and note),
// delegation-notices.ts (notice bodies + delivery), delegation-actions.ts
// (the four verbs), delegation-watcher.ts (the scan lifecycle).

import {
	type Delegation,
	type DelegationsStore,
	type DelegationVerdict,
	openDelegations,
} from "./delegations.ts";
import { makeT3, type T3 } from "./t3.ts";
import type { ConfigRef } from "./config.ts";
import type { DelegationConfig } from "./config-schema.ts";
import type { Conversation } from "./conversation-read.ts";
import type { DelegateToolDeps, DelegationPin } from "./agent/tools/delegate.ts";
import { wake, wakeApp, type WakeDeps } from "./wake.ts";
import type { GithubIssue, PrReadiness } from "./pr-readiness.ts";

export interface DelegationLifecycleDeps {
	delegations: DelegationsStore;
	// The one t3 adapter — boot-frozen with the config snapshot.
	t3: T3;
	// True means the notice landed; false is retried by the watcher.
	wake(address: { chatId: number; threadId: number | null }, text: string): boolean;
	wakeApp(conversationId: string, text: string): boolean;
	// A linked delegation's settlement lands as a worker report before its
	// notice wakes the conversation (responsibility-runs.ts). A throw leaves
	// the row eligible for retry; the report is keyed, so a retry files once.
	settled?: (d: Delegation, verdict: DelegationVerdict, body: string, readiness?: PrReadiness) => void;
	responsibilityRevision?: (id: string) => number | null;
	readiness?: (issue: GithubIssue) => Promise<PrReadiness>;
	watchResponsibility?: (id: string, revision: number | null) => boolean;
}

export interface LaunchInput {
	// The configured harness: its T3 provider instance and model.
	harness: { name: string; provider: string; model: string };
	task: string;
	cwd: string;
	name: string;
	address: { chatId: number; threadId: number | null };
	appConversation?: string;
	responsibilityId?: string;
	role?: string;
	issue?: GithubIssue;
}

export type LaunchOutcome =
	| { kind: "started"; delegation: Delegation }
	| { kind: "stopped"; delegation: Delegation }
	// `why` is the CLI's error; no untrusted screen exists on this wire.
	| { kind: "failed"; delegation: Delegation; why: string };

export type SendRefusal = "stopped" | "starting" | "never launched";

export type SendOutcome =
	| { kind: "sent"; delegation: Delegation }
	| { kind: "no row"; id: number }
	| { kind: "refused"; id: number; why: SendRefusal }
	| { kind: "send failed"; id: number; error: string };

export type StopOutcome =
	| { kind: "stopped"; delegation: Delegation; notes: string[] }
	// T3 Code has no stop verb (v0.1.9) — a live thread cannot be ended
	// from goblin. Reported honestly, never faked.
	| { kind: "unavailable"; delegation: Delegation }
	| { kind: "no row"; id: number };

export type ReadOutcome =
	| { kind: "thread"; delegation: Delegation; messages: { role: string; text: string }[] }
	| { kind: "no row"; id: number }
	| { kind: "never launched"; delegation: Delegation }
	| { kind: "unreadable"; id: number; error: string };

export interface DelegationLifecycle {
	launch(input: LaunchInput): Promise<LaunchOutcome>;
	// Follow-up messages: a busy thread queues the text as its next
	// turn, a waiting one takes it as the answer.
	send(id: number, text: string): Promise<SendOutcome>;
	// t3 has no stop verb; a finished row's stop is row cleanup only.
	stop(id: number): Promise<StopOutcome>;
	// The operator's stop from the app: same stop, then a notice so the
	// owning conversation records it as theirs.
	stopByOperator(id: number): Promise<StopOutcome>;
	// The thread's latest messages — untrusted; callers fence.
	read(id: number, messages: number): Promise<ReadOutcome>;
	list(): Delegation[];
	// Run one watcher scan immediately.
	tick(): Promise<void>;
	// Joins the in-flight scan and every in-flight lifecycle op before
	// store shutdown; the t3 server owns running threads.
	stopTicker(): Promise<void>;
}

// ---------- boot wiring (index.ts binds, this module rules) ----------

// Boot-frozen: the delegations store, the t3 adapter and the config
// snapshot are one object — a live config read can only hide the
// delegate tool next turn, never launch on a harness the boot snapshot
// lacks (spinoff.ts owns the pin).
export interface DelegationWiringDeps {
	config: DelegationConfig | undefined;
	configRef: ConfigRef;
	dbPath(): string;
	// Late-bound: the lifecycle is built after the runtime; the delegate
	// tool resolves it per call, never at wire time.
	lifecycle(): DelegationLifecycle;
	pin(conv: Conversation, name: string): DelegationPin;
}

export interface DelegationWiring {
	delegations: DelegationsStore | null;
	t3: T3;
	delegateDeps(
		conv: Conversation,
		workdir: string,
	): Omit<DelegateToolDeps, "mountedSubagents"> | undefined;
}

export function wireDelegation(deps: DelegationWiringDeps): DelegationWiring {
	const { config: delegationBoot, pin } = deps;
	const delegations = delegationBoot ? openDelegations(deps.dbPath()) : null;
	const t3 = makeT3();
	const delegateDeps = (
		conv: Conversation,
		workdir: string,
	): Omit<DelegateToolDeps, "mountedSubagents"> | undefined => {
		if (
			delegationBoot === undefined ||
			deps.configRef.current.delegation === undefined ||
			delegations === null
		) {
			return undefined;
		}
		return {
			lifecycle: deps.lifecycle(),
			config: delegationBoot,
			// The delegation cwd anchors at the turn's working directory —
			// under a project that's the project's dir, which names the T3
			// project the thread starts in.
			workspaceDir: workdir,
			pin: (name: string) => pin(conv, name),
		};
	};
	return { delegations, t3, delegateDeps };
}

export function delegationWake(deps: WakeDeps): Pick<DelegationLifecycleDeps, "wake" | "wakeApp"> {
	return {
		wake: (address, text) => wake(deps, address, text, { dmTrigger: "current" }),
		wakeApp: (conversationId, text) => wakeApp(deps, conversationId, text),
	};
}
