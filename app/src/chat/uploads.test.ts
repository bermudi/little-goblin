import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadComposerDraft, saveComposerDraft } from "../composerDraft.ts";
import { canRetry, retryUpload, resolveDraft, startUpload, subscribe, thumbFor, uploadError } from "./uploads.ts";
import { type Draft, type FileChip } from "./draft.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const win = new Window();
const storage = win.localStorage;

let pending: ((res: Response) => void) | null = null;
let failure: ((err: unknown) => void) | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
	Reflect.set(globalThis, "localStorage", storage);
	storage.clear();
	pending = null;
	failure = null;
	globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
		new Promise<Response>((res, rej) => {
			pending = res;
			failure = rej;
		})) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	Reflect.deleteProperty(globalThis, "localStorage");
});

const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

const settled = (): Promise<void> =>
	new Promise((res) => {
		const off = subscribe(() => {
			off();
			res();
		});
	});

const okResponse = (path: string) =>
	jsonResponse({ ref: { path, mediaType: "image/png", filename: "a.png", size: 3 } }, 201);

describe("uploads registry", () => {
	test("a settle rewrites a stored draft of an unmounted scope, then notifies", async () => {
		const chip = startUpload("token", png);
		const draft: Draft = { items: [{ type: "chip", chip }], shelf: [chip] };
		saveComposerDraft("app/c-1", draft);
		expect(loadComposerDraft("app/c-1")).toEqual(draft);
		const done = settled();
		pending?.(okResponse("attachments/one"));
		await done;
		const stored = loadComposerDraft("app/c-1");
		expect(stored).toEqual({
			items: [
				{
					type: "chip",
					chip: { kind: "file", state: "ready", ref: { path: "attachments/one", mediaType: "image/png", filename: "a.png", size: 3 } },
				},
			],
			shelf: [
				{ kind: "file", state: "ready", ref: { path: "attachments/one", mediaType: "image/png", filename: "a.png", size: 3 } },
			],
		});
	});

	test("a settle rewrites only the chip that settled, not another tab's uploading chip", async () => {
		const chip = startUpload("token", png);
		const other: FileChip = {
			kind: "file",
			state: "uploading",
			uploadId: "other-tab",
			filename: "z.png",
			mediaType: "image/png",
			size: 9,
		};
		const draft: Draft = {
			items: [{ type: "text", text: "see " }, { type: "chip", chip: other }, { type: "chip", chip }],
			shelf: [chip],
		};
		saveComposerDraft("app/c-2", draft);
		const done = settled();
		pending?.(okResponse("attachments/four"));
		await done;
		const stored = loadComposerDraft("app/c-2");
		expect(stored).not.toBeNull();
		if (stored === null) throw new Error("no stored draft");
		const items = stored.items;
		expect(items[1]).toEqual({ type: "chip", chip: other });
		expect(items[2]).toEqual({
			type: "chip",
			chip: { kind: "file", state: "ready", ref: { path: "attachments/four", mediaType: "image/png", filename: "a.png", size: 3 } },
		});
		expect(stored.shelf).toEqual([
			{ kind: "file", state: "ready", ref: { path: "attachments/four", mediaType: "image/png", filename: "a.png", size: 3 } },
			other,
		]);
	});

	test("canRetry and uploadError are pure reads of the registry", async () => {
		const unknown: FileChip = {
			kind: "file",
			state: "failed",
			uploadId: "nope",
			filename: "x.txt",
			mediaType: "text/plain",
			size: 1,
		};
		expect(canRetry(unknown)).toBe(false);
		expect(uploadError(unknown)).toBeNull();
		const chip = startUpload("token", png);
		if (chip.state !== "uploading") throw new Error("not uploading");
		const known: FileChip = { ...chip, state: "failed" };
		expect(canRetry(known)).toBe(true);
		const done = settled();
		failure?.(new Error("boom"));
		await done;
		expect(uploadError(known)).toContain("boom");
	});

	test("a failed upload maps to a failed chip", async () => {
		const chip = startUpload("token", png);
		if (chip.state !== "uploading") throw new Error("not uploading");
		const done = settled();
		failure?.(new Error("upload boom"));
		await done;
		const resolved = resolveDraft({ items: [{ type: "chip", chip }], shelf: [] });
		expect(resolved.items[0]).toEqual({ type: "chip", chip: { ...chip, state: "failed" } });
	});

	test("retry replaces a failed chip with a fresh uploading one that can settle", async () => {
		const chip = startUpload("token", png);
		if (chip.state !== "uploading") throw new Error("not uploading");
		const failed = settled();
		failure?.(new Error("upload boom"));
		await failed;
		const again = retryUpload({ ...chip, state: "failed" });
		expect(again).not.toBeNull();
		if (again === null || again.state === "ready") throw new Error("retry not uploading");
		expect(again.state).toBe("uploading");
		expect(again.uploadId).not.toBe(chip.uploadId);
		const done = settled();
		pending?.(okResponse("attachments/two"));
		await done;
		const resolved = resolveDraft({ items: [{ type: "chip", chip: again }], shelf: [] });
		expect(resolved.items[0]).toEqual({
			type: "chip",
			chip: { kind: "file", state: "ready", ref: { path: "attachments/two", mediaType: "image/png", filename: "a.png", size: 3 } },
		});
	});

	test("a thumb is served while uploading and by path once ready", async () => {
		const chip = startUpload("token", png);
		expect(typeof thumbFor(chip)).toBe("string");
		const done = settled();
		pending?.(okResponse("attachments/three"));
		await done;
		const ready = resolveDraft({ items: [{ type: "chip", chip }], shelf: [] }).items[0];
		expect(
			ready !== undefined && ready.type === "chip" && ready.chip.kind === "file"
				? thumbFor(ready.chip)
				: null,
		).not.toBeNull();
	});

	test("an unknown uploadId becomes failed, with no retry", () => {
		const chip: FileChip = {
			kind: "file",
			state: "uploading",
			uploadId: "gone",
			filename: "a.png",
			mediaType: "image/png",
			size: 3,
		};
		const resolved = resolveDraft({ items: [{ type: "chip", chip }], shelf: [chip] });
		expect(resolved).toEqual({
			items: [{ type: "chip", chip: { ...chip, state: "failed" } }],
			shelf: [{ ...chip, state: "failed" }],
		});
		expect(retryUpload(chip)).toBeNull();
	});

	test("a non-image upload keeps no local thumb", () => {
		const file = new File([new Uint8Array([1])], "r.pdf", { type: "application/pdf" });
		const chip = startUpload("token", file);
		expect(thumbFor(chip)).toBeUndefined();
	});
});
