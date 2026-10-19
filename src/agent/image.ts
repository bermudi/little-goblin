// The OpenAI images wire behind generate_image: POST
// {baseUrl}/images/generations with {model, prompt, n, size?,
// response_format: "b64_json"} — image bytes home in one response; a
// URL would expire before a second fetch. Any provider kind carrying a
// baseUrl can serve it; the config block's superRefine keeps the ref on
// one. The logfare fixture pins the documented shape, unverified live
// until a key is provisioned. Resolved keys never enter logs.

import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import { splitModelRef } from "../config.ts";
import { log } from "../log.ts";
import { sniffImageBytes } from "./sniff.ts";
import { readBytesCapped, readTextCapped } from "./tools/web.ts";
import { renderError } from "./transcribe-cloud.ts";

// Flux-scale renders take tens of seconds; a wedged request pins the
// turn's serial lane — the vision budget doubled.
export const IMAGE_TIMEOUT_MS = 240_000;
// b64 inflates ~33%; four 4MP pngs still fit a 64 MiB envelope. The cap
// only guards a misbehaving gateway.
const RESPONSE_CAP = 64 * 1024 * 1024;
const ERROR_BODY_CAP = 64 * 1024;
export const IMAGE_MAX_N = 4;

// Only b64_json rides the wire (providers ignore unknown request
// fields) — but a url-only item is still a valid response we decline:
// image bytes must arrive in-body, not via a second fetch we never
// budgeted.
const imagesResponse = z.object({
	data: z.array(z.object({ b64_json: z.string().min(1).optional() })).min(1),
});

// Bound before scrubbing — a whitespace-collapse over a garbage body
// up to RESPONSE_CAP would build a full-size string for 300 kept chars.
const bodyPreview = (s: string): string =>
	s.slice(0, 2048).replace(/\s+/g, " ").trim().slice(0, 300);

export interface ImageInput {
	prompt: string;
	/** "WxH" — overrides the image block's default size. */
	size?: string | undefined;
	n?: number | undefined;
}

export interface GeneratedImage {
	bytes: Uint8Array;
	mediaType: string;
	/** Filename suffix matching the sniffed container ("png"…). */
	ext: string;
}

export interface ImageCallDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	conversation: string;
	/** The turn's abort signal (/stop, a superseded turn) — raced with
	 *  the timeout so a killed turn cancels the billed call. */
	signal?: AbortSignal | undefined;
	/** Test door over the provider edge (production: fetch). */
	fetchFn?: typeof fetch | undefined;
	/** Test door over the timeout (production: IMAGE_TIMEOUT_MS). */
	timeoutMs?: number | undefined;
}

/** Both lookups throw named errors — the config's superRefine already
 *  refused them at parse, so a throw here means a hand edit raced a
 *  running config. */
function imageEndpoint(deps: ImageCallDeps): { url: string; modelId: string; authRef: string } {
	const cfg = deps.configRef.current.image;
	if (!cfg) throw new Error("image block absent — the tool should not be registered");
	const { provider, modelId } = splitModelRef(cfg.model);
	const p = deps.configRef.current.providers[provider];
	if (p === undefined) {
		throw new Error(`image: model names a provider which is not in providers (${provider})`);
	}
	if (!("baseUrl" in p)) {
		throw new Error(`image: provider "${provider}" has no baseUrl`);
	}
	return {
		url: `${p.baseUrl.replace(/\/+$/, "")}/images/generations`,
		modelId,
		authRef: p.auth,
	};
}

export async function generateImages(
	input: ImageInput,
	deps: ImageCallDeps,
): Promise<GeneratedImage[]> {
	const endpoint = imageEndpoint(deps);
	const key = await deps.auth.resolve(endpoint.authRef);
	const fetchFn = deps.fetchFn ?? fetch;
	const n = input.n ?? 1;
	const size = input.size ?? deps.configRef.current.image?.size;

	const started = Date.now();
	let res: Response;
	try {
		res = await fetchFn(endpoint.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: endpoint.modelId,
				prompt: input.prompt,
				...(size !== undefined ? { size } : {}),
				...(n !== 1 ? { n } : {}),
				response_format: "b64_json",
			}),
			signal: AbortSignal.any([
				...(deps.signal ? [deps.signal] : []),
				AbortSignal.timeout(deps.timeoutMs ?? IMAGE_TIMEOUT_MS),
			]),
		});
	} catch (err) {
		throw new Error(`image: request failed (${endpoint.url}) — ${(err as Error).message}`);
	}
	if (!res.ok) {
		const { text } = await readTextCapped(res, ERROR_BODY_CAP);
		throw renderError("image", res.status, text);
	}
	const { tooLarge, bytes: raw } = await readBytesCapped(res, RESPONSE_CAP);
	if (tooLarge) throw new Error(`image: response over ${RESPONSE_CAP} bytes`);
	const text = new TextDecoder().decode(raw);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`image: response is not JSON — ${bodyPreview(text)}`);
	}
	const parsed = imagesResponse.safeParse(json);
	if (!parsed.success) {
		throw new Error(`image: unexpected response shape — ${bodyPreview(text)}`);
	}
	const images: GeneratedImage[] = [];
	for (const item of parsed.data.data) {
		if (item.b64_json === undefined) {
			throw new Error(
				"image: provider returned a url item — only b64_json responses are supported",
			);
		}
		const bytes = Buffer.from(item.b64_json, "base64");
		if (bytes.byteLength === 0) throw new Error("image: empty image payload");
		// Magic bytes pick the extension — a provider that re-encodes
		// must not name a jpeg ".png" in the operator's downloads.
		const sniff = sniffImageBytes(bytes);
		if (sniff === null) {
			throw new Error(
				`image: unrecognized image bytes (first bytes ${Array.from(bytes.subarray(0, 4)).join(",")})`,
			);
		}
		images.push({ bytes, mediaType: sniff.mediaType, ext: sniff.ext });
	}
	// A generation call is a cost line, same rule as model calls.
	log.info("image generation call", {
		conversation: deps.conversation,
		model: deps.configRef.current.image?.model,
		prompt: input.prompt.slice(0, 120),
		images: images.length,
		bytes: images.reduce((sum, i) => sum + i.bytes.byteLength, 0),
		durationMs: Date.now() - started,
	});
	return images;
}
