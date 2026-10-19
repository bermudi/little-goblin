// Browser MediaRecorder uploads are unbounded streams — no Duration
// element, and Chromium stamps packets on the device's monotonic clock,
// so a 14 s note lands at pts ≈ uptime. The repair decodes, re-stamps
// from sample count, re-encodes; it runs at upload so the stored
// artifact is honest before any ref exists.
//
// Detection is by content, never the declared type: Bun's formData
// re-types multipart parts by filename extension, so a webm voice
// note arrives claiming video/webm regardless of what the browser sent.
// ffprobe answers duration, audio-only, container family.

import { rename, stat, unlink } from "node:fs/promises";
import { z } from "zod";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";

const PROBE_TIMEOUT_MS = 15_000;
// libopus encodes far faster than realtime; a minute covers the 32 MiB
// upload cap with room.
const NORMALIZE_TIMEOUT_MS = 60_000;

// Claims worth a probe. Images/text never reach ffprobe; real video
// survives on its probed streams, not its mime.
const PROBE_CANDIDATE = /^(audio|video)\//;

const probeSchema = z.object({
	format: z
		.object({
			duration: z.string().optional(),
			format_name: z.string().optional(),
		})
		.optional(),
	streams: z.array(z.object({ codec_type: z.string().optional() })).optional(),
});

interface Probed {
	duration: number | null;
	formatName: string;
	audioOnly: boolean;
}

// One ffprobe pass for the three facts the gate needs. Throws when
// the file can't be parsed at all — callers decide whether the
// verbatim bytes are acceptable.
async function probe(path: string): Promise<Probed> {
	const r = await boundedRun(
		spawnProc([
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration,format_name:stream=codec_type",
			"-of",
			"json",
			path,
		]),
		{ timeoutMs: PROBE_TIMEOUT_MS, maxOutput: 16 * 1024 },
	);
	if (r.exitCode !== 0) {
		throw new Error(
			`ffprobe exited ${r.exitCode ?? "unreaped"} — ${r.stderr.trim().slice(0, 200)}`,
		);
	}
	const p = probeSchema.parse(JSON.parse(r.stdout));
	const duration = Number.parseFloat(p.format?.duration ?? "");
	return {
		duration: Number.isFinite(duration) ? duration : null,
		formatName: p.format?.format_name ?? "",
		audioOnly:
			(p.streams ?? []).some((s) => s.codec_type === "audio") &&
			!(p.streams ?? []).some((s) => s.codec_type === "video"),
	};
}

// The container families where a missing Duration is a defect — each
// maps to its rewrite target and the honest media type for the fixed
// bytes. mp3/flac/wav stream fine without the element; they keep
// their bytes (and their claim) even when duration reads N/A.
function recorderContainer(
	formatName: string,
): { container: "webm" | "ogg" | "mp4"; mediaType: string } | null {
	if (formatName.includes("webm") || formatName.includes("matroska")) {
		return { container: "webm", mediaType: "audio/webm" };
	}
	if (formatName.includes("ogg")) {
		return { container: "ogg", mediaType: "audio/ogg" };
	}
	if (/mp4|m4a|mov/.test(formatName)) {
		return { container: "mp4", mediaType: "audio/mp4" };
	}
	return null;
}

export interface NormalizedAudio {
	// The file at `path` was rewritten with rebuilt timestamps.
	fixed: boolean;
	// The type to record — the claim, or the corrected audio/* type
	// when the rewrite ran (a mis-sniffed video/webm comes out honest).
	mediaType: string;
}

// Rewrite a recorder-broken container in place; the claim decides
// only whether ffprobe runs. Skipped — and the file untouched — when
// the upload isn't media, isn't audio-only, declares a real duration,
// or isn't a recorder container. Throws on probe/remux failure.
export async function normalizeRecordedAudio(
	path: string,
	mediaType: string,
): Promise<NormalizedAudio> {
	const verbatim = { fixed: false, mediaType };
	if (!PROBE_CANDIDATE.test(mediaType)) return verbatim;
	const p = await probe(path);
	if (!p.audioOnly || p.duration !== null) return verbatim;
	const out = recorderContainer(p.formatName);
	if (out === null) return verbatim;
	const fixed = `${path}.norm`;
	try {
		const r = await boundedRun(
			spawnProc([
				"ffmpeg",
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				path,
				"-vn",
				// Re-stamp from decoded sample count: recorder pts is
				// container fiction, contiguous frames are wall time.
				"-af",
				"asetpts=N/SR/TB",
				"-c:a",
				"libopus",
				"-f",
				out.container,
				fixed,
			]),
			{ timeoutMs: NORMALIZE_TIMEOUT_MS, maxOutput: 64 * 1024 },
		);
		if (r.timedOut) {
			throw new Error(`ffmpeg normalization timed out after ${NORMALIZE_TIMEOUT_MS}ms`);
		}
		if (r.exitCode !== 0) {
			throw new Error(
				`ffmpeg normalization exited ${r.exitCode ?? "unreaped"} — ${r.stderr.trim().slice(0, 400)}`,
			);
		}
		const { size } = await stat(fixed);
		await rename(fixed, path);
		log.info("recording normalized — container timestamps rebuilt", {
			path,
			claimedType: mediaType,
			mediaType: out.mediaType,
			bytes: size,
		});
		return { fixed: true, mediaType: out.mediaType };
	} finally {
		await unlink(fixed).catch((err: unknown) => {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("recording normalize temp cleanup failed", {
					fixed,
					error: String(err),
				});
			}
		});
	}
}
