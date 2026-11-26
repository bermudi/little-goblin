import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadComposerDraft, saveComposerDraft } from "../composerDraft.ts";
import { resolveChip, resolveDraft, startUpload, subscribe, thumbFor, uploadFailure } from "./uploads.ts";
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

	test("a failed upload resolves to nothing and names the file and the reason", async () => {
		const chip = startUpload("token", png);
		if (chip.state !== "uploading") throw new Error("not uploading");
		expect(uploadFailure(chip)).toBeNull();
		const done = settled();
		failure?.(new Error("upload boom"));
		await done;
		expect(resolveChip(chip)).toBeNull();
		expect(uploadFailure(chip)).toMatch(/^a\.png failed to upload: .*upload boom/);
		expect(resolveDraft({ items: [{ type: "chip", chip }], shelf: [chip] })).toEqual({ items: [], shelf: [] });
	});

	test("a failed upload leaves stored drafts alone, so the box that shows it reports it", async () => {
		const chip = startUpload("token", png);
		const draft: Draft = { items: [{ type: "chip", chip }], shelf: [] };
		saveComposerDraft("s", draft);
		const done = settled();
		failure?.(new Error("upload boom"));
		await done;
		expect(loadComposerDraft("s")).toEqual(draft);
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

	test("an unknown uploadId resolves to nothing and says to attach it again", () => {
		const chip: FileChip = {
			kind: "file",
			state: "uploading",
			uploadId: "gone",
			filename: "a.png",
			mediaType: "image/png",
			size: 3,
		};
		expect(resolveDraft({ items: [{ type: "chip", chip }], shelf: [chip] })).toEqual({ items: [], shelf: [] });
		expect(uploadFailure(chip)).toBe("a.png did not finish uploading. Attach it again.");
	});

	test("a non-image upload keeps no local thumb", () => {
		const file = new File([new Uint8Array([1])], "r.pdf", { type: "application/pdf" });
		const chip = startUpload("token", file);
		expect(thumbFor(chip)).toBeUndefined();
	});
});
