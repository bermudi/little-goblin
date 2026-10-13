// Image generation — the OpenAI images wire behind the generate_image
// tool (design/tools.md → Image generation): POST
// {baseUrl}/images/generations with {model, prompt, n, size?,
// response_format: "b64_json"}, image bytes home in one response — no
// second fetch on an expiring URL. Any provider kind carrying a baseUrl
// (openai-compatible/responses) can serve it; the config block's
// superRefine keeps the ref on one. Hand-rolled like the speech
// engines — no SDK. The logfare fixture pins the documented shape and
// is unverified live until a key is provisioned. Resolved keys never
// enter logs.

import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import { splitModelRef } from "../config.ts";
import { log } from "../log.ts";
import { readBytesCapped, readTextCapped } from "./tools/web.ts";
import { renderError } from "./transcribe-cloud.ts";

// Flux-scale renders take tens of seconds — the vision budget doubled,
// since a wedged request pins the turn's serial lane.
export const IMAGE_TIMEOUT_MS = 240_000;
// b64 inflates ~33%; four 4MP pngs still fit a 64 MiB envelope. The cap
// only guards a misbehaving gateway.
const RESPONSE_CAP = 64 * 1024 * 1024;
const ERROR_BODY_CAP = 64 * 1024;
export const IMAGE_MAX_N = 4;

// The OpenAI shape: only b64_json rides the wire (we ask for it and
// providers ignore unknown request fields), but an item carrying only
// `url` is still a valid response we decline — image bytes must arrive
// in-body, not via a second fetch we never budgeted.
const imagesResponse = z.object({
	data: z
		.array(z.object({ b64_json: z.string().min(1).optional() }))
		.min(1),
});

export interface ImageInput {
	prompt: string;
	/** "WxH" — overrides the image block's default size when present. */
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
	/** Test door over the provider edge (production: fetch). */
	fetchFn?: typeof fetch | undefined;
	/** Test door over the timeout (production: IMAGE_TIMEOUT_MS). */
	timeoutMs?: number | undefined;
}

// Magic bytes pick the extension — a provider that re-encodes silently
// must not name a jpeg ".png" in the operator's downloads.
const SNIFFS: { bytes: number[]; mediaType: string; ext: string }[] = [
	{ bytes: [0x89, 0x50, 0x4e, 0x47], mediaType: "image/png", ext: "png" },
	{ bytes: [0xff, 0xd8, 0xff], mediaType: "image/jpeg", ext: "jpg" },
	{ bytes: [0x47, 0x49, 0x46, 0x38], mediaType: "image/gif", ext: "gif" },
	// RIFF container: bytes 0-3 "RIFF", 8-11 "WEBP".
	{ bytes: [0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50], mediaType: "image/webp", ext: "webp" },
];

function sniffGenerated(bytes: Uint8Array): { mediaType: string; ext: string } | null {
	for (const s of SNIFFS) {
		if (bytes.byteLength < s.bytes.length) continue;
		if (s.bytes.every((b, i) => b === -1 || bytes[i] === b)) {
			return { mediaType: s.mediaType, ext: s.ext };
		}
	}
	return null;
}

/** Config → engine. Resolves the image block's provider ref to a
 *  baseUrl + auth record; both lookups throw named errors (the
 *  superRefine already refused them at parse, so a throw here means a
 *  hand edit raced a running config). */
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
			signal: AbortSignal.timeout(deps.timeoutMs ?? IMAGE_TIMEOUT_MS),
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
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		throw new Error(
			`image: response is not JSON — ${new TextDecoder().decode(raw).replace(/\s+/g, " ").trim().slice(0, 300)}`,
		);
	}
	const parsed = imagesResponse.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`image: unexpected response shape — ${new TextDecoder().decode(raw).replace(/\s+/g, " ").trim().slice(0, 300)}`,
		);
	}
	const images: GeneratedImage[] = [];
	for (const item of parsed.data.data) {
		if (item.b64_json === undefined) {
			throw new Error("image: provider returned a url item — only b64_json responses are supported");
		}
		const bytes = Buffer.from(item.b64_json, "base64");
		if (bytes.byteLength === 0) throw new Error("image: empty image payload");
		const sniff = sniffGenerated(bytes);
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
