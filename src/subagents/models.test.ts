import { describe, expect, test } from "bun:test";
import { setLogFile } from "../log.ts";
import { type SubagentModelProfile, subagentModelProfileSchema } from "./models.ts";
import {
	HAIKU_PROFILE,
	haikuConfig,
	open,
	rig,
	servers,
	startFakeModel,
	until,
	WS,
} from "./testing.ts";

setLogFile(null);

describe("explicit model profile", () => {
	test("worker explicit profile: free ID, max_tokens, system role, no store/reasoning fields; settles+wakes", async () => {
		const model = startFakeModel();
		servers.push(model);
		const r = rig({
			model,
			configOverrides: { worker: haikuConfig("worker", model.url) },
			modelProfiles: { worker: HAIKU_PROFILE },
		});
		const o = await open(r);
		r.model.push({ kind: "tools", calls: [{ name: "finish", args: { result: "profile-ok" } }] });
		const row = await o.start({
			kind: "worker",
			conversationId: WS,
			workspace: r.workspace,
			task: "do the thing",
		});
		await until(() => r.runs.get(row.id)?.status === "done", "run done");
		expect(r.wakes.length).toBe(1);
		expect(r.wakes[0]!.text).toContain("profile-ok");
		const raw = r.model.seen[0]!.raw;
		expect(raw.model).toBe("claude-haiku-5.5:free");
		expect(typeof raw.max_tokens).toBe("number");
		expect(raw.max_completion_tokens).toBeUndefined();
		expect(raw.store).toBeUndefined();
		expect(raw.reasoning_effort).toBeUndefined();
		expect(raw.thinking).toBeUndefined();
		const messages = raw.messages as { role: string }[];
		expect(messages[0]!.role).toBe("system");
		expect(messages.some((m) => m.role === "developer")).toBe(false);
	});

	test("computer explicit image profile: screenshot flows to the model as image content", async () => {
		const model = startFakeModel();
		servers.push(model);
		const r = rig({
			model,
			configOverrides: { computer: haikuConfig("computer", model.url) },
			modelProfiles: { computer: HAIKU_PROFILE },
		});
		const o = await open(r);
		await r.desktops.allocate("d1");
		r.model.push({ kind: "tools", calls: [{ name: "screenshot", args: {} }] });
		r.model.push({ kind: "tools", calls: [{ name: "finish", args: { result: "saw it" } }] });
		const a = await o.start({
			kind: "computer",
			conversationId: WS,
			workspace: r.workspace,
			task: "look",
			desktop: "d1",
		});
		await until(() => r.runs.get(a.id)?.status === "done", "done");
		const withImage = r.model.seen.find((s) => JSON.stringify(s.messages).includes("iVBORw=="));
		expect(withImage).toBeDefined();
		expect(JSON.stringify(withImage!.messages)).toContain("image");
	});

	test("explicit text-only computer profile refuses before credentials or model calls", async () => {
		const textOnly = subagentModelProfileSchema.parse({ ...HAIKU_PROFILE, input: ["text"] });
		const r = rig({
			configOverrides: {
				worker: undefined,
				computer: haikuConfig("computer", "http://127.0.0.1:1"),
			},
			modelProfiles: { computer: textOnly },
		});
		await expect(open(r)).rejects.toThrow("input modality");
		expect(r.authCalls).toBe(0);
		expect(r.model.seen.length).toBe(0);
	});

	test("profile/config id mismatch refuses", async () => {
		const wrong = subagentModelProfileSchema.parse({ ...HAIKU_PROFILE, id: "other-model" });
		const r = rig({
			configOverrides: { worker: haikuConfig("worker", "http://127.0.0.1:1") },
			modelProfiles: { worker: wrong },
		});
		await expect(open(r)).rejects.toThrow("does not match");
		expect(r.authCalls).toBe(0);
	});

	test("schema alone rejects inverted/zero bounds", () => {
		expect(
			subagentModelProfileSchema.safeParse({ ...HAIKU_PROFILE, maxTokens: 1_000_001 }).success,
		).toBe(false);
		expect(
			subagentModelProfileSchema.safeParse({ ...HAIKU_PROFILE, contextWindow: 0 }).success,
		).toBe(false);
		expect(subagentModelProfileSchema.safeParse({ ...HAIKU_PROFILE, maxTokens: 0 }).success).toBe(
			false,
		);
	});

	test("malformed profile (maxTokens > contextWindow) refuses without echoing input", async () => {
		const bad = { ...HAIKU_PROFILE, maxTokens: 2_000_000, marker: "sentinel-value" };
		const r = rig({
			configOverrides: { worker: haikuConfig("worker", "http://127.0.0.1:1") },
			modelProfiles: { worker: bad as SubagentModelProfile },
		});
		const err = await open(r).catch((e: unknown) => e);
		expect(String(err)).toContain("schema validation");
		expect(String(err)).not.toContain("sentinel-value");
		expect(r.authCalls).toBe(0);
	});

	test("explicit profile with configured thinking != off refuses", async () => {
		const cfg = haikuConfig("worker", "http://127.0.0.1:1")!;
		cfg.model.thinking = "low";
		const r = rig({
			configOverrides: { worker: cfg },
			modelProfiles: { worker: HAIKU_PROFILE },
		});
		await expect(open(r)).rejects.toThrow('thinking "off"');
		expect(r.authCalls).toBe(0);
	});

	test("unknown configured id without a profile still refuses", async () => {
		const cfg = haikuConfig("worker", "http://127.0.0.1:1")!;
		cfg.model.id = "mystery-model";
		const r = rig({ configOverrides: { worker: cfg } });
		await expect(open(r)).rejects.toThrow("no alternate subagent models");
		expect(r.authCalls).toBe(0);
	});

	test("no-profile GLM request shape is unchanged", async () => {
		const r = rig();
		const o = await open(r);
		r.model.push({ kind: "tools", calls: [{ name: "finish", args: { result: "glm" } }] });
		const row = await o.start({
			kind: "worker",
			conversationId: WS,
			workspace: r.workspace,
			task: "t",
		});
		await until(() => r.runs.get(row.id)?.status === "done", "done");
		expect(r.model.seen[0]!.raw.model).toBe("glm-5.3");
	});
});
