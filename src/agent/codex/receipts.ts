// Codex response receipts: rate-limit snapshots from the x-codex-*
// response headers (the backend sends no in-stream rate-limit event
// over HTTP — live probe 2026-11-19). One module owns the wire parsing —
// a malformed or absent number nulls that window, never the whole
// receipt.

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
