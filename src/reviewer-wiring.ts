// Boot wiring for the skill reviewer — index.ts binds, reviewer.ts
// rules. Resolves the shared System1 gate client and the Reviewer
// instance from config; sits above the reviewer family (evidence, gate,
// staging, propose, the class) so nothing below it knows boot.

import { isOneMinRoute, modelCallMaxRetries } from "./agent/onemin.ts";
import { cacheRouteFor, observedModel, resolveModel } from "./agent/providers.ts";
import { thinkingOptions } from "./agent/thinking.ts";
import type { AuthStore } from "./auth.ts";
import type { CacheObservation } from "./cache-observation.ts";
import type { ConfigRef } from "./config.ts";
import { captureConversationSettings, type ConversationStore } from "./conversation.ts";
import { Reviewer } from "./reviewer.ts";
import { cleanupStaging } from "./reviewer-staging.ts";
import { System1Client } from "./system1.ts";
import { log } from "./log.ts";

// One instance — the wiring returns the shared gate so the loop watchdog
// and the wake path can bind to it too.
export interface ReviewerWiringDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	observation: CacheObservation;
	paths: { workspace(): string; skills(): string; skillsProposed(): string };
	notify(conversationId: string, skills: string[]): Promise<void>;
	recordSources(conversationId: string, reviewId: string, skills: string[]): void;
}

export interface ReviewerWiring {
	// Shared System1 client — null when neither block is configured.
	gate: System1Client | null;
	reviewer: Reviewer | null;
}

export function wireReviewer(deps: ReviewerWiringDeps): ReviewerWiring {
	const { configRef, auth, store, observation, paths, notify, recordSources } = deps;
	// The hand-edited block boot-captures auth and threshold; the review
	// model resolves live (see ReviewerDeps.reviewModel).
	const reviewerBlock = configRef.current.reviewer;
	// The shared client exists whenever a `system1` block is set, and
	// `reviewer` still implies it — a system1-only config gains the
	// client it already named.
	const system1Block = configRef.current.system1;
	const gate =
		system1Block || reviewerBlock
			? new System1Client({
					auth: () => {
						// Auth resolves live per call; system1.auth wins,
						// reviewer.auth is the fallback for reviewer-only configs.
						const name = configRef.current.system1?.auth ?? reviewerBlock?.auth;
						if (name === undefined) throw new Error("system1 gate without auth");
						return auth.resolve(name);
					},
					...(system1Block?.model !== undefined ? { model: system1Block.model } : {}),
					...(system1Block?.baseUrl !== undefined ? { baseUrl: system1Block.baseUrl } : {}),
				})
			: null;
	if (reviewerBlock === undefined || gate === null) {
		if (gate !== null)
			log.info("system1 enabled", {
				model: system1Block?.model,
				baseUrl: system1Block?.baseUrl,
			});
		return { gate, reviewer: null };
	}
	const thresholds = {
		correction: reviewerBlock.thresholds?.correction ?? reviewerBlock.threshold,
		procedure: reviewerBlock.thresholds?.procedure ?? reviewerBlock.threshold,
	};
	log.info("reviewer enabled", {
		thresholds,
		queueCap: reviewerBlock.queueCap,
		evidence: reviewerBlock.evidence,
		system1: system1Block !== undefined,
	});
	// Staging from a killed run is garbage — clear before any review proposes.
	cleanupStaging(paths.workspace());
	return {
		gate,
		reviewer: new Reviewer({
			gate,
			thresholds,
			queueCap: reviewerBlock.queueCap,
			evidence: reviewerBlock.evidence,
			reviewModel: async (conversationId) => {
				const cfg = configRef.current;
				const conv = store.get(conversationId);
				if (!conv) throw new Error(`conversation ${conversationId} not found`);
				// The fallback pair (model + thinking) resolves the way the
				// turn's admission resolves it; a configured reviewer.model
				// overrides the model while the conversation's level still
				// clamps onto that model's ladder.
				const settings = captureConversationSettings(store, conv, cfg);
				const ref = cfg.reviewer?.model ?? settings.model;
				const maxRetries = modelCallMaxRetries(cfg, ref);
				// The review call carries tools; on 1min the wire rules bind
				// (reasoning_effort on the tools-forced ids, nothing elsewhere).
				// Other routes keep sending no options at all.
				const providerOptions = isOneMinRoute(cfg, ref)
					? thinkingOptions(cfg, ref, settings.thinking)
					: undefined;
				return {
					ref,
					...(maxRetries !== undefined ? { maxRetries } : {}),
					...(providerOptions !== undefined ? { providerOptions } : {}),
					model: observedModel(await resolveModel(cfg, auth, ref), {
						conversation: conversationId,
						purpose: "review",
						observation,
						route: cacheRouteFor(cfg, ref),
					}),
				};
			},
			store,
			skillsDir: paths.skills(),
			proposedDir: paths.skillsProposed(),
			workspaceDir: paths.workspace(),
			notify,
			recordSources,
		}),
	};
}
