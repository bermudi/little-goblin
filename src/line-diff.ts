// Line diff for text the operator must judge before accepting a change
// (skill updates today). Pure and dependency-free: a classic LCS table
// over the lines left after trimming the common head and tail.

export type DiffLine =
	| { op: "ctx" | "add" | "del"; text: string }
	/** `skipped` unchanged lines left out between two hunks. */
	| { op: "gap"; skipped: number };

// Past this many table cells the diff degrades to "all old lines
// removed, all new lines added" — still correct, never a stalled
// request. A skill file is far below it.
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	// "a\n" is one line, not a line and an empty one.
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function lcsEdits(a: string[], b: string[]): DiffLine[] {
	if (a.length * b.length > MAX_CELLS) {
		return [
			...a.map((text): DiffLine => ({ op: "del", text })),
			...b.map((text): DiffLine => ({ op: "add", text })),
		];
	}
	const w = b.length + 1;
	const t = new Uint32Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			t[i * w + j] =
				a[i] === b[j]
					? (t[(i + 1) * w + j + 1] ?? 0) + 1
					: Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ op: "ctx", text: a[i] as string });
			i++;
			j++;
		} else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) {
			out.push({ op: "del", text: a[i] as string });
			i++;
		} else {
			out.push({ op: "add", text: b[j] as string });
			j++;
		}
	}
	for (; i < a.length; i++) out.push({ op: "del", text: a[i] as string });
	for (; j < b.length; j++) out.push({ op: "add", text: b[j] as string });
	return out;
}

/** Hunks of `before` → `after` with `context` unchanged lines around each change. */
export function diffLines(before: string, after: string, context = 3): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	)
		tail++;
	const full: DiffLine[] = [
		...a.slice(0, head).map((text): DiffLine => ({ op: "ctx", text })),
		...lcsEdits(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
		...a.slice(a.length - tail).map((text): DiffLine => ({ op: "ctx", text })),
	];

	const keep = new Array<boolean>(full.length).fill(false);
	full.forEach((line, idx) => {
		if (line.op === "ctx") return;
		for (let k = Math.max(0, idx - context); k <= Math.min(full.length - 1, idx + context); k++)
			keep[k] = true;
	});
	const out: DiffLine[] = [];
	let skipped = 0;
	full.forEach((line, idx) => {
		if (keep[idx]) {
			if (skipped > 0) out.push({ op: "gap", skipped });
			skipped = 0;
			out.push(line);
		} else {
			skipped++;
		}
	});
	// Identical text: nothing kept, nothing to show.
	return out;
}
