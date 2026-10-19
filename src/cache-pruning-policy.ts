// Policy schemas for persisted tool-result pruning — dependency-free on
// purpose: config.ts imports this for the cachePruning block, and a
// heavier import here (the marker builder lives in cache-pruning.ts)
// would cycle through web.ts's config read.

import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.enum(["zai", "openrouter", "anthropic", "openai", "logfare"]);

export const cachePruningProfileSchema = z
	.object({
		model: z.string().min(1),
		routeKey: digestSchema,
		settingsHash: digestSchema,
		idleAfterMs: z.number().int().positive(),
		reviewedAt: z.iso.datetime(),
		validUntil: z.iso.datetime(),
		evidence: z.enum(["documented-expiry", "empirical"]),
	})
	.strict()
	.superRefine((profile, ctx) => {
		if (Date.parse(profile.validUntil) <= Date.parse(profile.reviewedAt))
			ctx.addIssue({ code: "custom", message: "validUntil must follow reviewedAt" });
	});

export const cachePruningSchema = z
	.object({
		minimumInputTokens: z.number().int().positive(),
		keepRecentExchanges: z.number().int().min(2),
		minimumResultChars: z.number().int().positive(),
		retainHeadChars: z.number().int().nonnegative(),
		retainTailChars: z.number().int().nonnegative(),
		profiles: z.array(cachePruningProfileSchema).min(1),
	})
	.strict()
	.superRefine((policy, ctx) => {
		if (policy.retainHeadChars + policy.retainTailChars >= policy.minimumResultChars)
			ctx.addIssue({
				code: "custom",
				message: "retained head and tail must be smaller than minimumResultChars",
			});
		const keys = policy.profiles.map((profile) => `${profile.routeKey}:${profile.settingsHash}`);
		if (new Set(keys).size !== keys.length)
			ctx.addIssue({ code: "custom", message: "duplicate route/settings pruning profile" });
	});
export type CachePruningPolicy = z.infer<typeof cachePruningSchema>;
export type CachePruningProfile = z.infer<typeof cachePruningProfileSchema>;

export const cacheSourceReportSchema = z.object({
	reviewedAt: z.iso.datetime(),
	checkedAt: z.iso.datetime(),
	sources: z.array(
		z.object({
			id: sourceIdSchema,
			url: z.url(),
			status: z.enum(["unchanged", "changed", "unavailable", "unknown"]),
		}),
	),
});
