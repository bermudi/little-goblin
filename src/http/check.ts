import { z } from "zod";
import type { System1Client } from "../system1.ts";
import { checkInjection, verdictLine, type InjectionVerdict } from "../injection.ts";
import { log } from "../log.ts";

export interface InjectionCheckGate {
	gate: Pick<System1Client, "decide">;
}

export interface InjectionCheckResponse {
	status: InjectionVerdict["status"];
	injection: number | null;
	severity: number | null;
	verdict: string;
}

const CHECK_BODY_CAP = 64 * 1024;
const CHECK_MAX_CHARS = 64000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(req: Request): boolean {
	const host = req.headers.get("host") ?? "";
	const name = host.startsWith("[")
		? host.slice(0, host.indexOf("]") + 1)
		: host.replace(/:\d+$/, "");
	return LOOPBACK_HOSTS.has(name.toLowerCase());
}

export async function readBodyBytesCapped(req: Request, cap: number): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > cap) return null;
	const body = req.body;
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > cap) return null;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

export async function readBodyCapped(
	req: Request,
	cap: number,
): Promise<{ text: string; oversize: boolean }> {
	const bytes = await readBodyBytesCapped(req, cap);
	if (bytes === null) return { text: "", oversize: true };
	return { text: new TextDecoder().decode(bytes), oversize: false };
}

const checkBodySchema = z.object({
	text: z.string().min(1).max(CHECK_MAX_CHARS),
});

const NO_STORE = { "cache-control": "no-store" };

export async function serveInjectionCheck(
	req: Request,
	dep: InjectionCheckGate | undefined,
): Promise<Response> {
	if (!isLoopbackHost(req)) {
		return Response.json({ error: "loopback only" }, { status: 403, headers: NO_STORE });
	}
	if (req.method !== "POST") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	if (!dep) {
		return Response.json(
			{ error: "injection checker not configured" },
			{ status: 503, headers: NO_STORE },
		);
	}
	const body = await readBodyCapped(req, CHECK_BODY_CAP);
	if (body.oversize) {
		return Response.json({ error: "body too large" }, { status: 400, headers: NO_STORE });
	}
	let text: string;
	try {
		const parsed: unknown = body.text ? JSON.parse(body.text) : undefined;
		const shaped = checkBodySchema.safeParse(parsed);
		if (!shaped.success) {
			return Response.json(
				{ error: "expected {text: string} of length 1..64000" },
				{ status: 400, headers: NO_STORE },
			);
		}
		text = shaped.data.text;
	} catch {
		return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
	}
	const t0 = Date.now();
	try {
		const v = await checkInjection(dep.gate, text);
		const res: InjectionCheckResponse = {
			status: v.status,
			injection: v.injection,
			severity: v.severity,
			verdict: verdictLine(v),
		};
		log.info("injection check served", { status: v.status, ms: Date.now() - t0 });
		return Response.json(res, { headers: NO_STORE });
	} catch (err) {
		log.error("injection check failed", err, { ms: Date.now() - t0 });
		return Response.json({ error: "injection check failed" }, { status: 500, headers: NO_STORE });
	}
}
