// Delegation family contracts and boot wiring. The family's modules import
// these types: delegation-paths.ts (target/report seam), delegation-notices.ts
// (notice bodies + delivery), delegation-actions.ts (the six verbs),
// delegation-watcher.ts (the scan lifecycle).

import {
	type Delegation,
	type DelegationsStore,
	type DelegationVerdict,
	openDelegations,
} from "./delegations.ts";
import { makeHerdr, makeOperatorHerdr, type Herdr, type OperatorHerdr } from "./herdr.ts";
import type { ConfigRef } from "./config.ts";
import type { DelegationConfig } from "./config-schema.ts";
import type { Conversation } from "./conversation-read.ts";
import type { DelegateToolDeps, DelegationPin } from "./agent/tools/delegate.ts";
import { wake, wakeApp, type WakeDeps } from "./wake.ts";
import type { GithubIssue, PrReadiness } from "./pr-readiness.ts";

export interface DelegationLifecycleDeps {
	delegations: DelegationsStore;
	// Own local herdr session; never selected by config.
	herdr: Herdr;
	// Target adapters and target-side paths; null uses the local herdr.
	targets: ReadonlyMap<string, DelegationTargetDeps>;
	delegationsDir: string;
	// True means the notice landed; false is retried by the watcher.
	wake(address: { chatId: number; threadId: number | null }, text: string): boolean;
	wakeApp(conversationId: string, text: string): boolean;
	homeDir: string;
	// A linked delegation's settlement lands as a worker report before its
	// notice wakes the conversation (responsibility-runs.ts). A throw leaves
	// the row eligible for retry; the report is keyed, so a retry files once.
	settled?: (d: Delegation, verdict: DelegationVerdict, body: string, readiness?: PrReadiness) => void;
	responsibilityRevision?: (id: string) => number | null;
	readiness?: (issue: GithubIssue) => Promise<PrReadiness>;
	watchResponsibility?: (id: string, revision: number | null) => boolean;
}

export interface DelegationTargetDeps {
	// Saved remote-machine label; absent means another local session.
	machine?: string;
	session?: string;
	// Target-side cwd/report root; remote paths are not local files.
	root?: string;
	herdr: Herdr;
}

export interface LaunchInput {
	harness: { name: string; kind: string; args: string[] };
	task: string;
	cwd: string;
	name: string;
	// Target label; null means local.
	target?: string | null;
	address: { chatId: number; threadId: number | null };
	appConversation?: string;
	responsibilityId?: string;
	role?: string;
	issue?: GithubIssue;
}

export type LaunchOutcome =
	| { kind: "started"; delegation: Delegation }
	| { kind: "stopped"; delegation: Delegation }
	// Failure screen is untrusted agent output; the caller fences it.
	| { kind: "failed"; delegation: Delegation; why: string; screen?: string }
	// Blocked startup keeps the task owed until its dialog clears.
	| { kind: "parked"; delegation: Delegation };

export type SendRefusal = "stopped" | "starting" | "never launched" | "task never sent";

export type SendOutcome =
	| { kind: "sent"; delegation: Delegation }
	| { kind: "no row"; id: number }
	| { kind: "refused"; id: number; why: SendRefusal }
	| { kind: "prompt failed"; error: string }
	| { kind: "stopped mid send"; id: number };

export type AnswerOutcome =
	| { kind: "sent"; delegation: Delegation }
	| { kind: "no row"; id: number }
	| { kind: "refused"; id: number; why: SendRefusal }
	| { kind: "key failed"; id: number; error: string };

export type StopOutcome =
	| { kind: "stopped"; delegation: Delegation; notes: string[] }
	| { kind: "still running"; delegation: Delegation; notes: string[] }
	| { kind: "no row"; id: number };

export type ReadOutcome =
	| { kind: "screen"; delegation: Delegation; screen: string }
	| { kind: "no row"; id: number }
	| { kind: "never launched"; delegation: Delegation }
	| { kind: "unreadable"; id: number; error: string };

export interface DelegationLifecycle {
	launch(input: LaunchInput): Promise<LaunchOutcome>;
	// Follow-up prompts reset the baseline and return the row to running.
	send(id: number, text: string): Promise<SendOutcome>;
	// Only the explicitly whitelisted key reaches a blocked agent; the
	// watcher observes the seq effect and owns every transition.
	answer(id: number, key: string): Promise<AnswerOutcome>;
	// Gone targets still return stopped with a warning; a failed close
	// triggers an agent liveness check.
	stop(id: number): Promise<StopOutcome>;
	// The operator's stop from the app: same stop, then a notice so the
	// owning conversation records it as theirs.
	stopByOperator(id: number): Promise<StopOutcome>;
	// Screen output is raw; callers fence it as untrusted agent data.
	read(id: number, lines: number): Promise<ReadOutcome>;
	reportPath(id: number): string;
	list(): Delegation[];
	// Run one watcher scan immediately.
	tick(): Promise<void>;
	// Joins the in-flight scan and every in-flight lifecycle op before
	// store shutdown; herdr owns running agents.
	stopTicker(): Promise<void>;
}

// ---------- boot wiring (index.ts binds, this module rules) ----------

// Boot-frozen: the delegations store, the local "goblin" herdr adapter and
// every configured target's adapter are one snapshot — a live config read can
// only hide the delegate tool next turn, never retarget a launch into the old
// adapter's session (spinoff.ts owns the pin).
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
	herdr: Herdr | null;
	operatorHerdr: OperatorHerdr;
	targets: Map<string, DelegationTargetDeps>;
	delegateDeps(
		conv: Conversation,
		workdir: string,
	): Omit<DelegateToolDeps, "mountedSubagents"> | undefined;
}

export function wireDelegation(deps: DelegationWiringDeps): DelegationWiring {
	const { config: delegationBoot, configRef, pin } = deps;
	const delegations = delegationBoot ? openDelegations(deps.dbPath()) : null;
	// "goblin" is the local unit's --session — the default target, never a config knob.
	const herdr = delegationBoot ? makeHerdr({ session: "goblin" }) : null;
	// The operator's own `default` session needs no delegation config —
	// the herdr tool mounts for every personal conversation.
	const operatorHerdr = makeOperatorHerdr();
	const targets = new Map<string, DelegationTargetDeps>();
	if (delegationBoot && herdr !== null) {
		for (const [label, t] of Object.entries(delegationBoot.machines ?? {})) {
			targets.set(label, {
				...(t.machine !== undefined ? { machine: t.machine } : { session: t.session! }),
				...(t.root !== undefined ? { root: t.root } : {}),
				herdr: makeHerdr(
					t.machine !== undefined ? { machine: t.machine } : { session: t.session! },
				),
			});
		}
	}
	const delegateDeps = (
		conv: Conversation,
		workdir: string,
	): Omit<DelegateToolDeps, "mountedSubagents"> | undefined => {
		if (
			delegationBoot === undefined ||
			configRef.current.delegation === undefined ||
			delegations === null ||
			herdr === null
		) {
			return undefined;
		}
		return {
			lifecycle: deps.lifecycle(),
			config: delegationBoot,
			// Relative cwd in delegation harness args anchors at the turn's
			// working directory — under a project that's the project's dir.
			workspaceDir: workdir,
			pin: (name: string) => pin(conv, name),
		};
	};
	return { delegations, herdr, operatorHerdr, targets, delegateDeps };
}

export function delegationWake(deps: WakeDeps): Pick<DelegationLifecycleDeps, "wake" | "wakeApp"> {
	return {
		wake: (address, text) => wake(deps, address, text, { dmTrigger: "current" }),
		wakeApp: (conversationId, text) => wakeApp(deps, conversationId, text),
	};
}
