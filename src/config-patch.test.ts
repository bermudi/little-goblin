import { describe, expect, test } from "bun:test";
import JSON5 from "json5";
import { patchConfigText } from "./config-patch.ts";

// Schema-mimicking normalize: keeps only declared keys, like
// parseConfig stripping unknowns — adequate for patch mechanics. The
// materialized-defaults case gets a defaulted normalize below.
const id = (raw: unknown) =>
	Object.fromEntries(
		Object.entries(raw as Record<string, unknown>).filter(([k]) => KEYS.has(k)),
	);
const KEYS = new Set(["model", "thinking", "transcription", "providers", "operators", "search"]);

const patch = (
	text: string,
	merged: Record<string, unknown>,
	normalize: (raw: unknown) => Record<string, unknown> = id,
) => patchConfigText(text, merged, normalize, KEYS);

describe("patchConfigText", () => {
	test("an unchanged file survives byte-for-byte — comments, ordering, spacing", () => {
		const text = `// my config
{
  // the chat model
  model: "a/b",   // trailing note

  thinking: "low", // keep it cheap
}
`;
		expect(patch(text, { model: "a/b", thinking: "low" })).toBe(text);
	});

	test("a changed scalar rewrites only its value — neighbors keep their bytes", () => {
		const text = `{
  // the chat model
  model: "a/b",
  thinking: "low", // keep it cheap
}`;
		const out = patch(text, { model: "a/b", thinking: "high" });
		expect(out).toBe(`{
  // the chat model
  model: "a/b",
  thinking: 'high', // keep it cheap
}`);
	});

	test("a cleared known key deletes its line — comments it owned stay put", () => {
		const text = `{
  model: "a/b",
  // speech to text
  transcription: { kind: "groq" },
  operators: [7],
}`;
		const out = patch(text, { model: "a/b", operators: [7] });
		expect(out).toBe(`{
  model: "a/b",
  // speech to text
  operators: [7],
}`);
	});

	test("the last entry without a trailing comma takes the previous comma with it", () => {
		const text = `{
  model: "a/b",
  operators: [7]
}`;
		const out = patch(text, { model: "a/b" });
		expect(out).toBe(`{
  model: "a/b"
}`);
	});

	test("a sole entry deletes to an empty object", () => {
		const out = patch(`{ model: "a/b" }`, {});
		expect(out).toBe("{ }");
		expect(JSON5.parse(out!)).toEqual({});
	});

	test("keys the schema doesn't own keep their text verbatim", () => {
		const text = `{
  model: "a/b",
  experimental: { future: "field" }, // not in the schema
  thinking: "low",
}`;
		const out = patch(text, { model: "a/b", thinking: "high" });
		expect(out).toContain('experimental: { future: "field" }, // not in the schema');
		expect(out).toContain("thinking: 'high'");
	});

	test("a new merged key appends before the closing brace at file indent", () => {
		const text = `{
	model: "a/b",
	operators: [7],
}`;
		const out = patch(text, {
			model: "a/b",
			operators: [7],
			transcription: { kind: "groq" },
		});
		// Inner lines indent by two spaces on top of the file's own
		// entry indent (tab here) — JSON5.stringify's rhythm inside the
		// file's.
		expect(out).toBe(`{
	model: "a/b",
	operators: [7],
	transcription: {
	  kind: 'groq',
	},
}`);
	});

	test("appending to a comma-less tail adds the missing comma", () => {
		const text = `{
  model: "a/b"
}`;
		const out = patch(text, { model: "a/b", thinking: "low" });
		expect(out).toBe(`{
  model: "a/b",
  thinking: 'low',
}`);
	});

	test("a value hugging the closing brace still gets comma before inserts", () => {
		// last.valueEnd === rootEnd: the tail comma and the insert run
		// splice at the same offset — one edit, comma first, or the
		// patch emits ",\n,}".
		const out = patch(`{model:"a/b"}`, { model: "a/b", thinking: "low" });
		expect(out).toBe(`{model:"a/b",  thinking: 'low',\n}`);
	});

	test("an empty root object gets the whole merged config", () => {
		const out = patch(`{}`, { model: "a/b" });
		expect(out).toBe(`{
  model: 'a/b',
}`);
	});

	test("a changed nested block re-serializes at the entry's indent", () => {
		const text = `{
	model: "a/b",
	// speech
	transcription: { kind: "groq" },
}`;
		const out = patch(text, {
			model: "a/b",
			transcription: { kind: "groq", fallbacks: [{ kind: "whistle" }] },
		});
		expect(out).toBe(`{
	model: "a/b",
	// speech
	transcription: {
	  kind: 'groq',
	  fallbacks: [
	    {
	      kind: 'whistle',
	    },
	  ],
	},
}`);
	});

	test("a sparse block materializes its schema defaults on save", () => {
		// Raw-vs-merged compare: { kind: "groq" } differs from the
		// materialized block → canonical rewrite of that entry only.
		// Untouched lines and the trailing comment keep their bytes.
		const normalize = (raw: unknown) => {
			const r = raw as Record<string, unknown>;
			const t = r.transcription as Record<string, unknown> | undefined;
			return {
				...r,
				...(t !== undefined
					? { transcription: { model: "whisper-large-v3-turbo", auth: "groq", ...t } }
					: {}),
			};
		};
		const text = `{
  model: "a/b",
  transcription: { kind: "groq" }, // sparse — defaults materialize
}`;
		const out = patch(
			text,
			{
				model: "a/b",
				transcription: { kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" },
			},
			normalize,
		);
		expect(out).toBe(`{
  model: "a/b",
  transcription: {
    kind: 'groq',
    model: 'whisper-large-v3-turbo',
    auth: 'groq',
  }, // sparse — defaults materialize
}`);
	});

	test("quoted keys and single-quoted strings scan", () => {
		const text = `{
  'model': 'a/b',
  "operators": [7],
}`;
		const out = patch(text, { model: "x/y", operators: [7] });
		expect(out).toBe(`{
  'model': 'x/y',
  "operators": [7],
}`);
	});

	test("comments inside values don't end the value early", () => {
		const text = `{
  model: "a/b",
  transcription: {
    kind: "groq", // the fast one
    model: "whisper-large-v3-turbo",
  },
}`;
		const out = patch(text, { model: "a/b" });
		expect(out).toBe(`{
  model: "a/b",
}`);
	});

	test("duplicate keys bail — no guessing at which line wins", () => {
		const text = `{ model: "a/b", model: "x/y" }`;
		expect(patch(text, { model: "a/b" })).toBeNull();
	});

	test("a non-object root bails", () => {
		expect(patch(`["a"]`, { model: "a/b" })).toBeNull();
		expect(patch(``, { model: "a/b" })).toBeNull();
	});

	test("the verify backstop: a patch that doesn't re-parse to merged is refused", () => {
		// The post-patch verify returns a different config — the patcher
		// must not ship it.
		const lying = (_raw: unknown) => ({ model: "poisoned" });
		expect(patch(`{ model: "a/b" }`, { model: "a/b" }, lying)).toBeNull();
	});
});
