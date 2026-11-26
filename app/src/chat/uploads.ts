import { uploadAttachment } from "../api.ts";
import { rewriteComposerDrafts } from "../composerDraft.ts";
import { normalizeDraft, type Chip, type Draft, type FileChip, type FileRef } from "./draft.ts";

interface UploadEntry {
	file: File;
	token: string | null;
	speech?: true;
	thumb: string | null;
	state: "uploading" | { settled: "ready"; ref: FileRef } | { settled: "error"; message: string };
}

const entries = new Map<string, UploadEntry>();
const thumbs = new Map<string, string>();
const listeners = new Set<() => void>();

function newId(): string {
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function startUpload(token: string | null, file: File, opts: { speech?: true } = {}): FileChip {
	const uploadId = newId();
	const chip: FileChip = {
		kind: "file",
		state: "uploading",
		uploadId,
		filename: file.name,
		mediaType: file.type,
		size: file.size,
		...(opts.speech === true ? { speech: true } : {}),
	};
	entries.set(uploadId, {
		file,
		token,
		...(opts.speech === true ? { speech: true } : {}),
		thumb: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
		state: "uploading",
	});
	void settle(uploadId, uploadAttachment(token, file));
	return chip;
}

async function settle(uploadId: string, run: Promise<{ ref: FileRef }>): Promise<void> {
	let outcome: UploadEntry["state"];
	try {
		const res = await run;
		outcome = { settled: "ready", ref: res.ref };
	} catch (e) {
		outcome = { settled: "error", message: e instanceof Error ? e.message : String(e) };
	}
	const entry = entries.get(uploadId);
	if (entry === undefined) return;
	entry.state = outcome;
	if (outcome.settled === "ready" && entry.thumb !== null) thumbs.set(outcome.ref.path, entry.thumb);
	if (outcome.settled === "ready") rewriteComposerDrafts((draft) => rewriteDraftOf(draft, uploadId));
	for (const listener of [...listeners]) listener();
}

function rewriteDraftOf(draft: Draft, uploadId: string): Draft {
	const rewrite = (chip: FileChip): FileChip =>
		chip.state === "ready" || chip.uploadId !== uploadId ? chip : (resolveChip(chip) ?? chip);
	return normalizeDraft({
		items: draft.items.map((item) =>
			item.type === "chip" && item.chip.kind === "file" ? { type: "chip", chip: rewrite(item.chip) } : item,
		),
		shelf: draft.shelf.map(rewrite),
	});
}

export function uploadFailure(chip: Chip): string | null {
	if (chip.kind !== "file" || chip.state === "ready") return null;
	const entry = entries.get(chip.uploadId);
	if (entry === undefined) return `${chip.filename} did not finish uploading. Attach it again.`;
	if (typeof entry.state === "object" && entry.state.settled === "error")
		return `${chip.filename} failed to upload: ${entry.state.message}`;
	return null;
}

export function thumbFor(chip: FileChip): string | undefined {
	if (chip.state === "ready") return thumbs.get(chip.ref.path);
	const entry = entries.get(chip.uploadId);
	if (entry === undefined) return undefined;
	return entry.thumb ?? undefined;
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resolveChip(chip: FileChip): FileChip | null;
export function resolveChip(chip: Chip): Chip | null;
export function resolveChip(chip: Chip): Chip | null {
	if (chip.kind !== "file" || chip.state === "ready") return chip;
	if (uploadFailure(chip) !== null) return null;
	const entry = entries.get(chip.uploadId);
	if (entry === undefined || entry.state === "uploading" || entry.state.settled !== "ready") return chip;
	return {
		kind: "file",
		state: "ready",
		ref: { ...entry.state.ref, ...(entry.speech === true ? { speech: true } : {}) },
	};
}

export function resolveDraft(draft: Draft): Draft {
	const items: Draft["items"] = [];
	for (const item of draft.items) {
		if (item.type !== "chip") {
			items.push(item);
			continue;
		}
		const chip = resolveChip(item.chip);
		if (chip !== null) items.push({ type: "chip", chip });
	}
	const shelf: FileChip[] = [];
	for (const file of draft.shelf) {
		const chip = resolveChip(file);
		if (chip !== null) shelf.push(chip);
	}
	return normalizeDraft({ items, shelf });
}
