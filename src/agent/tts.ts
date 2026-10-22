import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef, TtsConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRunBinary, spawnProc } from "../proc.ts";
import { logfareSpeech, mimoSpeech, openrouterSpeech } from "./tts-cloud.ts";

const CHUNK_LIMIT = 10_000;
const OUTPUT_FORMAT = "webm-24khz-16bit-mono-opus";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "143.0.3650.75";
// Audio lands only at turn.end, so the timeout must cover the whole
// synthesis, not idle gaps. Synthesis runs ~74 chars/s (measured
// 2026-09-27): 30s floor for handshake + short text, 40ms/char ≈ 3x
// headroom, capped so a wedged socket can't hold the voice lane (the
// 10k-char CHUNK_LIMIT needs ~135s).
const EDGE_TIMEOUT_BASE_MS = 30_000;
const EDGE_TIMEOUT_PER_CHAR_MS = 40;
const EDGE_TIMEOUT_MAX_MS = 300_000;

function edgeTimeoutMs(chars: number): number {
	return Math.min(EDGE_TIMEOUT_BASE_MS + chars * EDGE_TIMEOUT_PER_CHAR_MS, EDGE_TIMEOUT_MAX_MS);
}
const LONG_URL = /https?:\/\/\S{61,}/g;
const CODE_BLOCK = /```(?:[^\n]*)\n?([\s\S]*?)```/g;

// ---------- voice cast ----------

// en/es by design — the operator's cast. Exclusive diacritics and
// function words decide; short or ambiguous text resolves to no
// language and the default voice speaks.
const ES_WORDS = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"que",
	"de",
	"del",
	"al",
	"y",
	"o",
	"es",
	"está",
	"están",
	"soy",
	"eres",
	"somos",
	"esto",
	"eso",
	"esta",
	"este",
	"estos",
	"esa",
	"esas",
	"hola",
	"gracias",
	"pero",
	"como",
	"más",
	"muy",
	"para",
	"por",
	"con",
	"sin",
	"sobre",
	"entre",
	"cuando",
	"porque",
	"si",
	"sí",
	"también",
	"tampoco",
	"nada",
	"algo",
	"todo",
	"todos",
	"bien",
	"aquí",
	"ahí",
	"allí",
	"ahora",
	"después",
	"antes",
	"luego",
	"ya",
	"aún",
	"día",
	"año",
	"vez",
	"veces",
	"dos",
	"tres",
	"quiero",
	"puedo",
	"puedes",
	"vamos",
	"listo",
	"lista",
	"hecho",
	"claro",
	"cierto",
	"vale",
	"tengo",
	"tiene",
	"tienes",
	"fue",
	"hay",
	"dónde",
	"cómo",
	"cuál",
	"quién",
	"bueno",
	"buena",
	"otro",
	"otra",
	"solo",
	"incluso",
	"punto",
	"verdad",
	"nuevo",
	"nueva",
	"menos",
	"cada",
	"nos",
	"les",
	"mi",
	"tu",
	"te",
	"su",
	"sus",
	"era",
	"ser",
	"va",
	"voy",
]);
const EN_WORDS = new Set([
	"the",
	"and",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"am",
	"do",
	"does",
	"did",
	"done",
	"have",
	"has",
	"had",
	"will",
	"would",
	"can",
	"could",
	"should",
	"shall",
	"may",
	"might",
	"must",
	"of",
	"to",
	"in",
	"on",
	"at",
	"by",
	"for",
	"with",
	"from",
	"about",
	"into",
	"over",
	"after",
	"before",
	"between",
	"out",
	"off",
	"up",
	"down",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"there",
	"here",
	"i",
	"you",
	"your",
	"yours",
	"we",
	"us",
	"our",
	"they",
	"them",
	"their",
	"he",
	"she",
	"his",
	"her",
	"him",
	"what",
	"which",
	"who",
	"when",
	"where",
	"why",
	"how",
	"if",
	"then",
	"than",
	"so",
	"because",
	"but",
	"or",
	"not",
	"nor",
	"very",
	"too",
	"also",
	"just",
	"only",
	"more",
	"most",
	"some",
	"any",
	"all",
	"both",
	"each",
	"other",
	"same",
	"such",
	"yes",
	"yep",
	"yeah",
	"ok",
	"okay",
	"hey",
	"hi",
	"hello",
	"thanks",
	"thank",
	"please",
	"sorry",
	"let",
	"get",
	"got",
	"make",
	"made",
	"want",
	"need",
	"needs",
	"good",
	"great",
	"nice",
	"cool",
	"right",
	"true",
	"sure",
	"thing",
	"one",
	"two",
	"three",
	"first",
	"next",
	"last",
	"now",
	"later",
	"today",
	"working",
	"works",
]);

export function detectLanguage(text: string): "en" | "es" | null {
	const lower = text.toLowerCase();
	// ¿ ¡ ñ are Spanish-exclusive in practice — each outweighs a
	// function word. Plain accented vowels get less weight: they ride
	// english loanwords and names (résumé, café, José), and one
	// borrowed word must not cast a whole sentence spanish.
	let es = 3 * (lower.match(/[¿¡ñ]/g)?.length ?? 0) + (lower.match(/[áéíóúü]/g)?.length ?? 0);
	let en = 0;
	for (const word of lower.split(/[^a-záéíóúüñ]+/)) {
		if (!word) continue;
		if (ES_WORDS.has(word)) es++;
		if (EN_WORDS.has(word)) en++;
	}
	if (Math.max(es, en) < 2 || Math.abs(es - en) < 2) return null;
	return es > en ? "es" : "en";
}

// First cast member matching the sniff wins; else the default.
export function pickVoice(
	text: string,
	defaultVoice: string,
	alternates: readonly string[] | undefined,
): string {
	if (!alternates?.length) return defaultVoice;
	const lang = detectLanguage(text);
	if (!lang) return defaultVoice;
	return (
		[defaultVoice, ...alternates].find((v) => v.toLowerCase().split("-")[0] === lang) ??
		defaultVoice
	);
}

export interface SynthOptions {
	// Provider voice id/name; "" asks for the provider's default voice.
	voice: string;
	// BCP-47 tag of the chosen voice (edge SSML); "" when none is derivable.
	lang: string;
	// Edge prosody rate — other kinds leave it unset.
	rate?: string;
	// The container the synthesizer returns; the remux must match it.
	outputFormat: string;
}

export type ChunkSynthesizer = (text: string, options: SynthOptions) => Promise<Uint8Array>;
export type AudioRemuxer = (audio: Uint8Array) => Promise<Uint8Array>;

function splitOversized(text: string, limit: number): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let end = rest.lastIndexOf(" ", limit);
		if (end < limit / 2) end = limit;
		if (end < rest.length && /[\ud800-\udbff]/.test(rest[end - 1] ?? "")) end--;
		// The decrement can reach 0 (limit ≤ 2, pair at the head) and
		// slice(0, 0) would loop forever — emit the surrogate pair as its
		// own whole piece; correctness beats the limit for tiny inputs.
		if (end <= 0) end = 2;
		out.push(rest.slice(0, end).trim());
		rest = rest.slice(end).trim();
	}
	if (rest !== "") out.push(rest);
	return out;
}

export function chunkSpeech(text: string, limit = CHUNK_LIMIT): string[] {
	if (limit < 1) throw new Error("speech chunk limit must be positive");
	const sentences = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)]
		.map(({ segment }) => segment.trim())
		.filter(Boolean)
		.flatMap((sentence) => splitOversized(sentence, limit));
	const chunks: string[] = [];
	for (const sentence of sentences) {
		const current = chunks.at(-1);
		if (current !== undefined && current.length + 1 + sentence.length <= limit) {
			chunks[chunks.length - 1] = `${current} ${sentence}`;
		} else {
			chunks.push(sentence);
		}
	}
	return chunks;
}

// One definition, both ends: delivery.ts writes it, withoutStatusTail()
// strips it — a second copy is how voice notes quietly start reading
// "⚙ bash" lines aloud.
export const STATUS_TAIL_MARK = "\n\n—\n";

function withoutStatusTail(text: string): string {
	const marker = text.lastIndexOf(STATUS_TAIL_MARK);
	return marker === -1 ? text : text.slice(0, marker);
}

// Symbols read aloud instead of seen: pipes between table cells, rules,
// entities, snake_case underscores all become speech-shaped text. The
// result must be idempotent — tg callers pre-strip, then the speaker
// boundary strips again.
function stripMarkdown(text: string): string {
	return (
		text
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// Table separator rows (`| --- | :-: |`) vanish before data rows
			// would read their dashes; outer-piped rows speak as comma lists.
			// Whitespace stays line-confined — \s here would let a row match
			// across newlines.
			.replace(/^[ \t]{0,3}\|?[ \t:|-]+\|?[ \t]*$/gm, "")
			.replace(/^[ \t]{0,3}\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
				row
					.split("|")
					.map((cell) => cell.trim())
					.filter(Boolean)
					.join(", "),
			)
			.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
			// Horizontal rules (`---`, `***`, `___`, spaced) — `***` would die
			// in the symbol strip anyway, but the dashes would read "minus
			// minus minus".
			.replace(/^\s{0,3}(?:([-*_])[ \t]*)(?:\1[ \t]*){2,}$/gm, "")
			.replace(/<[^>]+>/g, "")
			.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => {
				switch (entity) {
					case "&amp;":
						return "&";
					case "&lt;":
						return "<";
					case "&gt;":
						return ">";
					case "&quot;":
						return '"';
					case "&apos;":
					case "&#39;":
						return "'";
					default:
						return " ";
				}
			})
			// snake_case reads as two words, not one blended one; `_ital_`
			// keeps dying in the symbol strip (underscores at word edges).
			.replace(/(?<=\w)_(?=\w)/g, " ")
			.replace(/[*_~`]/g, "")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

export function speechContent(text: string): { spoken: string; supplemental: string | null } {
	const extras: string[] = [];
	let spoken = withoutStatusTail(text).replace(CODE_BLOCK, (_match, code: string) => {
		const trimmed = code.trim();
		if (trimmed !== "") extras.push(`\`\`\`\n${trimmed}\n\`\`\``);
		return "";
	});
	spoken = spoken.replace(LONG_URL, (url) => {
		extras.push(url);
		return "";
	});
	return {
		spoken: stripMarkdown(spoken),
		supplemental: extras.length === 0 ? null : extras.join("\n\n"),
	};
}

export function speakable(text: string): string {
	return speechContent(text).spoken;
}

function edgeAuthToken(): string {
	let seconds = BigInt(Math.floor(Date.now() / 1000)) + 11_644_473_600n;
	seconds -= seconds % 300n;
	const ticks = seconds * 10_000_000n;
	return createHash("sha256").update(`${ticks}${EDGE_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function connectionId(): string {
	return randomUUID().replaceAll("-", "");
}

function timestamp(): string {
	return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

function xml(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function asBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

const edgeSynthesize: ChunkSynthesizer = (text, options) =>
	new Promise<Uint8Array>((resolve, reject) => {
		// The legacy speech.platform.bing.com socket answers 403; Edge
		// now dials api.msedgeservices.com, which accepts the same
		// client token plus the v1 Sec-MS-GEC pair.
		const query = new URLSearchParams({
			"Ocp-Apim-Subscription-Key": EDGE_TOKEN,
			ConnectionId: connectionId(),
			"Sec-MS-GEC": edgeAuthToken(),
			"Sec-MS-GEC-Version": `1-${EDGE_VERSION}`,
		});
		const socket = new WebSocket(
			`wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?${query}`,
			{
				handshakeTimeout: 10_000,
				headers: {
					Pragma: "no-cache",
					"Cache-Control": "no-cache",
					Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
					"Sec-WebSocket-Version": "13",
					"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
					"Accept-Encoding": "gzip, deflate, br, zstd",
					"Accept-Language": "en-US,en;q=0.9",
					Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
				},
			},
		);
		const audio: Buffer[] = [];
		let settled = false;
		let lastPath = "none";
		const budgetMs = edgeTimeoutMs(text.length);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.terminate();
			reject(
				new Error(
					`Edge TTS timed out after ${budgetMs}ms (${text.length} chars, last path ${lastPath})`,
				),
			);
		}, budgetMs);
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.terminate();
			reject(err instanceof Error ? err : new Error(String(err)));
		};
		socket.on("open", () => {
			const now = timestamp();
			socket.send(
				`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
					JSON.stringify({
						context: {
							synthesis: {
								audio: {
									metadataoptions: {
										sentenceBoundaryEnabled: "false",
										wordBoundaryEnabled: "false",
									},
									outputFormat: options.outputFormat,
								},
							},
						},
					}) +
					"\r\n",
			);
			const ssml =
				`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${options.lang}'>` +
				`<voice name='${xml(options.voice)}'><prosody pitch='+0Hz' rate='${xml(options.rate ?? "+0%")}' volume='+0%'>` +
				`${xml(text)}</prosody></voice></speak>`;
			socket.send(
				`X-RequestId:${connectionId()}\r\nContent-Type:application/ssml+xml\r\n` +
					`X-Timestamp:${now}Z\r\nPath:ssml\r\n\r\n${ssml}`,
			);
		});
		socket.on("message", (raw, binary) => {
			const message = asBuffer(raw);
			if (binary) {
				if (message.byteLength < 2) return fail(new Error("Edge TTS sent malformed audio"));
				const headerLength = message.readUInt16BE(0);
				const headerEnd = headerLength + 2;
				if (headerEnd > message.byteLength)
					return fail(new Error("Edge TTS sent malformed audio headers"));
				const headers = message.subarray(2, headerEnd).toString("utf8");
				const data = message.subarray(headerEnd);
				if (/^Path:audio$/im.test(headers) && data.byteLength > 0) audio.push(data);
				return;
			}
			const response = message.toString("utf8");
			lastPath = response.match(/Path:([^\r\n]+)/i)?.[1] ?? "unknown";
			if (!/Path:turn\.end(?:\r?\n|$)/i.test(response)) return;
			if (audio.length === 0) return fail(new Error("Edge TTS returned no audio"));
			settled = true;
			clearTimeout(timer);
			socket.close();
			resolve(Buffer.concat(audio));
		});
		socket.on("unexpected-response", (_request, response) => {
			fail(new Error(`Edge TTS websocket rejected with HTTP ${response.statusCode}`));
		});
		socket.on("error", fail);
		socket.on("close", (code, reason) => {
			if (!settled) {
				fail(
					new Error(
						`Edge TTS websocket closed before audio completed (code ${code}, path ${lastPath}, reason ${reason.toString() || "none"})`,
					),
				);
			}
		});
	});

const REMUX_TIMEOUT_MS = 30_000;
// A 10k-char chunk synthesizes to a few minutes of opus — single-digit MiB.
// The cap only guards a wedged ffmpeg flooding stdout, not real speech.
const REMUX_MAX_OUTPUT = 32 * 1024 * 1024;

// The input container is forced — webm probing from a pipe is
// unreliable. codecArgs decide copy vs re-encode: edge already speaks
// opus so it stream-copies; mp3 (openrouter) must re-encode to opus
// for a real voice note.
function oggRemuxer(inputFormat: string, codecArgs: string[]): AudioRemuxer {
	return async (audio) => {
		let proc: Bun.ReadableSubprocess;
		try {
			proc = spawnProc(
				[
					"ffmpeg",
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					inputFormat,
					"-i",
					"pipe:0",
					"-vn",
					...codecArgs,
					"-f",
					"ogg",
					"pipe:1",
				],
				undefined,
				new Blob([audio]),
			);
		} catch (err) {
			throw new Error(`ffmpeg ogg remux failed to spawn — ${(err as Error).message}`);
		}
		// A SIGTERM-ignoring ffmpeg escalates to group SIGKILL rather
		// than stalling the voice lane and shutdown on proc.exited.
		const r = await boundedRunBinary(proc, {
			timeoutMs: REMUX_TIMEOUT_MS,
			maxOutput: REMUX_MAX_OUTPUT,
		});
		if (r.timedOut) {
			throw new Error(`ffmpeg ogg remux timed out after ${REMUX_TIMEOUT_MS}ms`);
		}
		if (r.truncated) {
			throw new Error("ffmpeg ogg remux produced oversized or cut-off output");
		}
		if (r.exitCode !== 0) {
			throw new Error(
				`ffmpeg ogg remux exited ${r.exitCode ?? "unreaped"}: ${r.stderr.trim().slice(0, 500)}`,
			);
		}
		const out = r.stdout;
		if (out.byteLength < 4 || new TextDecoder().decode(out.subarray(0, 4)) !== "OggS") {
			throw new Error("ffmpeg ogg remux returned invalid output");
		}
		return out;
	};
}

// Edge's webm/opus stream-copies; the cloud kinds' mp3 re-encodes to opus.
const remuxWebmOgg = oggRemuxer("webm", ["-c:a", "copy"]);
const remuxMp3Ogg = oggRemuxer("mp3", ["-ac", "1", "-b:a", "48k", "-c:a", "libopus"]);

// Injectable seams for tests; production fills the defaults.
export interface SpeechDeps {
	synthesize?: ChunkSynthesizer;
	remux?: AudioRemuxer;
	// Cloud kinds resolve their key lazily at the point of use, like
	// every other provider — the resolved key never leaves the engine.
	auth?: AuthStore;
	fetchFn?: typeof fetch;
	chunkLimit?: number;
}

function defaultSynthesizer(config: TtsConfig, deps: SpeechDeps): ChunkSynthesizer {
	switch (config.kind) {
		case "edge":
			return edgeSynthesize;
		case "openrouter": {
			if (deps.auth === undefined) throw new Error("openrouter tts needs an auth store");
			return openrouterSpeech(config, deps.auth, { fetchFn: deps.fetchFn });
		}
		case "logfare": {
			if (deps.auth === undefined) throw new Error("logfare tts needs an auth store");
			return logfareSpeech(config, deps.auth, { fetchFn: deps.fetchFn });
		}
		case "mimo": {
			if (deps.auth === undefined) throw new Error("mimo tts needs an auth store");
			return mimoSpeech(config, deps.auth, { fetchFn: deps.fetchFn });
		}
	}
}

export async function synthesizeSpeech(
	text: string,
	config: TtsConfig,
	deps: SpeechDeps = {},
): Promise<Uint8Array[]> {
	const chunks = chunkSpeech(text, deps.chunkLimit ?? CHUNK_LIMIT);
	if (chunks.length === 0) throw new Error("speech input is empty");
	const synthesize = deps.synthesize ?? defaultSynthesizer(config, deps);
	const remux = deps.remux ?? (config.kind === "edge" ? remuxWebmOgg : remuxMp3Ogg);
	// One sniff per reply, applied to every chunk — replies are
	// monolingual in practice, and a per-chunk flip would stutter. Edge
	// only: cloud voice ids carry no language to cast on.
	const voice =
		config.kind === "edge" ? pickVoice(text, config.voice, config.voices) : (config.voice ?? "");
	const options = {
		voice,
		lang: config.kind === "edge" ? voice.split("-").slice(0, 2).join("-") : "",
		...(config.kind === "edge" && config.rate !== undefined ? { rate: config.rate } : {}),
		outputFormat: config.kind === "edge" ? OUTPUT_FORMAT : "mp3",
	};
	const audio: Uint8Array[] = [];
	log.info("speech synthesis started", {
		provider: config.kind,
		...(config.kind !== "edge" ? { model: config.model } : {}),
		voice,
		...(config.kind === "edge" && voice !== config.voice ? { defaultVoice: config.voice } : {}),
		chars: text.length,
		chunks: chunks.length,
	});
	try {
		for (const chunk of chunks) {
			audio.push(await remux(await synthesize(chunk, options)));
		}
	} catch (err) {
		log.warn("speech synthesis failed", err, {
			provider: config.kind,
			...(config.kind !== "edge" ? { model: config.model } : {}),
			voice,
			completedChunks: audio.length,
		});
		throw err;
	}
	log.info("speech synthesis completed", {
		provider: config.kind,
		voice,
		chunks: audio.length,
		bytes: audio.reduce((sum, chunk) => sum + chunk.byteLength, 0),
	});
	return audio;
}

// null answers 503 rather than failing mid-synthesis — gated on the
// boot ffmpeg probe (ttsDown).
export function makeSpeaker(deps: {
	configRef: ConfigRef;
	auth: AuthStore;
}): (text: string) => Promise<Uint8Array[] | null> {
	return async (text) => {
		const tts = deps.configRef.current.tts;
		if (!tts || deps.configRef.ttsDown) return null;
		return synthesizeSpeech(text, tts, { auth: deps.auth });
	};
}
