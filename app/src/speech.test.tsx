// The speech player's contract: chunk sequencing by global position,
// seek ± across part boundaries, rate cycling, and honest failure —
// heard audio is never reported as failed. Boundaries faked at the
// edge: Audio is a state machine stub (happy-dom has no media stack)
// and fetch answers the TTS wire shape, like useCopy.test.tsx.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { SPEECH_RATES, SpeechPlayer, tfmt, useSpeech } from "./speech.tsx";

const flush = () => new Promise((r) => setTimeout(r, 0));

class FakeAudio {
	static made: FakeAudio[] = [];
	url: string;
	preload = "";
	duration = 0;
	currentTime = 0;
	playbackRate = 1;
	preservesPitch = false;
	paused = true;
	error: { code: number } | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	ontimeupdate: (() => void) | null = null;
	onloadedmetadata: (() => void) | null = null;
	plays = 0;
	playRejected: Error | null = null;
	constructor(url: string) {
		this.url = url;
		FakeAudio.made.push(this);
	}
	play(): Promise<void> {
		this.plays++;
		if (this.playRejected !== null) {
			// A rejected play() leaves a real element paused.
			this.paused = true;
			return Promise.reject(this.playRejected);
		}
		this.paused = false;
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
	metadata(seconds: number) {
		this.duration = seconds;
		this.onloadedmetadata?.();
	}
	end() {
		this.onended?.();
	}
	tailError() {
		this.currentTime = 1.5;
		this.error = { code: 3 };
		this.onerror?.();
	}
	headError(code = 4) {
		this.error = { code };
		this.onerror?.();
	}
}

function Probe({ text }: { text: string }) {
	const s = useSpeech("tok");
	return (
		<>
			<button
				type="button"
				onClick={() => (s.phase === "closed" ? void s.start(text) : s.stop())}
				aria-label="Read aloud"
				disabled={s.phase === "loading"}
			>
				{s.phase === "open" ? "■ stop" : s.phase === "loading" ? "…" : "▶ read"}
			</button>
			{s.err !== null && <span className="msg-err">{s.err}</span>}
			{s.phase === "open" && (
				<SpeechPlayer
					playing={s.playing}
					rate={s.rate}
					position={s.position}
					duration={s.duration}
					onToggle={s.toggle}
					onSeekBy={s.seekBy}
					onSeekTo={s.seekTo}
					onRate={s.cycleRate}
					onStop={s.stop}
				/>
			)}
		</>
	);
}

describe("speech player", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	// Stubs are restored to their prior value — bun shares globalThis
	// across test files, so a deleted global would break the next file.
	const saved = new Map<string, unknown>();

	const installGlobal = (name: string, value: unknown) => {
		if (!saved.has(name)) saved.set(name, Reflect.get(globalThis, name));
		Reflect.set(globalThis, name, value);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		saved.clear();
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("Audio", FakeAudio as unknown as typeof Audio);
		win.localStorage.removeItem("goblin.speech.rate");
		FakeAudio.made = [];
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const [name, value] of saved) {
			if (value === undefined) Reflect.deleteProperty(globalThis, name);
			else Reflect.set(globalThis, name, value);
		}
		saved.clear();
	});
	// Each chunk decodes to a few bytes — the base64 payloads are opaque
	// to the player, only their count matters.
	const stubFetch = (parts: number) => {
		installGlobal("fetch", () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						chunks: Array.from({ length: parts }, () => btoa("ogg-bytes")),
						mediaType: "audio/ogg",
					}),
					{ status: 200 },
				),
			),
		);
	};

	const mount = async (jsx: ReactElement) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(jsx);
		});
	};

	const readButtons = () =>
		[...container.querySelectorAll('button[aria-label="Read aloud"]')].map(
			(b) => b as HTMLButtonElement,
		);

	const clickRead = async (index = 0) => {
		await act(async () => {
			readButtons()[index]?.dispatchEvent(
				new win.Event("click", { bubbles: true }) as unknown as Event,
			);
			await flush();
		});
	};

	// Start playback on `parts` chunks of 3s + 4s each and wait for the
	// player row to open.
	const openPlayer = async (parts = 2) => {
		stubFetch(parts);
		await mount(<Probe text="hello" />);
		await clickRead();
		const durations = [3, 4];
		await act(async () => {
			FakeAudio.made.forEach((a, i) => a.metadata(durations[i] ?? 1));
			await flush();
		});
	};

	const player = () => container.querySelector(".speech-player");

	const clickAria = async (label: string) => {
		const btn = container.querySelector(`button[aria-label="${label}"]`);
		expect(btn).not.toBeNull();
		await act(async () => {
			btn?.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
			await flush();
		});
	};

	test("tfmt renders clock time, clamping nonsense to zero", () => {
		expect(tfmt(0)).toBe("0:00");
		expect(tfmt(42)).toBe("0:42");
		expect(tfmt(187)).toBe("3:07");
		expect(tfmt(61)).toBe("1:01");
		expect(tfmt(3723)).toBe("1:02:03");
		expect(tfmt(-4)).toBe("0:00");
	});

	test("read opens the player on part one with the whole timeline", async () => {
		await openPlayer();
		expect(player()).not.toBeNull();
		expect(container.textContent).toContain("0:00 / 0:07");
		expect(container.textContent).toContain("1×");
		const first = FakeAudio.made[0]!;
		expect(first.paused).toBe(false);
		expect(first.plays).toBe(1);
		expect(first.playbackRate).toBe(1);
		expect(first.preservesPitch).toBe(true);
	});

	test("loading keeps the button at … and disabled", async () => {
		let release!: (v: unknown) => void;
		installGlobal(
			"fetch",
			() =>
				new Promise((res) => {
					release = (v) => res(v);
				}),
		);
		await mount(<Probe text="hello" />);
		await clickRead();
		const btn = readButtons()[0];
		expect(btn?.textContent).toBe("…");
		expect(btn?.disabled).toBe(true);
		await act(async () => {
			release(
				new Response(
					JSON.stringify({ chunks: [btoa("ogg")], mediaType: "audio/ogg" }),
					{ status: 200 },
				),
			);
			await flush();
		});
		await act(async () => {
			FakeAudio.made[0]?.metadata(3);
			await flush();
		});
		expect(player()).not.toBeNull();
	});

	test("part end advances to the next part; the last end closes the player", async () => {
		await openPlayer();
		await act(async () => {
			FakeAudio.made[0]?.end();
			await flush();
		});
		expect(container.textContent).toContain("0:03 / 0:07");
		expect(FakeAudio.made[1]?.plays).toBe(1);
		expect(FakeAudio.made[0]?.paused).toBe(true);
		await act(async () => {
			FakeAudio.made[1]?.end();
			await flush();
		});
		expect(player()).toBeNull();
		expect(readButtons()[0]?.textContent).toBe("▶ read");
	});

	test("an error after audible playback advances — heard audio is not a failure", async () => {
		await openPlayer();
		await act(async () => {
			FakeAudio.made[0]?.tailError();
			await flush();
		});
		// The old sequencer printed "playback failed" here while the
		// operator had heard the audio fine.
		expect(container.querySelector(".msg-err")).toBeNull();
		expect(FakeAudio.made[1]?.plays).toBe(1);
	});

	test("an error with no sound behind it names the media code and closes", async () => {
		await openPlayer();
		await act(async () => {
			FakeAudio.made[0]?.headError(4);
			await flush();
		});
		expect(container.querySelector(".msg-err")?.textContent).toBe(
			"playback failed at part 1/2 — this browser may not support ogg audio",
		);
		expect(player()).toBeNull();
	});

	test("a single-part error reads without part numbering", async () => {
		await openPlayer(1);
		await act(async () => {
			FakeAudio.made[0]?.headError(3);
			await flush();
		});
		expect(container.querySelector(".msg-err")?.textContent).toBe("playback failed (media error 3)");
	});

	test("a part that never reports a duration fails loud", async () => {
		stubFetch(2);
		await mount(<Probe text="hello" />);
		await clickRead();
		await act(async () => {
			FakeAudio.made[0]?.headError(4);
			await flush();
		});
		expect(container.querySelector(".msg-err")?.textContent).toContain(
			"speech player: audio part has no duration",
		);
		expect(player()).toBeNull();
	});

	test("seek steps cross part boundaries by global position", async () => {
		await openPlayer();
		await clickAria("Forward 10 seconds");
		// 10s clamps to 6.99 (the tail of a 7s timeline) — part two at 3.99.
		expect(FakeAudio.made[0]?.paused).toBe(true);
		expect(FakeAudio.made[1]?.plays).toBe(1);
		expect(Math.abs((FakeAudio.made[1]?.currentTime ?? 0) - 3.99)).toBeLessThan(0.01);
		await clickAria("Back 10 seconds");
		expect(FakeAudio.made[0]?.plays).toBe(2);
		expect(FakeAudio.made[0]?.currentTime).toBe(0);
		expect(FakeAudio.made[1]?.paused).toBe(true);
	});

	test("speed cycles the rate list onto the live element and persists", async () => {
		await openPlayer();
		await clickAria("Playback speed");
		expect(container.textContent).toContain("1.25×");
		expect(FakeAudio.made[0]?.playbackRate).toBe(1.25);
		expect(win.localStorage.getItem("goblin.speech.rate")).toBe("1.25");
		// From 1.25, four more clicks run the list out and wrap to 1.
		for (let i = 0; i < SPEECH_RATES.length - 1; i++) await clickAria("Playback speed");
		// 1.25 → 1.5 → 1.75 → 2 → wraps to 1.
		expect(container.textContent).toContain("1×");
		expect(FakeAudio.made[0]?.playbackRate).toBe(1);
	});

	test("a stored rate loads on the next mount", async () => {
		win.localStorage.setItem("goblin.speech.rate", "1.5");
		await openPlayer();
		expect(container.textContent).toContain("1.5×");
		expect(FakeAudio.made[0]?.playbackRate).toBe(1.5);
	});

	test("a blocked resume keeps the player open at the same spot", async () => {
		await openPlayer();
		FakeAudio.made[0]!.playRejected = new DOMException("blocked", "NotAllowedError");
		await clickAria("Back 10 seconds");
		expect(player()).not.toBeNull();
		expect(container.textContent).toContain("playback failed — blocked");
		expect(FakeAudio.made[0]?.paused).toBe(true);
		// A successful resume clears the stale complaint and plays on.
		FakeAudio.made[0]!.playRejected = null;
		await clickAria("Play");
		expect(FakeAudio.made[0]?.paused).toBe(false);
		expect(container.querySelector(".msg-err")).toBeNull();
	});

	test("pausing pauses the live element; play resumes it", async () => {
		await openPlayer();
		await clickAria("Pause");
		expect(FakeAudio.made[0]?.paused).toBe(true);
		expect(container.textContent).toContain("0:00 / 0:07");
		await clickAria("Play");
		expect(FakeAudio.made[0]?.paused).toBe(false);
	});

	test("starting a second message's read stops the first", async () => {
		stubFetch(2);
		await mount(
			<>
				<Probe text="first" />
				<Probe text="second" />
			</>,
		);
		await clickRead(0);
		await act(async () => {
			FakeAudio.made.slice(0, 2).forEach((a) => a.metadata(3));
			await flush();
		});
		expect(container.querySelectorAll(".speech-player")).toHaveLength(1);
		await clickRead(1);
		await act(async () => {
			FakeAudio.made.slice(2, 4).forEach((a) => a.metadata(4));
			await flush();
		});
		expect(FakeAudio.made[0]?.paused).toBe(true);
		expect(FakeAudio.made[2]?.paused).toBe(false);
		expect(container.querySelectorAll(".speech-player")).toHaveLength(1);
	});

	test("stop closes the player and quiets every element", async () => {
		await openPlayer();
		await clickAria("Stop");
		expect(player()).toBeNull();
		expect(FakeAudio.made[0]?.paused).toBe(true);
		expect(readButtons()[0]?.textContent).toBe("▶ read");
	});
});
