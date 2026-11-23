// Interactive Composer behavior — the staged-upload lifecycle that
// static markup can't see. Mounted with happy-dom; the network edge
// (api.ts) is faked at globalThis.fetch, the only place uploads and
// config loads touch the wire. Two staged files may share a filename
// (pasted images all arrive "image.png"), so upload completion must
// resolve by the entry's client key, never by name — otherwise the
// first completion captures every same-named row and the later one
// lands nowhere.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { UIMessage } from "ai";
import { Composer } from "./Composer.tsx";
import type { StagedNote, StagedSkill, StagedUpload } from "./staged.ts";

// The server's side of the contract: each upload lands on its own
// UUID-stemmed path (persistAttachment), so distinct uploads NEVER share
// a path even for identical filenames.
const refFor = (path: string) => ({
	path,
	mediaType: "image/jpeg",
	filename: "image.jpg",
	size: 3,
});

interface Deferred {
	promise: Promise<Response>;
	settle: { ok: (ref: { path: string }) => void; fail: () => void };
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Uploads resolve only when the test says so — that's what makes the
// completions "overlapping": both requests are in flight before either
// answers.
function deferredUpload(): Deferred {
	let ok!: (res: Response) => void;
	let fail!: (err: unknown) => void;
	const promise = new Promise<Response>((res, rej) => {
		ok = res;
		fail = rej;
	});
	return {
		promise,
		settle: {
			ok: (ref) => ok(jsonResponse({ ref }, 201)),
			fail: () => fail(new Error("upload boom")),
		},
	};
}

describe("Composer staged uploads (same filename, issue #78)", () => {
	let win: Window;
	// The container lives in the lib.dom type world (what react-dom's
	// types expect); the happy-dom realm supplies the runtime. One
	// deliberate cast at the seam — inside the test everything comes
	// from the same happy-dom window, so the values are coherent.
	let container: HTMLElement;
	let root: Root | null = null;
	let uploads: Deferred[] = [];
	const sent: UIMessage["parts"][] = [];
	let sentModelSettings: { model: string; thinking: string } | undefined;
	const configCalls: { url: string; method: string }[] = [];
	let phoneWidth = false;
	// Globals the React tree expects; installed per test, removed after.
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		uploads = [];
		phoneWidth = false;
		sent.length = 0;
		sentModelSettings = undefined;
		configCalls.length = 0;
		installed = [];
		// React's client scheduler and event system need a coherent DOM
		// world; happy-dom's window provides it, Bun provides the rest
		// (crypto, Response, MessageChannel).
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("MouseEvent", win.MouseEvent);
		installGlobal("PointerEvent", win.PointerEvent);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		installGlobal("HTMLElement", win.HTMLElement);
		installGlobal("HTMLFieldSetElement", win.HTMLFieldSetElement);
		installGlobal("HTMLInputElement", win.HTMLInputElement);
		installGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
		installGlobal("Element", win.Element);
		installGlobal("Node", win.Node);
		installGlobal("ShadowRoot", win.ShadowRoot);
		installGlobal("MutationObserver", win.MutationObserver);
		installGlobal("ResizeObserver", win.ResizeObserver);
		installGlobal("NodeFilter", (win as unknown as { NodeFilter: unknown }).NodeFilter);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
		Reflect.set(win, "matchMedia", (query: string) => ({
			matches: phoneWidth && query.includes("max-width: 720"),
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/api/app/config")) {
				configCalls.push({
					url,
					method: init?.method ?? "GET",
				});
			}
			// The mount-time config load answers immediately; uploads queue
			// and settle only when the test says so — that is the overlap.
			if (url === "/api/app/attachments") {
				const d = deferredUpload();
				uploads.push(d);
				return d.promise;
			}
			if (url === "/api/app/config/preview") {
				const requested = JSON.parse(String(init?.body)) as {
					model: string;
					thinking: string;
				};
				return Promise.resolve(
					jsonResponse({
						...requested,
						favorites: [],
						catalog: [],
						thinkingLevels: ["off", "high"],
					}),
				);
			}
			return Promise.resolve(
				jsonResponse({
					model: "prov/model",
					thinking: "off",
					favorites: ["prov/chat-only"],
					catalog: [],
					thinkingLevels: ["off", "high"],
				}),
			);
		}) as typeof fetch;
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		globalThis.fetch = realFetch;
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed = [];
	});

	// The staged list is owned above the composer (#118); for direct
	// mounts this harness is that owner.
	function ComposerHarness({
		onSend,
		draftRestore = null,
		draftScope = "test",
		busy = false,
		onStop,
	}: {
		onSend: (
			parts: UIMessage["parts"],
			whenBusy?: "steer" | "followUp",
			initialModelSettings?: { model: string; thinking: string },
		) => void | boolean | Promise<boolean>;
		draftRestore?: { parts: UIMessage["parts"] } | null;
		draftScope?: string;
		busy?: boolean;
		onStop?: () => void;
	}) {
		const [staged, setStaged] = useState<StagedUpload[]>([]);
		const [stagedNotes, setStagedNotes] = useState<StagedNote[]>([]);
		const [stagedSkills, setStagedSkills] = useState<StagedSkill[]>([]);
		return (
			<Composer
				token={null}
				draftScope={draftScope}
				busy={busy}
				{...(onStop === undefined ? {} : { onStop })}
				staged={staged}
				setStaged={setStaged}
				stagedNotes={stagedNotes}
				setStagedNotes={setStagedNotes}
				stagedSkills={stagedSkills}
				setStagedSkills={setStagedSkills}
				onSend={onSend}
				draftRestore={draftRestore}
			/>
		);
	}

	const mount = async (draftRestore: { parts: UIMessage["parts"] } | null = null) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ComposerHarness
					onSend={(parts, _whenBusy, settings) => {
						sent.push(parts);
						sentModelSettings = settings;
					}}
					draftRestore={draftRestore}
				/>,
			);
			await Promise.resolve();
		});
	};

	// Stage files through the real hidden input — the one picking seam
	// every entry path (picker, paste, drop) funnels through.
	const stage = async (contents: string[]) => {
		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		const files = contents.map((c) => new File([c], "image.jpg", { type: "image/jpeg" }));
		Object.defineProperty(input, "files", { value: files });
		await act(async () => {
			input?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
	};

	const submit = async () => {
		const form = container.querySelector("form");
		expect(form).not.toBeNull();
		await act(async () => {
			form?.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
	};

	test("draft model selection is staged for this chat without writing defaults", async () => {
		await mount({ parts: [{ type: "text", text: "hello" }] });
		const model = container.querySelector<HTMLButtonElement>('button[aria-label="Model for this chat"]');
		expect(model).not.toBeNull();
		await act(async () => model!.click());
		const alternate = container.querySelector<HTMLButtonElement>('button[role="menuitemradio"][title="prov/chat-only"]');
		expect(alternate).not.toBeNull();
		await act(async () => alternate!.click());
		expect(model!.title).toBe("prov/chat-only");
		const thinking = container.querySelector(
			'select[aria-label="New app chat thinking"]',
		) as HTMLSelectElement | null;
		expect(thinking).not.toBeNull();
		await act(async () => {
			thinking!.value = "high";
			thinking!.dispatchEvent(
				new win.Event("change", { bubbles: true }) as unknown as Event,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await submit();
		expect(sent).toHaveLength(1);
		expect(sentModelSettings).toEqual({ model: "prov/chat-only", thinking: "high" });
		expect(configCalls.some((call) => call.url === "/api/app/config" && call.method !== "GET")).toBe(false);
	});

	test("untouched draft model settings do not override the defaults at creation", async () => {
		await mount({ parts: [{ type: "text", text: "hello" }] });
		await submit();
		expect(sent).toHaveLength(1);
		expect(sentModelSettings).toBeUndefined();
	});

	// Type through the real textarea — native value setter + input +
	// keyup, React's text-input fallback included (same as ChatView's
	// steering test).
	const type = async (text: string) => {
		const ta = container.querySelector("form.composer textarea");
		expect(ta).not.toBeNull();
		await act(async () => {
			const el = ta as HTMLElement;
			el.focus();
			Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
				el,
				text,
			);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
	};
	const textareaValue = () =>
		container.querySelector<HTMLTextAreaElement>("form.composer textarea")?.value ?? null;

	const click = async (element: Element | null) => {
		expect(element).not.toBeNull();
		await act(async () => {
			element?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
		});
	};

	test("phone composer groups its add actions in one menu", async () => {
		phoneWidth = true;
		await mount();
		const bar = container.querySelector(".composer-bar");
		expect(bar?.querySelector('button[aria-label="Attach"]')).toBeNull();
		expect(bar?.querySelector('button[aria-label="Attach a note"]')).toBeNull();
		expect(bar?.querySelector('button[aria-label="Invoke a skill"]')).toBeNull();
		await click(bar?.querySelector('button[aria-label="Add"]') ?? null);
		expect(
			[...win.document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
		).toEqual(["Attach a file", "Attach a note", "Invoke a skill"]);
	});

	test("phone add menu opens note and skill pickers and clicks the file input", async () => {
		phoneWidth = true;
		await mount();
		const fileInput = container.querySelector('input[type="file"]');
		expect(fileInput).not.toBeNull();
		let fileClicks = 0;
		fileInput?.addEventListener("click", () => fileClicks++);
		const choose = async (label: string) => {
			await click(container.querySelector('button[aria-label="Add"]'));
			const item = [...win.document.querySelectorAll('[role="menuitem"]')].find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			await click(item === undefined ? null : (item as unknown as Element));
		};
		await choose("Attach a note");
		expect(container.querySelector(".note-pick")).not.toBeNull();
		expect(win.document.querySelector('[role="menuitem"]')).toBeNull();
		await choose("Invoke a skill");
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		await click(container.querySelector('button[aria-label="Close"]'));
		await choose("Attach a file");
		expect(fileClicks).toBe(1);
	});

	test("phone keeps the supported voice-note button in the composer bar", async () => {
		phoneWidth = true;
		installGlobal("MediaRecorder", class {});
		Object.defineProperty(win.navigator, "mediaDevices", {
			value: { getUserMedia: async () => ({ getTracks: () => [] }) },
		});
		await mount();
		const mic = container.querySelector('button[aria-label="Record a voice note"]');
		expect(mic).not.toBeNull();
		expect(mic?.closest(".composer-bar")).not.toBeNull();
	});

	test("desktop keeps the three separate add buttons", async () => {
		await mount();
		const bar = container.querySelector(".composer-bar");
		expect(bar?.querySelector('button[aria-label="Attach"]')).not.toBeNull();
		expect(bar?.querySelector('button[aria-label="Attach a note"]')).not.toBeNull();
		expect(bar?.querySelector('button[aria-label="Invoke a skill"]')).not.toBeNull();
		expect(bar?.querySelector('button[aria-label="Add"]')).toBeNull();
	});

	test("one action switches between stop and send as the draft changes", async () => {
		let stops = 0;
		root = createRoot(container);
		await act(async () => {
			root?.render(<ComposerHarness busy onStop={() => stops++} onSend={(parts) => { sent.push(parts); }} />);
		});
		expect(container.querySelectorAll(".stop-btn, .send-btn")).toHaveLength(1);
		await act(async () => (container.querySelector<HTMLButtonElement>(".stop-btn")?.click()));
		expect(stops).toBe(1);
		await type("  ");
		expect(container.querySelector(".stop-btn")).not.toBeNull();
		await type("steer");
		expect(container.querySelector(".stop-btn")).toBeNull();
		expect(container.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBe(false);
		await submit();
		expect(sent).toEqual([[{ type: "text", text: "steer" }]]);
		expect(container.querySelector(".stop-btn")).not.toBeNull();
		await type("changed my mind");
		await type("");
		expect(container.querySelector(".stop-btn")).not.toBeNull();
		expect(container.querySelector(".send-btn")).toBeNull();
	});

	test("an attachment replaces stop with send, including while uploading", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<ComposerHarness busy onStop={() => {}} onSend={(parts) => { sent.push(parts); }} />);
		});
		await stage(["image"]);
		expect(container.querySelector(".stop-btn")).toBeNull();
		expect(container.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBe(true);
		await act(async () => uploads[0]?.settle.ok(refFor("attachments/test")));
		expect(container.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBe(false);
		await submit();
		expect(sent).toEqual([[{ type: "data-attachment", data: refFor("attachments/test") }]]);
		expect(container.querySelector(".stop-btn")).not.toBeNull();
	});

	test.each([false, true])(
		"a declined voice send stages one resendable chip (restored while pending: %s)",
		async (restoreWhilePending) => {
			class FakeMediaRecorder {
				static isTypeSupported() {
					return true;
				}
				mimeType = "audio/ogg;codecs=opus";
				ondataavailable: ((event: { data: Blob }) => void) | null = null;
				onstop: (() => void) | null = null;
				start() {}
				stop() {
					this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
					this.onstop?.();
				}
			}
			installGlobal("MediaRecorder", FakeMediaRecorder);
			installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
			Object.defineProperty(win.navigator, "mediaDevices", {
				value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
			});
			let decline!: (accepted: boolean) => void;
			const pendingSend = new Promise<boolean>((resolve) => {
				decline = resolve;
			});
			const onSend = (parts: UIMessage["parts"]) => {
				sent.push(parts);
				return sent.length === 1 ? pendingSend : true;
			};
			root = createRoot(container);
			await act(async () => {
				root?.render(<ComposerHarness onSend={onSend} />);
			});
			const click = async (label: string) => {
				const button = container.querySelector(`button[aria-label="${label}"]`);
				expect(button).not.toBeNull();
				await act(async () => {
					button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
				});
			};
			await click("Record a voice note");
			await click("Stop and send");
			expect(uploads.length).toBe(1);
			const ref = {
				path: "attachments/voice",
				mediaType: "audio/ogg;codecs=opus",
				filename: "voice-note.ogg",
				size: 5,
			};
			await act(async () => {
				uploads[0]?.settle.ok(ref);
			});
			expect(sent).toEqual([[{ type: "data-attachment", data: { ...ref, speech: true } }]]);
			if (restoreWhilePending) {
				// Lazy-create cancellation restores the scoped draft before its
				// cleanup request finishes and onSend resolves false.
				await act(async () => {
					root?.render(<ComposerHarness onSend={onSend} draftRestore={{ parts: sent[0]! }} />);
				});
				expect(container.querySelectorAll(".attachment").length).toBe(1);
			}
			await act(async () => decline(false));
			expect(container.querySelectorAll(".attachment").length).toBe(1);
			await submit();
			expect(sent.length).toBe(2);
			expect(sent[1]).toEqual([{ type: "data-attachment", data: { ...ref, speech: true } }]);
			expect(container.querySelectorAll(".attachment").length).toBe(0);
		},
	);

	test("unmounting mid-recording stops the recorder and releases the mic", async () => {
		// The recorder is click-to-start and its stop affordances unmount
		// with the composer — a route change mid-recording must tear the
		// capture down at the unmount itself, or the mic stays hot with
		// no in-app path to stop it.
		let trackStops = 0;
		class FakeMediaRecorder {
			static isTypeSupported() {
				return true;
			}
			mimeType = "audio/ogg;codecs=opus";
			ondataavailable: ((event: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			state = "inactive";
			start() {
				this.state = "recording";
			}
			stop() {
				this.state = "inactive";
				this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
				this.onstop?.();
			}
		}
		installGlobal("MediaRecorder", FakeMediaRecorder);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		Object.defineProperty(win.navigator, "mediaDevices", {
			value: {
				getUserMedia: async () => ({
					getTracks: () => [
						{
							stop: () => {
								trackStops += 1;
							},
						},
					],
				}),
			},
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ComposerHarness
					onSend={(parts) => {
						sent.push(parts);
					}}
				/>,
			);
		});
		const mic = () => container.querySelector('button[aria-label="Record a voice note"]');
		expect(mic()).not.toBeNull();
		await act(async () => {
			mic()?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
		});
		// Recording is live: the flipped label and the rec row, tracks open.
		expect(container.querySelector('button[aria-label="Stop and send"]')).not.toBeNull();
		expect(container.querySelector(".rec-dot")).not.toBeNull();
		expect(trackStops).toBe(0);
		// Navigating away unmounts the composer mid-recording.
		await act(async () => {
			root?.unmount();
			root = null;
		});
		// The recorder stopped — its onstop released the tracks and, with
		// the cancel flag set, sent nothing: the orphaned capture is
		// dropped, not uploaded from the dead tree.
		expect(trackStops).toBe(1);
		expect(uploads.length).toBe(0);
		expect(sent.length).toBe(0);
	});

	test("a permission grant landing after unmount releases the fresh tracks", async () => {
		// The getUserMedia window: the prompt can outlive the composer —
		// a grant landing on the dead tree must release the device it
		// just returned instead of opening a mic nobody owns.
		let trackStops = 0;
		const gate = Promise.withResolvers<{ getTracks: () => Array<{ stop: () => void }> }>();
		class FakeMediaRecorder {
			static isTypeSupported() {
				return true;
			}
			mimeType = "audio/ogg;codecs=opus";
			ondataavailable: ((event: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			state = "inactive";
			start() {
				this.state = "recording";
			}
			stop() {
				this.state = "inactive";
				this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
				this.onstop?.();
			}
		}
		installGlobal("MediaRecorder", FakeMediaRecorder);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		Object.defineProperty(win.navigator, "mediaDevices", {
			value: { getUserMedia: () => gate.promise },
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ComposerHarness
					onSend={(parts) => {
						sent.push(parts);
					}}
				/>,
			);
		});
		await act(async () => {
			container
				.querySelector('button[aria-label="Record a voice note"]')
				?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
		});
		// Still waiting on the prompt — nothing is recording yet.
		expect(container.querySelector('button[aria-label="Record a voice note"]')).not.toBeNull();
		await act(async () => {
			root?.unmount();
			root = null;
		});
		await act(async () => {
			gate.resolve({ getTracks: () => [{ stop: () => void trackStops++ }] });
		});
		// The grant landed on a dead composer: the tracks it returned were
		// released immediately, and no recorder was ever built.
		expect(trackStops).toBe(1);
		expect(uploads.length).toBe(0);
		expect(sent.length).toBe(0);
	});

	test("overlapping same-name uploads each resolve to their own ref (stage order)", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		// Both uploads fired before either settled — the overlap.
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.ok(refFor("attachments/one"));
		});
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([
			{ type: "data-attachment", data: refFor("attachments/one") },
			{ type: "data-attachment", data: refFor("attachments/two") },
		]);
	});

	test("completion in reverse order still binds each entry to its own upload", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await act(async () => {
			uploads[0]?.settle.ok(refFor("attachments/one"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([
			{ type: "data-attachment", data: refFor("attachments/one") },
			{ type: "data-attachment", data: refFor("attachments/two") },
		]);
	});

	test("a failed same-name upload marks only its own entry; the other sends", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.fail();
		});
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([{ type: "data-attachment", data: refFor("attachments/two") }]);
		// The failed row stays staged as its own chip — the operator can
		// remove it; it must not have swallowed the sibling.
		expect(container.querySelectorAll(".attachment.failed").length).toBe(1);
	});

	test("typing persists the draft per scope; a fresh mount restores it", async () => {
		await mount();
		await type("saved from ctrl+w");
		expect(win.localStorage.getItem("goblin.composer-draft.v1:test")).toContain(
			"saved from ctrl+w",
		);
		// A closed and reopened tab is a fresh mount of the same scope.
		await act(async () => {
			root?.unmount();
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ComposerHarness
					onSend={(parts) => {
						sent.push(parts);
					}}
				/>,
			);
		});
		expect(textareaValue()).toBe("saved from ctrl+w");
		// Another scope's composer starts clean — one conversation's
		// draft never leaks into another's.
		await act(async () => {
			root?.unmount();
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ComposerHarness
					draftScope="other"
					onSend={(parts) => {
						sent.push(parts);
					}}
				/>,
			);
		});
		expect(textareaValue()).toBe("");
	});

	test("an accepted send clears the stored draft; a declined one keeps it", async () => {
		let accept = false;
		root = createRoot(container);
		await act(async () => {
			root?.render(<ComposerHarness onSend={() => accept} />);
		});
		await type("keep or clear");
		await submit();
		// Declined (failed lazy create): the draft stays for a resend.
		expect(win.localStorage.getItem("goblin.composer-draft.v1:test")).toContain("keep or clear");
		expect(textareaValue()).toBe("keep or clear");
		accept = true;
		await submit();
		expect(win.localStorage.getItem("goblin.composer-draft.v1:test")).toBeNull();
		expect(textareaValue()).toBe("");
	});

	test("an accepted send clears the stored draft even after the composer unmounts", async () => {
		// The lazy-create swap: onSend stays in flight while the view —
		// and this composer with it — unmounts. The accept lands on a
		// dead tree whose persist effect never runs, so the accept path
		// itself must write the clear.
		let accept!: (accepted: boolean) => void;
		const pendingSend = new Promise<boolean>((resolve) => {
			accept = resolve;
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(<ComposerHarness onSend={() => pendingSend} />);
		});
		await type("sent from the start screen");
		expect(win.localStorage.getItem("goblin.composer-draft.v1:test")).toContain(
			"sent from the start screen",
		);
		await submit();
		await act(async () => {
			root?.unmount();
			root = null;
		});
		await act(async () => {
			accept(true);
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(win.localStorage.getItem("goblin.composer-draft.v1:test")).toBeNull();
	});

	test("an unreadable stored draft says why, starts empty, and waits for typing", async () => {
		const KEY = "goblin.composer-draft.v1:test";
		const raw = "{not json";
		win.localStorage.setItem(KEY, raw);
		await mount();
		expect(textareaValue()).toBe("");
		expect(container.textContent).toContain("couldn't be read");
		// Unreadable bytes stay in place until the operator types over
		// them — no silent delete on mount.
		expect(win.localStorage.getItem(KEY)).toBe(raw);
		await type("fresh start");
		expect(win.localStorage.getItem(KEY)).toContain("fresh start");
	});
});
