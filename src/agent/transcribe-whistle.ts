// Whistle — Cactus Compute's local speech model (design/asr.md →
// Whistle). One 16.9 MB .cact weights file, CPU-only, no key, no
// network: the engine binary contains no HTTP client and reads no
// environment, so audio never leaves the box. Invoked as a stateless
// subprocess per segment, like every other goblin child.
//
// Artifacts auto-fetch once into $GOBLIN_HOME/cache/whistle, digest
// pinned: upstream drift fails loud instead of running different
// weights silently. engine:/weights: config bypasses the fetch for
// managed installs.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import { durableWriteBytes } from "../durable.ts";
import type { EngineDeps, EngineTranscript, SpeechEngine } from "./transcribe.ts";

// The engine's hard per-pass ceiling — segments cut at 28 s leave the
// margin (design/asr.md: measured on this very binary).
const WHISTLE_SEGMENT_SECONDS = 28;
const WHISTLE_TIMEOUT_MS = 120_000;
// needle + whistle.cact are ~18 MB combined; anything bigger is not
// the artifact we pinned.
const ARTIFACT_CAP = 64 * 1024 * 1024;
const WHISTLE_LANGUAGES: readonly string[] = ["en", "de", "fr", "es", "it", "nl", "pl"];

export interface WhistleCfg {
	engine?: string | undefined;
	weights?: string | undefined;
	keywords?: string[] | undefined;
	language?: string | undefined;
}

export interface WhistleDeps extends EngineDeps {
	arch?: string;
	platform?: string;
	// Default paths.whistleCache() — tests point it at a tmpdir.
	cacheDir?: string;
	// Test seam: override the pinned digests so fixtures can serve
	// small fake bytes instead of the real 17 MB artifacts.
	digests?: { engine: string; weights: string };
}

// sha256 of the probed artifacts (2026-10-09). A mismatch is supply
// chain drift — fail loud, never run different weights.
const PINNED_DIGESTS = {
	engine: "f38dc4b0345d66b4e385734ad0f12af43ac6e2cfa1752d0795af5c137200c8e4",
	weights: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
} as const;

// x86_64 linux is the only prebuilt platform verified here (g7 +
// lithium). Everything else gets the manual-path instruction instead of
// an untested binary.
function artifactUrls(arch: string, platform: string): { engine: string; weights: string } {
	if (platform !== "linux" || arch !== "x64") {
		throw new Error(
			`whistle: no verified prebuilt engine for ${platform}-${arch} — set transcription.engine and transcription.weights to local paths (design/asr.md → Whistle)`,
		);
	}
	return {
		engine:
			"https://huggingface.co/Cactus-Compute/needle3/resolve/main/linux-x86_64/needle",
		weights: "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact",
	};
}

// One fetch per process per artifact set — concurrent transcriptions
// share the in-flight promise, later ones reuse the result.
const artifactMemo = new Map<string, Promise<{ engine: string; weights: string }>>();

function ensureArtifacts(
	cfg: WhistleCfg,
	deps: WhistleDeps,
): Promise<{ engine: string; weights: string }> {
	const cacheDir = deps.cacheDir ?? paths.whistleCache();
	const key = `${cacheDir}|${cfg.engine ?? ""}|${cfg.weights ?? ""}`;
	const memoized = artifactMemo.get(key);
	if (memoized !== undefined) return memoized;
	const p = (async () => {
		const urls = artifactUrls(deps.arch ?? process.arch, deps.platform ?? process.platform);
		const digests = deps.digests ?? PINNED_DIGESTS;
		return {
			engine: await artifact(cfg.engine, join(cacheDir, "needle"), urls.engine, digests.engine, 0o755, deps),
			weights: await artifact(
				cfg.weights,
				join(cacheDir, "whistle.cact"),
				urls.weights,
				digests.weights,
				0o644,
				deps,
			),
		};
	})();
	// A failed fetch must not poison the memo — the next call retries.
	p.catch(() => artifactMemo.delete(key));
	artifactMemo.set(key, p);
	return p;
}

async function artifact(
	override: string | undefined,
	dest: string,
	url: string,
	sha256: string,
	mode: number,
	deps: WhistleDeps,
): Promise<string> {
	// Managed installs: the operator's own binary/build, taken as-is.
	if (override !== undefined) {
		if (!existsSync(override)) throw new Error(`whistle: configured artifact not found: ${override}`);
		return override;
	}
	if (existsSync(dest)) return dest;

	const fetchFn = deps.fetchFn ?? fetch;
	log.info("whistle artifact fetching", { url, dest });
	let res: Response;
	try {
		res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
	} catch (err) {
		throw new Error(`whistle: artifact download failed (${url}) — ${(err as Error).message}`);
	}
	if (!res.ok) throw new Error(`whistle: artifact download HTTP ${res.status} (${url})`);
	const declared = res.headers.get("content-length");
	if (declared !== null && Number(declared) > ARTIFACT_CAP) {
		throw new Error(`whistle: artifact ${url} declares ${declared} bytes — not the pinned file`);
	}
	const data = await readCapped(res, ARTIFACT_CAP);
	const got = createHash("sha256").update(data).digest("hex");
	if (got !== sha256) {
		throw new Error(
			`whistle: digest mismatch for ${dest} (wanted ${sha256.slice(0, 16)}…, got ${got.slice(0, 16)}…) — upstream drift; set transcription.engine/transcription.weights to local paths or clear the cache and retry`,
		);
	}
	mkdirSync(dirname(dest), { recursive: true });
	durableWriteBytes(dest, data, mode);
	chmodSync(dest, mode);
	log.info("whistle artifact fetched", { dest, bytes: data.byteLength });
	return dest;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
	if (res.body === null) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > cap) {
			await reader.cancel(new Error("over cap"));
			throw new Error(`whistle: artifact download over ${cap} bytes — not the pinned file`);
		}
		chunks.push(value);
		total += value.byteLength;
	}
	return Buffer.concat(chunks);
}

// needle stdout: one JSON line. Silence is {"text":"","language":""}.
const engineOutput = z.object({
	text: z.string(),
	language: z.string().optional(),
	ttft_ms: z.number().optional(),
	decode_tps: z.number().optional(),
});

export function whistleEngine(cfg: WhistleCfg, deps: WhistleDeps = {}): SpeechEngine {
	if (cfg.language !== undefined && !WHISTLE_LANGUAGES.includes(cfg.language)) {
		throw new Error(
			`whistle: language "${cfg.language}" not in its set (${WHISTLE_LANGUAGES.join(", ")})`,
		);
	}
	return {
		id: "whistle",
		limits: { maxSeconds: WHISTLE_SEGMENT_SECONDS },
		prep: { container: "wav", sampleRateHz: 16_000, mono: true },
		transcribe: async (file): Promise<EngineTranscript> => {
			const { engine, weights } = await ensureArtifacts(cfg, deps);
			// Keywords bias toward names — one per line (--help: "words
			// and phrases to favour"). Per-call temp file; small, and the
			// engine config can change between calls.
			let kwDir: string | undefined;
			const argv = [engine, "--model", weights, "--audio", file.path];
			if (cfg.language !== undefined) argv.push("--audio-language", cfg.language);
			if (cfg.keywords !== undefined && cfg.keywords.length > 0) {
				kwDir = mkdtempSync(join(tmpdir(), "goblin-kw-"));
				const kwFile = join(kwDir, "keywords.txt");
				await writeFile(kwFile, `${cfg.keywords.join("\n")}\n`);
				argv.push("--audio-keywords", kwFile);
			}
			try {
				const r = await boundedRun(spawnProc(argv), {
					timeoutMs: WHISTLE_TIMEOUT_MS,
					maxOutput: 1024 * 1024,
				});
				if (r.timedOut) {
					throw new Error(`whistle: engine timed out after ${WHISTLE_TIMEOUT_MS}ms`);
				}
				if (r.exitCode !== 0) {
					throw new Error(
						`whistle: engine exited ${r.exitCode ?? "unreaped"} — ${r.stderr.trim().slice(0, 300)}`,
					);
				}
				let json: unknown;
				try {
					json = JSON.parse(r.stdout.trim());
				} catch {
					throw new Error(
						`whistle: engine stdout is not JSON — ${r.stdout.trim().slice(0, 300)}`,
					);
				}
				const parsed = engineOutput.safeParse(json);
				if (!parsed.success) {
					throw new Error(
						`whistle: unexpected engine output — ${r.stdout.trim().slice(0, 300)}`,
					);
				}
				if (parsed.data.decode_tps !== undefined || parsed.data.ttft_ms !== undefined) {
					log.debug("whistle engine pass", {
						ttftMs: parsed.data.ttft_ms,
						decodeTps: parsed.data.decode_tps,
						file: file.filename,
					});
				}
				return {
					text: parsed.data.text,
					...(parsed.data.language ? { language: parsed.data.language } : {}),
				};
			} finally {
				if (kwDir !== undefined) {
					rmSync(kwDir, { recursive: true, force: true });
				}
			}
		},
	};
}

// Boot-time presence report for the log line — no fetch, no memo touch.
export function whistleArtifactPresence(cfg: WhistleCfg): {
	engine: boolean;
	weights: boolean;
} {
	const cacheDir = paths.whistleCache();
	return {
		engine: (cfg.engine !== undefined && existsSync(cfg.engine)) || existsSync(join(cacheDir, "needle")),
		weights:
			(cfg.weights !== undefined && existsSync(cfg.weights)) ||
			existsSync(join(cacheDir, "whistle.cact")),
	};
}
