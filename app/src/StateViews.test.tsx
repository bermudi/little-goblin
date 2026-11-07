import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listSkills, readSkillFile } from "../../src/stateview.ts";
import { FilesView } from "./StateViews.tsx";

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

const cardButton = (card: Element, label: string) =>
	[...card.querySelectorAll("button")].find((el) => el.textContent === label);

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

// The Files page is a table; a row opens the file in place of the list.
const openRow = async (name: string): Promise<Element> => {
	const row = [...container.querySelectorAll(".dt-row")].find((el) =>
		el.querySelector(".dt-main")?.textContent?.includes(name),
	);
	expect(row, name).toBeDefined();
	await act(async () => (row as HTMLElement).click());
	return container.querySelector(".file-detail")!;
};
const back = () =>
	act(async () => (container.querySelector(".ops-back button") as HTMLElement).click());

test("non-media attachments fetch on demand and expose a download link", async () => {
	const files = [
		{ name: "report.pdf", bytes: new TextEncoder().encode("PDF") },
		{ name: "notes.txt", bytes: new TextEncoder().encode("TXT") },
		{ name: "bundle.zip", bytes: new TextEncoder().encode("ZIP") },
	];
	const requests = filesHarness(files);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	// Nothing fetched until a file is opened and its button is clicked.
	expect(requests.filter((u) => u.startsWith("/api/app/attachments/file"))).toEqual([]);
	for (const { name } of files) {
		const card = await openRow(name);
		// Opening a non-media file fetches nothing by itself.
		expect(requests.filter((u) => u.startsWith("/api/app/attachments/file")).length).toBeLessThan(
			files.length,
		);
		const button = cardButton(card, "fetch file");
		expect(button, name).toBeDefined();
		await act(async () => button?.click());
		const link = card.querySelector("a.attach-download");
		expect(link?.getAttribute("href")?.startsWith("blob:")).toBe(true);
		expect(link?.getAttribute("download")).toBe(name);
		expect(link?.textContent).toBe("download");
		expect(card.querySelector("img, audio, video")).toBeNull();
		await back();
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
		const card = await openRow("report.pdf");
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

test("opening an image fetches it once and shows the preview", async () => {
	const { pending, requests } = heldAttachmentHarness([
		{ name: "pic.png", bytes: new TextEncoder().encode("PNG") },
	]);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	const card = await openRow("pic.png");
	// Media previews load on open; nothing to click, no second request.
	expect(cardButton(card, "fetch file")).toBeUndefined();
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
	const card = await openRow("report.pdf");
	await act(async () => cardButton(card, "fetch file")?.click());
	expect(card.querySelector(".error")?.textContent).toContain("http 500");
	await act(async () => cardButton(card, "retry")?.click());
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
	const card = await openRow("report.pdf");
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
		await act(async () => cardButton(await openRow("report.pdf"), "fetch file")?.click());
		await act(async () => root?.unmount());
		root = null;
		expect(revoked.length).toBe(1);
	} finally {
		URL.revokeObjectURL = realRevoke;
	}
	expect(requests.filter((u) => u.startsWith("/api/app/attachments/file")).length).toBe(1);
});

test("an identity file opens in place of the list, with its text and a back link", async () => {
	const long = `${"word ".repeat(80)}\nsecond line`;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/identity")
				return Response.json({
					files: [
						{ name: "SOUL.md", content: long },
						{ name: "USER.md", content: null },
					],
				});
			if (url.pathname === "/api/app/attachments") return Response.json({ files: [] });
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	// The list shows no file text; a missing file says so in its status.
	expect(container.querySelector("pre")).toBeNull();
	expect(container.textContent).toContain("not created");
	const detail = await openRow("SOUL.md");
	expect(detail.querySelector("pre.file-text")?.textContent).toBe(long);
	expect(container.querySelector(".dtable")).toBeNull();
	await back();
	expect(container.querySelector(".dtable")).not.toBeNull();
	expect(container.querySelector(".file-detail")).toBeNull();
	const missing = await openRow("USER.md");
	expect(missing.textContent).toContain("Not created yet.");
});

test("a long attachment list gets a name filter", async () => {
	// React's input handling reads these off the global scope.
	const extra = [
		"HTMLInputElement",
		"HTMLElement",
		"HTMLUnknownElement",
		"Node",
		"Event",
		"MutationObserver",
		"getComputedStyle",
	] as const;
	for (const name of extra) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, Reflect.get(win, name));
	}
	const files = Array.from({ length: 10 }, (_, i) => ({
		name: i === 3 ? "needle.pdf" : `file-${i}.txt`,
		bytes: new TextEncoder().encode("x"),
	}));
	filesHarness(files);
	root = createRoot(container);
	await act(async () => root?.render(<FilesView token={null} />));
	const input = container.querySelector<HTMLInputElement>(
		"input[aria-label='filter attachments']",
	)!;
	expect(container.querySelectorAll(".dt-row").length).toBe(10);
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
		input.focus();
		setter.call(input, "needle");
		input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
		// React's text-input fallback needs a keyup in this environment.
		input.dispatchEvent(
			new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
		);
	});
	expect(container.querySelectorAll(".dt-row").length).toBe(1);
});
