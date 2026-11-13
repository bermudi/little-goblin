import { z } from "zod";

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

export function fail(error: string, status: number): Response {
	return json({ error }, status);
}

export const methodNotAllowed = (): Response => fail("method", 405);

// The body parsed by `schema`, or the 400/422 to answer with.
export async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return fail("bad json", 400);
	}
	const parsed = schema.safeParse(raw);
	return parsed.success ? parsed.data : fail(z.prettifyError(parsed.error), 422);
}

export const SEGMENT_SCHEMA = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^/\\\x00-\x1f\x7f]+$/u)
	.refine((v) => v !== "." && v !== "..");
