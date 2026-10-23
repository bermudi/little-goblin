// Skill invocation staging (ruling 2026-10-21): the composer chip, the
// picker sheet over a faked /api/app/skills, the send's data-skill
// part, and the transcript chip. Mounted with happy-dom; the network
// edge is faked at globalThis.fetch like the other client tests.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { UIMessage } from "ai";
import { Composer, MessageParts, type StagedSkill, type StagedUpload } from "./ChatView.tsx";
import { SkillPickerSheet } from "./SkillPickerSheet.tsx";

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("skill chip rendering", () => {
	test("a catalog invocation renders its chip", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[{ type: "data-skill", data: { name: "herdr" } } as unknown as UIMessage["parts"][number]]}
			/>,
		);
		expect(html).toContain("note-chip");
		expect(html).toContain("Skill · herdr");
		expect(html).not.toContain("Temp skill");
	});

	test("a temp invocation names the skill from its staged path", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[
					{
						type: "data-skill",
						data: {
							url: "https://github.com/anthropics/skills/tree/main/skills/claude-api",
							path: "/goblin/state/skillcache/d/claude-api/SKILL.md",
						},
					} as unknown as UIMessage["parts"][number],
				]}
			/>,
		);
		expect(html).toContain("Temp skill · claude-api (github.com)");
	});

	test("a temp part with an unreadable path degrades to unknown", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[
					{
						type: "data-skill",
						data: { url: "https://github.com/o/r/tree/main/x", path: "/weird" },
					} as unknown as UIMessage["parts"][number],
				]}
			/>,
		);
		expect(html).toContain("Temp skill · unknown");
	});
});

describe("Composer skill staging", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	const sent: UIMessage["parts"][] = [];
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
		sent.length = 0;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/api/app/skills")) {
				return Promise.resolve(
					jsonResponse({
						skills: [],
						proposed: [],
						catalog: [
							{ name: "herdr", description: "drive herdr panes", manualOnly: false, bodyBytes: 900 },
							{
								name: "secret",
								description: "shh",
								manualOnly: true,
								bodyBytes: 10,
							},
						],
					}),
				);
			}
			return Promise.resolve(new Response("not found", { status: 404 }));
		}) as typeof fetch;
	});

	afterEach(async () => {
		// Unmount inside act so a send's scheduled flush lands while the
		// happy-dom globals React's scheduler reads are still installed;
		// happyDOM.close() then drains the MessageChannel it rides.
		if (root !== null) {
			await act(async () => {
				root?.unmount();
				root = null;
			});
		}
		await win.happyDOM.close();
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed = [];
		globalThis.fetch = realFetch;
	});

	function ComposerHarness() {
		const [staged] = useState<StagedUpload[]>([]);
		const [stagedSkills, setStagedSkills] = useState<StagedSkill[]>([]);
		return (
			<Composer
				token={null}
				draftScope="skill-staging"
				busy={false}
				staged={staged}
				setStaged={() => {}}
				stagedNotes={[]}
				setStagedNotes={() => {}}
				stagedSkills={stagedSkills}
				setStagedSkills={setStagedSkills}
				onSend={(parts) => {
					sent.push(parts);
					return true;
				}}
			/>
		);
	}

	const q = (sel: string): Element | null => container.querySelector(sel);
	const buttonByLabel = (label: string): Element | null =>
		Array.from(container.querySelectorAll("button")).find(
			(b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
		) ?? null;

	test("picker → staged chip → send carries the part and clears the chip", async () => {
		root = createRoot(container);
		act(() => {
			root?.render(<ComposerHarness />);
		});
		const skillBtn = buttonByLabel("Invoke a skill");
		expect(skillBtn).not.toBeNull();
		await act(async () => {
			skillBtn!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		// The sheet lists the catalog, manual-only marked.
		await act(async () => {});
		expect(container.textContent).toContain("herdr");
		expect(container.textContent).toContain("manual-only");
		const row = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("herdr"),
		);
		expect(row).not.toBeNull();
		await act(async () => {
			row!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		// The chip replaced the sheet.
		expect(container.textContent).toContain("Skill · herdr");
		expect(container.textContent).not.toContain("Invoke a skill\nClose");
		// Type and send — React's value tracker needs the native setter.
		const textarea = q("textarea");
		expect(textarea).not.toBeNull();
		await act(async () => {
			const el = textarea as HTMLElement;
			el.focus();
			Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
				el,
				"run it",
			);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event);
		});
		await act(async () => {
			(textarea as HTMLTextAreaElement).dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		expect(sent).toHaveLength(1);
		const types = sent[0]!.map((p) => p.type);
		expect(types).toContain("data-skill");
		const skillPart = sent[0]!.find((p) => p.type === "data-skill") as { data: unknown };
		expect(skillPart.data).toEqual({ name: "herdr" });
		expect(types[0]).toBe("text");
		// The chip cleared on acceptance.
		expect(container.textContent).not.toContain("Skill · herdr");
	});

	test("a send with only a staged skill goes through with no text", async () => {
		root = createRoot(container);
		act(() => {
			root?.render(<ComposerHarness />);
		});
		await act(async () => {
			buttonByLabel("Invoke a skill")!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		await act(async () => {});
		const row = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("herdr"),
		)!;
		await act(async () => {
			row.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		await act(async () => {
			q("textarea")!.dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.map((p) => p.type)).toEqual(["data-skill"]);
	});

	test("a staged skill alone enables Send — a click emits the part and clears the chip", async () => {
		root = createRoot(container);
		act(() => {
			root?.render(<ComposerHarness />);
		});
		await act(async () => {
			buttonByLabel("Invoke a skill")!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		await act(async () => {});
		const row = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("herdr"),
		)!;
		await act(async () => {
			row.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		expect(container.textContent).toContain("Skill · herdr");
		const sendBtn = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Send"]',
		);
		expect(sendBtn).not.toBeNull();
		expect(sendBtn!.disabled).toBe(false);
		await act(async () => {
			sendBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.map((p) => p.type)).toEqual(["data-skill"]);
		expect((sent[0]![0] as { data: unknown }).data).toEqual({ name: "herdr" });
		expect(container.textContent).not.toContain("Skill · herdr");
	});

	test("Enter in the picker filter does not submit the enclosing composer form", async () => {
		let submits = 0;
		root = createRoot(container);
		act(() => {
			root?.render(
				// The sheet lives inside the composer's <form> — a bare Enter
				// on the filter input is an implicit form submission.
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submits++;
					}}
				>
					<SkillPickerSheet token={null} onClose={() => {}} onStage={() => {}} />
				</form>,
			);
		});
		await act(async () => {});
		const filter = container.querySelector('input[aria-label="Filter skills"]');
		expect(filter).not.toBeNull();
		// A typed filter still narrows the rows while the sheet is open.
		// Native setter + input + keyup — the same sequence the composer
		// tests drive React's controlled inputs with.
		await act(async () => {
			const el = filter as HTMLElement;
			el.focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				el,
				"herd",
			);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "d" }) as unknown as Event,
			);
		});
		expect(container.textContent).toContain("herdr");
		expect(container.textContent).not.toContain("shh");
		const enter = new win.KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			filter!.dispatchEvent(enter as unknown as Event);
		});
		expect(enter.defaultPrevented).toBe(true);
		expect(submits).toBe(0);
		expect(sent).toEqual([]);
	});
});
