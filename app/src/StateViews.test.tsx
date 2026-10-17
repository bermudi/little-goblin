import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { listSkills, readSkillFile } from "../../src/stateview.ts";
import { FilesView, SkillsView } from "./StateViews.tsx";

let home: string;
let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skills-view-"));
	win = new Window({ url: "http://localhost/app/skills" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
	rmSync(home, { recursive: true, force: true });
});

test("installed and proposed file clicks round-trip the actual catalog paths", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	for (const [dir, name] of [
		[skills, "weather"],
		[proposed, "draft"],
	] as const) {
		mkdirSync(join(dir, name, "refs"), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), `${name} body`);
		writeFileSync(join(dir, name, "refs/example.md"), `${name} extra`);
	}
	// Only HTTP is replaced: both catalog and file responses come from
	// the real disk readers, so fixture paths cannot conceal a mismatch.
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills") return Response.json(listSkills(skills, proposed));
			if (url.pathname === "/api/app/skills/file") {
				const origin = url.searchParams.get("origin");
				if (origin !== "skills" && origin !== "proposed") {
					return Response.json({ error: "bad origin" }, { status: 400 });
				}
				const file = readSkillFile(
					skills,
					proposed,
					origin,
					url.searchParams.get("name") ?? "",
					url.searchParams.get("path") ?? "",
				);
				return file === null
					? Response.json({ error: "not found" }, { status: 404 })
					: Response.json(file);
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	for (const name of ["weather", "draft"]) {
		const card = [...container.querySelectorAll(".card")].find(
			(el) => el.querySelector(".op-item-title")?.textContent === name,
		);
		expect(card).toBeDefined();
		for (const [path, content] of [
			["SKILL.md", `${name} body`],
			["refs/example.md", `${name} extra`],
		]) {
			const button = [...card!.querySelectorAll("button")].find((el) => el.textContent === path);
			expect(button).toBeDefined();
			await act(async () => button?.click());
			expect(card!.querySelector("pre")?.textContent).toBe(content);
			expect(card!.querySelector(".error")).toBeNull();
		}
	}
});

// Held-response harness for skill file reads: the test resolves each
// request when it chooses, so out-of-order arrivals are exercisable.
function skillHarness() {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	mkdirSync(join(skills, "weather"), { recursive: true });
	writeFileSync(join(skills, "weather/SKILL.md"), "a body");
	writeFileSync(join(skills, "weather/b.md"), "b body");
	const pending = new Map<string, (r: Response) => void>();
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills") return Response.json(listSkills(skills, proposed));
			if (url.pathname === "/api/app/skills/file")
				return new Promise<Response>((resolve) =>
					pending.set(url.searchParams.get("path") ?? "", resolve),
				);
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	return pending;
}

const cardButton = (card: Element, label: string) =>
	[...card.querySelectorAll("button")].find((el) => el.textContent === label);

test("a proposed card's decide buttons post skills/decide and refetch the list", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	mkdirSync(join(proposed, "draft"), { recursive: true });
	writeFileSync(join(proposed, "draft/SKILL.md"), "d");
	mkdirSync(skills, { recursive: true });
	const posts: { name: string; action: string }[] = [];
	let lists = 0;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills") {
				lists++;
				return Response.json(listSkills(skills, proposed));
			}
			if (url.pathname === "/api/app/skills/decide" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as {
					name: string;
					action: "install" | "discard";
				};
				posts.push(body);
				return Response.json({
					ok: true,
					skill: body.name,
					action: body.action,
					replaced: false,
					state: body.action === "install" ? "installed" : "gone",
				});
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	const card = [...container.querySelectorAll(".card")].find(
		(el) => el.querySelector(".op-item-title")?.textContent === "draft",
	);
	expect(card).toBeDefined();
	// Installed cards carry no decide affordance.
	const install = cardButton(card!, "install");
	const discard = cardButton(card!, "discard");
	expect(install).toBeDefined();
	expect(discard).toBeDefined();
	await act(async () => install?.click());
	expect(posts).toEqual([{ name: "draft", action: "install" }]);
	// The decision resolved: the list refetched so state moves installed/gone.
	expect(lists).toBeGreaterThanOrEqual(2);
});

test("a slow file response never overwrites a newer selection", async () => {
	const pending = skillHarness();
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	const card = container.querySelector(".card")!;
	await act(async () => cardButton(card, "SKILL.md")?.click());
	await act(async () => cardButton(card, "b.md")?.click());
	expect(pending.size).toBe(2);
	// B resolves first — it is the current selection and wins.
	await act(async () =>
		pending.get("b.md")!(Response.json({ path: "weather/b.md", content: "bee" })),
	);
	expect(card.querySelector("pre")?.textContent).toBe("bee");
	// A arrives stale — success or failure, it changes nothing.
	await act(async () =>
		pending.get("SKILL.md")!(Response.json({ path: "weather/SKILL.md", content: "aye" })),
	);
	expect(card.querySelector("pre")?.textContent).toBe("bee");
	expect(card.querySelector(".error")).toBeNull();
	await act(async () => cardButton(card, "SKILL.md")?.click());
	await act(async () => cardButton(card, "b.md")?.click());
	await act(async () => pending.get("b.md")!(Response.json({ content: "bee two" })));
	await act(async () =>
		pending.get("SKILL.md")!(Response.json({ error: "gone" }, { status: 404 })),
	);
	expect(card.querySelector("pre")?.textContent).toBe("bee two");
	expect(card.querySelector(".error")).toBeNull();
});

test("an identity change discards the in-flight read and clears the stale selection", async () => {
	const pending = skillHarness();
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	const card = () => container.querySelector(".card")!;
	await act(async () => cardButton(card(), "SKILL.md")?.click());
	await act(async () => pending.get("SKILL.md")!(Response.json({ content: "shown" })));
	expect(card().querySelector("pre")?.textContent).toBe("shown");
	await act(async () => cardButton(card(), "b.md")?.click());
	// A different token means a different view — the held response for
	// the old identity must not land, and its selection must not stay.
	await act(async () => root?.render(<SkillsView token="other" />));
	await act(async () => pending.get("b.md")!(Response.json({ content: "stale" })));
	expect(card().querySelector("pre")).toBeNull();
	expect(card().querySelector(".error")).toBeNull();
	expect(card().querySelector(".skill-file.on")).toBeNull();
});

test("an unmounted card ignores its late response", async () => {
	const pending = skillHarness();
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	const card = container.querySelector(".card")!;
	await act(async () => cardButton(card, "SKILL.md")?.click());
	await act(async () => root?.unmount());
	root = null;
	// Resolving after unmount must not warn or resurrect the view.
	await act(async () => pending.get("SKILL.md")!(Response.json({ content: "late" })));
	expect(container.querySelector(".card")).toBeNull();
});

function filesHarness(files: { name: string; bytes: Uint8Array }[], status = 200): string[] {
	const requests: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			requests.push(`${url.pathname}${url.search}`);
			if (url.pathname === "/api/app/identity") return Response.json({ files: [] });
			if (url.pathname === "/api/app/attachments")
				return Response.json({
					files: files.map((f) => ({
						name: f.name,
						sizeBytes: f.bytes.length,
						updatedAt: "2026-10-12T00:00:00Z",
					})),
				});
			if (url.pathname === "/api/app/attachments/file") {
				if (status !== 200) return Response.json({ error: "nope" }, { status });
				const found = files.find((f) => f.name === url.searchParams.get("name"));
				return found === undefined
					? Response.json({ error: "not found" }, { status: 404 })
					: new Response(found.bytes.slice().buffer as ArrayBuffer);
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	return requests;
}

test("non-media attachments fetch on demand and expose a download link", async () => {
	const files = [
		{ name: "report.pdf", bytes: new TextEncoder().encode("PDF") },
		{ name: "notes.txt", bytes: new TextEncoder().encode("TXT") },
		{ name: "bundle.zip", bytes: new TextEncoder().encode("ZIP") },
	];
	const requests = filesHarness(files);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	// Nothing fetched until the row's button is clicked.
	expect(requests.filter((u) => u.startsWith("/api/app/attachments/file"))).toEqual([]);
	for (const { name } of files) {
		const card = [...container.querySelectorAll(".card")].find(
			(el) => el.querySelector(".op-item-title")?.textContent === name,
		);
		const button = cardButton(card!, "fetch file");
		expect(button, name).toBeDefined();
		await act(async () => button?.click());
		const link = card!.querySelector("a.attach-download");
		expect(link?.getAttribute("href")?.startsWith("blob:")).toBe(true);
		expect(link?.getAttribute("download")).toBe(name);
		expect(link?.textContent).toBe("download");
		expect(card!.querySelector("img, audio, video")).toBeNull();
	}
	expect(requests.filter((u) => u.startsWith("/api/app/attachments/file")).length).toBe(3);
});

// Held-response harness for attachment bytes: the file request parks
// in `pending` until the test resolves it, so late arrivals relative
// to unmount are exercisable (finding #19's leak window).
function heldAttachmentHarness(files: { name: string; bytes: Uint8Array }[]) {
	const pending = new Map<string, (r: Response) => void>();
	const requests: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/identity") return Response.json({ files: [] });
			if (url.pathname === "/api/app/attachments")
				return Response.json({
					files: files.map((f) => ({
						name: f.name,
						sizeBytes: f.bytes.length,
						updatedAt: "2026-10-12T00:00:00Z",
					})),
				});
			if (url.pathname === "/api/app/attachments/file") {
				const name = url.searchParams.get("name") ?? "";
				requests.push(name);
				return new Promise<Response>((resolve) => pending.set(name, resolve));
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	return { pending, requests };
}

const blobResponse = (bytes: Uint8Array) => new Response(bytes.slice().buffer as ArrayBuffer);

test("a fetch resolving after unmount mints no blob url", async () => {
	const { pending } = heldAttachmentHarness([
		{ name: "report.pdf", bytes: new TextEncoder().encode("PDF") },
	]);
	const created: string[] = [];
	const realCreate = URL.createObjectURL;
	URL.createObjectURL = (b: Blob) => {
		const u = realCreate(b);
		created.push(u);
		return u;
	};
	try {
		root = createRoot(container);
		await act(async () => root?.render(<FilesView token={null} />));
		const card = container.querySelector(".card")!;
		await act(async () => cardButton(card, "fetch file")?.click());
		expect(pending.size).toBe(1);
		await act(async () => root?.unmount());
		root = null;
		// The held bytes land on a dead row — nothing may be minted.
		await act(async () => {
			pending.get("report.pdf")!(blobResponse(new TextEncoder().encode("PDF")));
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(created).toEqual([]);
	} finally {
		URL.createObjectURL = realCreate;
	}
});

test("a second click while the fetch is held sends no second request", async () => {
	const { pending, requests } = heldAttachmentHarness([
		{ name: "pic.png", bytes: new TextEncoder().encode("PNG") },
	]);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	const card = container.querySelector(".card")!;
	await act(async () => cardButton(card, "preview")?.click());
	await act(async () => cardButton(card, "preview")?.click());
	expect(requests).toEqual(["pic.png"]);
	expect(pending.size).toBe(1);
	await act(async () => {
		pending.get("pic.png")!(blobResponse(new TextEncoder().encode("PNG")));
	});
	expect(card.querySelector("img")?.getAttribute("src")?.startsWith("blob:")).toBe(true);
});

test("a failed fetch reports the error and the retry refetches", async () => {
	const bytes = new TextEncoder().encode("PDF");
	let fail = true;
	const requests: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/identity") return Response.json({ files: [] });
			if (url.pathname === "/api/app/attachments")
				return Response.json({
					files: [
						{ name: "report.pdf", sizeBytes: bytes.length, updatedAt: "2026-10-12T00:00:00Z" },
					],
				});
			if (url.pathname === "/api/app/attachments/file") {
				requests.push(url.searchParams.get("name") ?? "");
				if (fail) {
					fail = false;
					return Response.json({ error: "nope" }, { status: 500 });
				}
				return blobResponse(bytes);
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	const card = container.querySelector(".card")!;
	await act(async () => cardButton(card, "fetch file")?.click());
	expect(card.querySelector(".error")?.textContent).toContain("http 500");
	await act(async () => cardButton(card, "fetch file")?.click());
	expect(requests).toEqual(["report.pdf", "report.pdf"]);
	expect(card.querySelector("a.attach-download")?.getAttribute("href")?.startsWith("blob:")).toBe(
		true,
	);
	expect(card.querySelector(".error")).toBeNull();
});

test("a failed fetch shows the error; the blob is revoked on unmount", async () => {
	const files = [{ name: "report.pdf", bytes: new TextEncoder().encode("PDF") }];
	const requests = filesHarness(files, 500);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	const card = container.querySelector(".card")!;
	await act(async () => cardButton(card, "fetch file")?.click());
	expect(card.querySelector(".error")?.textContent).toContain("http 500");
	// Now a healthy render whose blob must be released at unmount.
	await act(async () => root?.unmount());
	filesHarness(files);
	const revoked: string[] = [];
	const realRevoke = URL.revokeObjectURL;
	URL.revokeObjectURL = (u: string) => revoked.push(u);
	try {
		root = createRoot(container);
		await act(async () => root?.render(<FilesView token={null} />));
		await act(async () => cardButton(container.querySelector(".card")!, "fetch file")?.click());
		await act(async () => root?.unmount());
		root = null;
		expect(revoked.length).toBe(1);
	} finally {
		URL.revokeObjectURL = realRevoke;
	}
	expect(requests.filter((u) => u.startsWith("/api/app/attachments/file")).length).toBe(1);
});
