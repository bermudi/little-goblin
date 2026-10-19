import { asSchema, jsonSchema, tool } from "ai";
import { log } from "../../log.ts";
import { normalizeUiInput, uiInputSchema, type UiInput } from "./ui-schema.ts";

export const uiTool = () =>
	tool({
		description:
			'Show the operator an interface instead of prose, rendered inline in the goblin app. Plain text is the default — most answers should not use this. Reach for it when layout carries meaning: options compared side by side (columns), a process or plan in order (steps), numbers worth seeing at a glance (stats, chart, table), a topic with separable parts (tabs), a decision the operator makes with a tap (choices) or details to fill in (form). Use html only when the answer needs live computation or interaction the other blocks cannot express — a calculator, a bill splitter, a small game: one self-contained document, inline script and style, no network, no external assets. Keep surrounding text short and never repeat in prose what the interface shows. Choices and form submits come back as a user message starting with [ui]. Every block object must include its "type" field — write it first.',
		inputSchema: jsonSchema<UiInput>(asSchema(uiInputSchema).jsonSchema, {
			validate: (value) => {
				const repaired = normalizeUiInput(value);
				const parsed = uiInputSchema.safeParse(repaired.value);
				if (!parsed.success) {
					log.warn("ui input invalid", {
						issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
						inferred: repaired.inferred,
						dropped: repaired.dropped,
					});
					return { success: false, error: parsed.error };
				}
				if (repaired.inferred.length > 0 || repaired.dropped > 0) {
					log.info("ui input repaired", {
						inferred: repaired.inferred,
						dropped: repaired.dropped,
					});
				}
				return { success: true, value: parsed.data };
			},
		}),
		execute: async (input) => {
			const leaves = input.blocks.flatMap((b) =>
				b.type === "tabs"
					? b.tabs.flatMap((t) => t.blocks)
					: b.type === "columns"
						? b.columns.flatMap((c) => c.blocks)
						: [b],
			);
			const htmlBytes = leaves
				.filter((l) => l.type === "html")
				.reduce((n, l) => n + Buffer.byteLength(l.html), 0);
			log.info("ui shown", {
				blocks: input.blocks.length,
				kinds: input.blocks.map((b) => b.type),
				...(htmlBytes > 0 ? { htmlBytes } : {}),
			});
			return "shown";
		},
	});
