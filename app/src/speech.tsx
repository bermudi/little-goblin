// Read-aloud player. The server hands back N standalone ogg files (one
// per sentence chunk) and browsers cannot treat them as one stream:
// chained ogg has no usable timeline anywhere — Chromium stops dead at
// the first segment's end and Firefox reports duration=Infinity (both
// verified headless, 2026-10-19). So each chunk keeps its own Audio
// element and a cumulative duration map (metadata is preloaded for all
// parts before playback starts) translates global position ⇄
// (element, offset). Speed rides playbackRate with preservesPitch, so
// 1.5× speech stays at its original pitch.

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesize } from "./api.ts";

export const SPEECH_RATES: readonly number[] = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "goblin.speech.rate";
const SEEK_STEP = 10;
// Blob URLs decode in milliseconds; the timeout only bounds a wedged
// decoder so a start attempt can't hang the "…" button forever.
const METADATA_TIMEOUT_MS = 10_000;

const b64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// seconds → m:ss, or h:mm:ss past an hour.
export function tfmt(seconds: number): string {
	const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// 4 is SRC_NOT_SUPPORTED — the only MediaError whose cause is worth
// explaining to the operator; anything else gets its code.
function mediaErrText(code: number, part: number, parts: number): string {
	const where = parts > 1 ? ` at part ${part + 1}/${parts}` : "";
	if (code === 4) return `playback failed${where} — this browser may not support ogg audio`;
	return `playback failed${where} (media error ${code})`;
}

function detach(el: HTMLAudioElement): void {
	el.onended = null;
	el.onerror = null;
	el.ontimeupdate = null;
}

// The duration map is the player — a part with no duration has no
// seeking, no progress bar, nothing. Single-segment ogg reports a
// finite duration on every engine that can decode it at all (verified
// Chromium + Firefox, 2026-10-19), so a miss fails loud instead of
// degrading into a player that lies about time.
function loadedDuration(el: HTMLAudioElement): Promise<number> {
	return new Promise((resolve, reject) => {
		const settled = (ok: boolean) => {
			if (ok) resolve(el.duration);
			else
				reject(
					new Error(
						`speech player: audio part has no duration (media error ${el.error?.code ?? 0})`,
					),
				);
		};
		if (Number.isFinite(el.duration) && el.duration > 0) {
			settled(true);
			return;
		}
		const timer = setTimeout(() => {
			el.onloadedmetadata = null;
			el.onerror = null;
			settled(Number.isFinite(el.duration) && el.duration > 0);
		}, METADATA_TIMEOUT_MS);
		el.onloadedmetadata = () => {
			clearTimeout(timer);
			settled(Number.isFinite(el.duration) && el.duration > 0);
		};
		el.onerror = () => {
			clearTimeout(timer);
			settled(false);
		};
	});
}

function storedRate(): number {
	try {
		const n = Number(localStorage.getItem(RATE_KEY));
		return SPEECH_RATES.includes(n) ? n : 1;
	} catch {
		return 1;
	}
}

interface Chunk {
	url: string;
	el: HTMLAudioElement;
	start: number;
	duration: number;
}

// One live player across all messages — two simultaneous reads would mix.
let liveStop: (() => void) | null = null;

export type SpeechPhase = "closed" | "loading" | "open";

export function useSpeech(token: string | null) {
	const [phase, setPhase] = useState<SpeechPhase>("closed");
	const [playing, setPlaying] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [rate, setRate] = useState<number>(storedRate);

	const chunks = useRef<Chunk[]>([]);
	const current = useRef(-1);
	const total = useRef(0);
	const pos = useRef(0);
	const playingRef = useRef(false);
	const rateRef = useRef(rate);
	const gen = useRef(0);

	const stop = useCallback(() => {
		gen.current++;
		for (const c of chunks.current) {
			detach(c.el);
			c.el.pause();
			URL.revokeObjectURL(c.url);
		}
		chunks.current = [];
		current.current = -1;
		total.current = 0;
		pos.current = 0;
		playingRef.current = false;
		if (liveStop === stop) liveStop = null;
		setPhase("closed");
		setPlaying(false);
		setPosition(0);
		setDuration(0);
	}, []);

	// A play() that the engine refuses (autoplay policy, interrupted
	// resume) leaves the player open at this position with the error
	// shown — the play button retries under a fresh gesture. AbortError
	// is a pause()/load() race, not a failure.
	const resume = useCallback((el: HTMLAudioElement) => {
		el.play()
			.then(() => {
				playingRef.current = true;
				setPlaying(true);
				// A blockage that resolved under the retry gesture was
				// never a real failure — take the complaint back.
				setErr(null);
			})
			.catch((e: unknown) => {
				playingRef.current = false;
				setPlaying(false);
				if (e instanceof DOMException && e.name === "AbortError") return;
				setErr(e instanceof Error ? `playback failed — ${e.message}` : "playback failed");
			});
	}, []);

	const playFrom = useCallback(
		(t: number, autoplay: boolean) => {
			const list = chunks.current;
			if (list.length === 0) return;
			const target = Math.min(Math.max(0, t), total.current - 0.01);
			let i = list.findIndex((c) => target < c.start + c.duration);
			if (i === -1) i = list.length - 1;
			const prev = current.current;
			if (prev !== i) {
				const old = list[prev];
				if (old) {
					detach(old.el);
					old.el.pause();
				}
				current.current = i;
			}
			const c = list[i];
			if (c === undefined) return;
			const el = c.el;
			el.onended = () => {
				const next = list[i + 1];
				if (next) playFrom(next.start, true);
				else stop();
			};
			// An error after this part produced sound is a stream-tail
			// quirk, not a failed read — some engines fire error instead of
			// ended on a mildly malformed ending, and the audio did play
			// ("playback didnt fail. it worked." — 2026-10-19). An error
			// with no sound behind it is real and names its code.
			el.onerror = () => {
				if (el.currentTime > 0) {
					const next = list[i + 1];
					if (next) playFrom(next.start, true);
					else stop();
				} else {
					const code = el.error?.code ?? 0;
					stop();
					setErr(mediaErrText(code, i, list.length));
				}
			};
			el.ontimeupdate = () => {
				pos.current = c.start + el.currentTime;
				setPosition(pos.current);
			};
			el.playbackRate = rateRef.current;
			if ("preservesPitch" in el) el.preservesPitch = true;
			try {
				el.currentTime = target - c.start;
			} catch {
				// Metadata (and a valid timeline) is preloaded before any
				// playFrom; a seek before that has nowhere to land.
			}
			pos.current = target;
			setPosition(target);
			setPhase("open");
			if (autoplay) resume(el);
			else {
				el.pause();
				playingRef.current = false;
				setPlaying(false);
			}
		},
		[resume, stop],
	);

	const start = useCallback(
		async (text: string) => {
			if (phase !== "closed") {
				stop();
				return;
			}
			setErr(null);
			setPhase("loading");
			const myGen = ++gen.current;
			let parts: { url: string; el: HTMLAudioElement }[] = [];
			try {
				const r = await synthesize(token, text);
				if (gen.current !== myGen) return;
				parts = r.chunks.map((b64) => {
					const bytes = b64Bytes(b64);
					const url = URL.createObjectURL(
						new Blob([bytes.buffer as ArrayBuffer], { type: r.mediaType }),
					);
					const el = new Audio(url);
					el.preload = "metadata";
					return { url, el };
				});
				const durations = await Promise.all(parts.map((p) => loadedDuration(p.el)));
				if (gen.current !== myGen) {
					for (const p of parts) {
						p.el.pause();
						URL.revokeObjectURL(p.url);
					}
					return;
				}
				let acc = 0;
				chunks.current = parts.map((p, i) => {
					const c: Chunk = { url: p.url, el: p.el, start: acc, duration: durations[i] ?? 0 };
					acc += c.duration;
					return c;
				});
				total.current = acc;
				pos.current = 0;
				setPosition(0);
				setDuration(acc);
				liveStop?.();
				liveStop = stop;
				playFrom(0, true);
			} catch (e) {
				// Parts never installed in chunks.current belong to this run
				// alone — release them whether the failure was fetch, decode,
				// or the duration probe.
				for (const p of parts) {
					p.el.pause();
					URL.revokeObjectURL(p.url);
				}
				if (gen.current !== myGen) return;
				setErr(e instanceof Error ? e.message : "speech failed");
				setPhase("closed");
			}
		},
		[phase, playFrom, stop, token],
	);

	const toggle = useCallback(() => {
		const c = chunks.current[current.current];
		if (!c) return;
		if (playingRef.current) {
			c.el.pause();
			playingRef.current = false;
			setPlaying(false);
		} else {
			resume(c.el);
		}
	}, [resume]);

	const seekTo = useCallback(
		(t: number) => {
			playFrom(t, playingRef.current);
		},
		[playFrom],
	);

	const seekBy = useCallback(
		(delta: number) => {
			playFrom(pos.current + delta, playingRef.current);
		},
		[playFrom],
	);

	const cycleRate = useCallback(() => {
		const next =
			SPEECH_RATES[(SPEECH_RATES.indexOf(rateRef.current) + 1) % SPEECH_RATES.length] ?? 1;
		rateRef.current = next;
		setRate(next);
		const c = chunks.current[current.current];
		if (c) c.el.playbackRate = next;
		// A preference, not state — storage being unavailable (private
		// mode) only costs the memory of it.
		try {
			localStorage.setItem(RATE_KEY, String(next));
		} catch {
			// preference persistence is best-effort
		}
	}, []);

	useEffect(
		() => () => {
			stop();
		},
		[stop],
	);

	return {
		phase,
		playing,
		err,
		position,
		duration,
		rate,
		start,
		stop,
		toggle,
		seekBy,
		seekTo,
		cycleRate,
	};
}

export function SpeechPlayer(props: {
	playing: boolean;
	rate: number;
	position: number;
	duration: number;
	onToggle: () => void;
	onSeekBy: (delta: number) => void;
	onSeekTo: (t: number) => void;
	onRate: () => void;
	onStop: () => void;
}) {
	return (
		<div className="speech-player">
			<button type="button" onClick={() => props.onSeekBy(-SEEK_STEP)} aria-label="Back 10 seconds">
				«{SEEK_STEP}
			</button>
			<button type="button" onClick={props.onToggle} aria-label={props.playing ? "Pause" : "Play"}>
				{props.playing ? "⏸" : "▶"}
			</button>
			<button
				type="button"
				onClick={() => props.onSeekBy(SEEK_STEP)}
				aria-label="Forward 10 seconds"
			>
				{SEEK_STEP}»
			</button>
			<button type="button" onClick={props.onRate} aria-label="Playback speed">
				{props.rate}×
			</button>
			<input
				className="speech-bar"
				type="range"
				min={0}
				max={Math.max(props.duration, 0.1)}
				step={0.1}
				value={Math.min(props.position, props.duration)}
				onChange={(e) => props.onSeekTo(Number(e.currentTarget.value))}
				aria-label="Speech position"
			/>
			<span className="speech-time">
				{tfmt(props.position)} / {tfmt(props.duration)}
			</span>
			<button type="button" onClick={props.onStop} aria-label="Stop">
				■
			</button>
		</div>
	);
}
