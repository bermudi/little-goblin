// Codex response receipts: rate-limit snapshots (headers and the
// in-stream codex.rate_limits event) and the request's identity echoes
// (x-request-id, openai-model). One module owns the wire parsing — a
// malformed or absent number nulls that window, never the whole receipt.

import type { AppQuota, AppQuotaWindow } from "../../http/app-wire.ts";
import { z } from "zod";

export type CodexQuota = AppQuota;

function headerWindow(headers: Headers, family: string): AppQuotaWindow | null {
	const used = Number.parseFloat(headers.get(`${family}-used-percent`) ?? "");
	if (!Number.isFinite(used)) return null;
	const minutes = Number.parseInt(headers.get(`${family}-window-minutes`) ?? "", 10);
	const reset = Number.parseInt(headers.get(`${family}-reset-at`) ?? "", 10);
	return {
		usedPercent: used,
		windowMinutes: Number.isFinite(minutes) ? minutes : null,
		resetsAt: Number.isFinite(reset) ? reset : null,
	};
}

export function quotaFromHeaders(headers: Headers): CodexQuota | null {
	const primary = headerWindow(headers, "x-codex-primary");
	const secondary = headerWindow(headers, "x-codex-secondary");
	if (primary === null && secondary === null) return null;
	const limitName = headers.get("x-codex-limit-name");
	return { limitName, primary, secondary };
}

// The SSE event is the fresher snapshot — when present it overrides the
// header read. Shape from upstream rate_limits.rs.
const eventWindowSchema = z
	.object({
		used_percent: z.number(),
		window_minutes: z.number().nullish(),
		reset_at: z.number().nullish(),
	})
	.nullish();

const rateLimitsEventSchema = z.object({
	type: z.literal("codex.rate_limits"),
	rate_limits: z.object({
		primary: eventWindowSchema,
		secondary: eventWindowSchema,
	}),
	limit_name: z.string().nullish(),
});

type EventWindow = z.infer<typeof eventWindowSchema>;

function eventWindow(w: EventWindow): AppQuotaWindow | null {
	if (w === null || w === undefined) return null;
	return {
		usedPercent: w.used_percent,
		windowMinutes: w.window_minutes ?? null,
		resetsAt: w.reset_at ?? null,
	};
}

export function quotaFromEvent(event: unknown): CodexQuota | null {
	const parsed = rateLimitsEventSchema.safeParse(event);
	if (!parsed.success) return null;
	return {
		limitName: parsed.data.limit_name ?? null,
		primary: eventWindow(parsed.data.rate_limits.primary),
		secondary: eventWindow(parsed.data.rate_limits.secondary),
	};
}

// Reading the quota back off a finish part's providerMetadata — the
// adapter stamps `codex: { quota: AppQuota }`; anything else is not a
// receipt.
const quotaWindowSchema = z.object({
	usedPercent: z.number(),
	windowMinutes: z.number().nullable(),
	resetsAt: z.number().nullable(),
});

const quotaMetaSchema = z.object({
	quota: z.object({
		limitName: z.string().nullable(),
		primary: quotaWindowSchema.nullable(),
		secondary: quotaWindowSchema.nullable(),
	}),
});

export function quotaFromMetadata(meta: unknown): CodexQuota | null {
	if (typeof meta !== "object" || meta === null) return null;
	const codex = (meta as Record<string, unknown>).codex;
	const parsed = quotaMetaSchema.safeParse(codex);
	if (!parsed.success) return null;
	return parsed.data.quota;
}
