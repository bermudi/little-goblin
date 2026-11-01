import { describe, expect, test } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import { estimateHistoryChars, MEDIA_ESTIMATE_CHARS } from "./itemize.ts";
import { buildModelView, type ViewContext } from "./view.ts";

describe("media cost in pre-emption estimate", () => {
	test("a large inlined image costs a fixed amount, not its base64 length", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [{ type: "image", image: "A".repeat(400_000), mediaType: "image/jpeg" }],
			},
		];
		expect(estimateHistoryChars(messages)).toBe(MEDIA_ESTIMATE_CHARS);
	});
});

describe("provider-executed parts", () => {
	const history: UIMessage = {
		id: "a1",
		role: "assistant",
		parts: [
			{
				type: "dynamic-tool",
				toolName: "web_search",
				toolCallId: "ws_1",
				state: "output-available",
				input: {},
				output: "r",
				providerExecuted: true,
			},
			{ type: "text", text: "found it" },
		],
	};
	const run = (keep: boolean) => {
		const ctx: ViewContext = {
			convId: "c",
			tools: {},
			modalities: undefined,
			carries: () => true,
			keepProviderExecuted: keep,
			skillRef: (r) => ({ name: String(r), body: null }),
		};
		return buildModelView(ctx, {
			entries: [{ seq: 1, message: history }],
			prior: [],
			current: null,
			partial: null,
			assertAuthority: () => {},
		});
	};
	test("dropped when the provider does not replay them", async () => {
		const out = JSON.stringify(await run(false));
		expect(out).not.toContain("ws_1");
		expect(out).toContain("found it");
	});
	test("kept for the provider that does", async () => {
		expect(JSON.stringify(await run(true))).toContain("ws_1");
	});
});
