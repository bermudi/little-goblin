import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentChildren } from "../agent-children.ts";
import type { Config } from "../config-schema.ts";
import type { AuthStore } from "../auth.ts";
import type { Conversation } from "../conversation-read.ts";
import type { JSONObject, Message } from "../message.ts";
import { declarationsOf, TOOLS_PART } from "./tool-declarations.ts";
import { openStore, type ConversationStore } from "../conversation.ts";
import { persistableToolSet } from "../turn/ai-sdk-tools.ts";
import { readFileTool } from "./tools/read.ts";
import { writeFileTool } from "./tools/write.ts";
import { editFileTool } from "./tools/edit.ts";
import type { VisionToolDeps } from "./tools/vision.ts";
import { NOTE_HISTORY_SOURCE, noteTool } from "./tools/note.ts";
import type { Desktops } from "../desktops.ts";
import type { T3, T3Thread } from "../t3.ts";
import type { GitHub } from "../github.ts";
import type { Watches } from "../watches.ts";
import { log, setLogFile, setLogWriter } from "../log.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { ProgramApproval } from "../program-approval.ts";
import type { NoteStore } from "../notes.ts";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { openProjects, type ProjectStore } from "../projects.ts";
import { FencedError, Runtime, userMessage } from "../runtime.ts";

import { openTurnJournal } from "../turn-journal.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openWakeStore } from "../wake-store.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { claudeScript } from "../testkit/turn-script-claude.ts";
import type { ScriptCall } from "../testkit/turn-script.ts";
import { deferred, HeadlessSink, openTestStore, tmpDir, useHome, waitUntil } from "../testkit.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "../wake-dispatcher.ts";
import { makeTurnTools, screenshotCapable } from "./turn-tools.ts";
import type { DelegateToolDeps } from "./tools/delegate.ts";
import {
	_primeModelsDevForTest,
	_resetModelsDevForTest,
} from "./models-dev.ts";
import { policyOf } from "./tool-policy.ts";
import { storeFence } from "../testkit/store-fence.ts";
import { paths } from "../home-layout.ts";
import { systemPromptFor } from "./prompt.ts";
import { isHosted, type Tools } from "../tool.ts";

setLogFile(null);

const toolCall = (toolCallId: string, toolName: string, input: JSONObject) => ({
	type: "tool-call" as const,
	toolCallId,
	toolName,
	input,
});
const reply = (text: string): ScriptCall => ({ kind: "reply", parts: [{ type: "text", text }] });
const toolReply = (...parts: ReturnType<typeof toolCall>[]): ScriptCall => ({
	kind: "reply",
	parts,
});
const adapters = [sdkScript, claudeScript] as const;
const engineName = (make: (typeof adapters)[number]) =>
	make === sdkScript ? "ai-sdk" : "claude-code";

/** The rig's t3 adapter: lists `agents`, succeeds sends, records them. */
function fakeT3(agents: () => T3Thread[]) {
	const sends: { thread: string; message: string }[] = [];
	const t3: T3 = {
		startThread: () => Promise.reject(new Error("not used here")),
		sendThread: async (thread, message) => {
			sends.push({ thread, message });
			return {
				threadId: thread,
				link: "https://t3.example/t/sent",
				messageId: "m-9",
				runId: "run:2",
				status: "queued",
				delivery: "queued",
			};
		},
		showThread: () => Promise.reject(new Error("not used here")),
		listThreads: async () => agents(),
	};
	return { t3, sends };
}

describe("hosted web_search mount", () => {
	const cfgFor = (webSearch: "off" | "cached" | "live") =>
		({
			providers: {
				codex: { kind: "codex", webSearch },
				zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/x", auth: "zai" },
			},
			search: [{ kind: "ddg" }],
		}) as unknown as Config;

	const rigTools = (
		config: Config,
		conv: Conversation,
		snapshot: ReturnType<ConversationStore["promptSnapshot"]> = null,
		noteSkillWrite?: (conversationId: string, skill: string) => void,
		options?: { store: ConversationStore; vision: VisionToolDeps },
	) =>
		makeTurnTools({
			configRef: { current: config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: options?.store ??
				{ promptSnapshot: () => snapshot, lastTurnTools: () => null } as unknown as ConversationStore,
			projects: { get: () => ({ dir: tmpDir("goblin-turn-tools-project-") }) } as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: fakeT3(() => []).t3,
			now: () => new Date(0),
			watches: {} as unknown as Watches,
			posts: { add: () => { throw new Error("unused"); } },
			asks: { open: () => ({ error: "unused" }), listOpen: () => [], close: () => "missing" },
			github: {} as unknown as GitHub,
			mail: ({}) as never,
			programApproval: ({}) as Pick<ProgramApproval, "requestApproval">,
			visionDepsFor: () => options?.vision,
			sandboxes: {} as unknown as Sandboxes,
			desktops: null,
			agents: null,
			filterGuests: (_c, t) => t,
			...(noteSkillWrite !== undefined ? { noteSkillWrite } : {}),
		});

	const conv = (model: string) =>
		({ id: "dm:1", model, projectId: null, persona: "operator", agentType: null }) as unknown as Conversation;

	test("bash-only rollout keeps the full-tool request bytes until a prompt reset", async () => {
		useHome("goblin-frozen-file-tools-");
		const workspace = paths.workspace();
		mkdirSync(workspace, { recursive: true });
		const { store } = openTestStore("goblin-frozen-file-tools-");
		const conversation = store.resolve({ kind: "dm", chatId: 1 }, workspace);
		const model = "zai/glm-5.3";
		const target = { ...conversation, model };
		const config = { ...cfgFor("off"), scripting: { maxCalls: 50 } };
		const skillWrites: [string, string][] = [];
		const mount = rigTools(config, target, null, (id, name) => skillWrites.push([id, name]), {
			store,
			vision: { configRef: { current: config, ttsDown: false }, auth: {} as AuthStore, conversation: target.id },
		});
		const descriptions = {
			bash: "Run a shell command in the deployment workspace — the fixed working directory shared by every conversation. Use `cd` inside the command to work elsewhere. Returns combined stdout/stderr and the exit code. For dependency health checks, run `../doctor --json`; diagnosis does not authorize repairs or restarts.",
			fetch: "Fetch one URL and return readable text (head+tail window of ~15k chars by default; overflow is saved to disk and the footer names the read_file call to page through). Handles HTML, text-ish payloads, and PDFs — a PDF is saved and answered with its saved-file path. JavaScript-heavy sites that render nothing should go through the browser skill instead.",
			vision: "Ask a vision model a specific question about an image file and get a text answer. This is the only way to see an image's content — read_file cannot show images. Ask targeted questions ('what error does the dialog show?', 'which element is highlighted?'), and pass followUp=true to continue the previous thread about the same image.",
		};
		const old: Tools = {
			read_file: readFileTool(workspace, true),
			write_file: writeFileTool(workspace),
			edit_file: editFileTool(workspace),
			...mount(target),
		};
		for (const [name, description] of Object.entries(descriptions)) {
			const tool = old[name];
			if (tool === undefined || isHosted(tool)) throw new Error(`missing ${name}`);
			old[name] = { ...tool, description };
		}
		const scriptTool = old.script;
		if (scriptTool === undefined || isHosted(scriptTool)) throw new Error("missing script");
		scriptTool.description = scriptTool.description.replace(
			"- Callable: tools.bash",
			"- Callable: tools.read_file, tools.write_file, tools.edit_file, tools.bash",
		);
		const script = sdkScript({ label: model });
		const runtime = new Runtime({
			store,
			engines: script.engines,
			captureConversation: (c) => ({ ...c, model }),
			buildStep: (c, tools) => ({
				...script.step(),
				system: systemPromptFor({
					promptSnapshot: store.promptSnapshot,
					savePromptSnapshot: (id, text, sources) =>
						store.savePromptSnapshot(id, text, [...sources, NOTE_HISTORY_SOURCE]),
				}, c, Object.keys(tools)).text,
			}),
		});
		let beforeRollout = true;
		runtime.mount({ makeTools: (c, ...args) => beforeRollout ? old : mount(c, ...args) });
		const send = async (text: string) => {
			const sink = new HeadlessSink();
			runtime.submit(target, userMessage([{ type: "text", text }]), sink);
			await waitUntil(() => !runtime.busy(target.id), `${text} drains`);
		};
		const request = (index: number) =>
			JSON.parse(script.callOptions()[index]!) as { prompt: unknown[]; tools: { name: string }[] };
		try {
			const path = "skills-proposed/demo/frozen.txt";
			script.script(
				reply("before"),
				toolReply(toolCall("write", "write_file", { path, content: "before\n" })),
				toolReply(toolCall("edit", "edit_file", { path, old_string: "before", new_string: "after" })),
				toolReply(toolCall("read", "read_file", { path })),
				reply("continued"),
				reply("reset"),
			);
			await send("first turn");
			expect(request(0).tools.slice(0, 4).map((tool) => tool.name)).toEqual([
				"read_file", "write_file", "edit_file", "bash",
			]);
			beforeRollout = false;
			await send("ordinary continuation");
			expect(JSON.stringify(request(1).tools)).toBe(JSON.stringify(request(0).tools));
			expect(request(1).prompt.slice(0, request(0).prompt.length)).toEqual(request(0).prompt);
			expect(readFileSync(join(workspace, path), "utf8")).toBe("after\n");
			expect(JSON.stringify(request(4).prompt)).toContain("1\\tafter\\n");
			expect(skillWrites).toEqual([[target.id, "demo"], [target.id, "demo"]]);

			store.clearPromptSnapshot(target.id);
			await send("after prompt reset");
			for (const name of ["read_file", "write_file", "edit_file"]) {
				expect(request(5).tools.map((tool) => tool.name)).not.toContain(name);
			}
			expect(request(5).tools[0]?.name).toBe("bash");
			expect(JSON.stringify(request(5).tools)).toContain("It is also the file tool");
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("fresh and already bash-only full-tool conversations stay bash-only", async () => {
		useHome("goblin-bash-only-file-tools-");
		const { store } = openTestStore("goblin-bash-only-file-tools-");
		try {
			const target = {
				...store.resolve({ kind: "dm", chatId: 1 }, paths.workspace()),
				model: "zai/glm-5.3",
			};
			const config = cfgFor("off");
			const mount = rigTools(config, target, null, undefined, {
				store,
				vision: { configRef: { current: config, ttsDown: false }, auth: {} as AuthStore, conversation: target.id },
			});
			const fresh = mount(target);
			expect(Object.keys(fresh)[0]).toBe("bash");
			for (const name of ["read_file", "write_file", "edit_file"]) {
				expect(Object.keys(fresh)).not.toContain(name);
			}
			const persisted = await persistableToolSet(fresh);
			if ("unpersistable" in persisted) throw new Error("expected persistable tools");
			store.saveLastTurnTools(target.id, target.epoch, persisted.json);
			store.savePromptSnapshot(target.id, "frozen", [NOTE_HISTORY_SOURCE]);
			expect(JSON.stringify(declarationsOf(mount(target)))).toBe(JSON.stringify(declarationsOf(fresh)));
		} finally {
			store.close();
		}
	});

	test("note edit history keeps the legacy declaration on frozen full-tool requests", () => {
		const existing = { text: "frozen", sources: ["SOUL.md"] };
		const config = cfgFor("off");
		const nonAppendRoute = conv("zai/glm-5.3");
		const codex = conv("codex/gpt-6.1-sol");
		const declaration = (conversation: Conversation, snapshot: typeof existing | null) =>
			declarationsOf(rigTools(config, conversation, snapshot)(conversation))
				.find((tool) => tool.name === "note");
		const legacy = declarationsOf({ note: noteTool({
			notes: {} as NoteStore, projects: { get: () => null }, conversation: "dm:1", projectId: null,
		}) })[0];
		expect(declaration(nonAppendRoute, existing)).toEqual(legacy);
		const current = declaration(nonAppendRoute, null);
		expect(current).toBeDefined();
		expect(current).not.toEqual(legacy);
		expect(declaration(nonAppendRoute, { ...existing, sources: [NOTE_HISTORY_SOURCE] })).toEqual(current);
		expect(declaration(codex, existing)).toEqual(current);
	});

	test("codex+live/cached mounts web_search, search absent; off and non-codex keep local search", () => {
		for (const mode of ["live", "cached"] as const) {
			const t = rigTools(cfgFor(mode), conv("codex/gpt-6.1-sol"))(conv("codex/gpt-6.1-sol"));
			expect("web_search" in t).toBe(true);
			expect("search" in t).toBe(false);
		}
		const off = rigTools(cfgFor("off"), conv("codex/gpt-6.1-sol"))(conv("codex/gpt-6.1-sol"));
		expect("web_search" in off).toBe(false);
		expect("search" in off).toBe(true);
		const other = rigTools(cfgFor("live"), conv("zai/glm-5.3"))(conv("zai/glm-5.3"));
		expect("web_search" in other).toBe(false);
		expect("search" in other).toBe(true);
	});

	test("bash skill writes retain the conversation id", async () => {
		useHome("goblin-skill-write-");
		const writes: [string, string][] = [];
		mkdirSync(join(paths.skills(), "demo"), { recursive: true });
		writeFileSync(join(paths.skills(), "demo", "SKILL.md"), "x\n");
		const convValue = conv("codex/gpt-6.1-sol");
		const tools = rigTools(cfgFor("off"), convValue, null, (conversationId, skill) =>
			writes.push([conversationId, skill]),
		)(convValue);
		const bash = tools.bash;
		if (bash === undefined || !("execute" in bash)) throw new Error("Expected bash");
		await bash.execute(
			{ command: `echo y >> ${paths.skills()}/demo/SKILL.md && mkdir -p ${paths.skillsProposed()}/draft && echo d > ${paths.skillsProposed()}/draft/SKILL.md` },
			{ toolCallId: "skill-write" },
		);
		expect(writes).toEqual([[convValue.id, "demo"], [convValue.id, "draft"]]);
	});

	test("default Codex declarations fit in a stored part and test conversation", () => {
		useHome("goblin-default-tool-stamp-size-");
		const conversation = conv("codex/gpt-6.1-sol");
		const tools = rigTools(cfgFor("off"), conversation)(conversation);
		const dataPart = {
			type: TOOLS_PART,
			data: { added: declarationsOf(tools), removed: [] },
		};
		const message: Message = {
			id: "assistant-tool-stamp",
			role: "assistant",
			parts: [dataPart as Message["parts"][number], { type: "text", text: "ready" }],
		};
		const sizeBytes = Buffer.byteLength(JSON.stringify(dataPart));
		expect(message.parts[0]?.type).toBe(TOOLS_PART);
		expect(sizeBytes).toBeGreaterThan(0);
		log.info("default Codex tool part size", {
			bytes: sizeBytes,
			tools: declarationsOf(tools).length,
			message: message.id,
		});
	});

	test("the watch tool mounts in a Telegram conversation and in a project conversation", () => {
		const config = cfgFor("off");
		const telegram = conv("zai/glm-5");
		const project = {
			id: "app:p1",
			model: "zai/glm-5",
			projectId: "p1",
			persona: "operator",
			agentType: null,
		} as unknown as Conversation;
		expect("watch" in rigTools(config, telegram)(telegram)).toBe(true);
		expect("watch" in rigTools(config, project)(project)).toBe(true);
	});

	test("the post tool mounts for the operator and stays off guest turns", () => {
		const config = cfgFor("off");
		const telegram = conv("zai/glm-5");
		expect("post" in rigTools(config, telegram)(telegram)).toBe(true);
		expect(policyOf("post")).toMatchObject({ guestChannel: false, guestSandbox: false, replay: "unsafe" });
	});

	test("ask mounts only on app parent turns", () => {
		const config = cfgFor("off");
		const app = { ...conv("zai/glm-5"), id: "app/parent" } as Conversation;
		const telegram = conv("zai/glm-5");
		expect("ask" in rigTools(config, app)(app)).toBe(true);
		expect("ask" in rigTools(config, telegram)(telegram)).toBe(false);
		expect(policyOf("ask")).toMatchObject({ guestChannel: false });
	});

	test("guests keep web_search exactly like local search", () => {
		expect(policyOf("web_search").guestSandbox).toBe(true);
		expect(policyOf("search").guestSandbox).toBe(true);
	});
});

describe("agent tool mount", () => {
	const parentConv = {
		id: "dm:1",
		model: null,
		projectId: null,
		persona: "operator",
		agentType: null,
	} as unknown as Conversation;
	const childConv = {
		id: "app/agent-1",
		model: "a/b",
		projectId: null,
		persona: "operator",
		agentType: "general",
	} as unknown as Conversation;

	const rigTools = (engine: AgentChildren | null) =>
		makeTurnTools({
			configRef: { current: {} as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: { promptSnapshot: () => null } as unknown as ConversationStore,
			projects: {} as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: {} as unknown as T3,
			now: () => new Date(0),
			watches: {} as unknown as Watches,
			posts: { add: () => { throw new Error("unused"); } },
			asks: { open: () => ({ error: "unused" }), listOpen: () => [], close: () => "missing" },
			github: {} as unknown as GitHub,
			mail: ({}) as never,
			programApproval: ({}) as Pick<ProgramApproval, "requestApproval">,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: null,
			agents: engine,
			filterGuests: (_c, t) => t,
		});

	test("no engine: the agent tool never mounts", () => {
		expect("agent" in rigTools(null)(parentConv)).toBe(false);
	});

	test("a parent turn mounts the agent tool listing the types", () => {
		const tools = rigTools({} as unknown as AgentChildren)(parentConv);
		expect("agent" in tools).toBe(true);
		const tool = "agent" in tools ? tools.agent : undefined;
		expect(tool && "description" in tool && tool.description).toContain("- general:");
	});

	test("a child turn gets only its spawn-time allowlist — never agent itself", () => {
		const engine = {
			allowlistFor: (id: string) => (id === "app/agent-1" ? ["read_file", "bash"] : null),
			desktopFor: () => null,
		} as unknown as AgentChildren;
		const tools = rigTools(engine)(childConv);
		const names = Object.keys(tools);
		expect(names).not.toContain("read_file");
		expect(names).toContain("bash");
		for (const banned of ["agent", "delegate", "speak", "memory_search", "note", "ui", "ask"]) {
			expect(names).not.toContain(banned);
		}
	});

	test("a child with no registry row fails loud", () => {
		const engine = { allowlistFor: () => null, desktopFor: () => null } as unknown as AgentChildren;
		expect(() => rigTools(engine)(childConv)).toThrow(/no registry row/);
	});
});

describe("computer child mount", () => {
	const computerConv = {
		id: "app/agent-2",
		model: "a/b",
		projectId: null,
		persona: "operator",
		agentType: "computer",
	} as unknown as Conversation;
	const parentConv = {
		id: "dm:1",
		model: null,
		projectId: null,
		persona: "operator",
		agentType: null,
	} as unknown as Conversation;
	const desktopsStub = {} as unknown as Desktops;

	const rigTools = (engine: AgentChildren | null, desktops: Desktops | null) =>
		makeTurnTools({
			// providers:{} — the model's provider is unconfigured, so the
			// screenshot capability gate fails closed (issue #606).
			configRef: { current: { providers: {} } as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: { promptSnapshot: () => null } as unknown as ConversationStore,
			projects: {} as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: {} as unknown as T3,
			now: () => new Date(0),
			watches: {} as unknown as Watches,
			posts: { add: () => { throw new Error("unused"); } },
			asks: { open: () => ({ error: "unused" }), listOpen: () => [], close: () => "missing" },
			github: {} as unknown as GitHub,
			mail: ({}) as never,
			programApproval: ({}) as Pick<ProgramApproval, "requestApproval">,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops,
			agents: engine,
			filterGuests: (_c, t) => t,
		});

	const computerEngine = (desktop: string | null) =>
		({
			// The real computer type's allowlist now names screenshot;
			// the capability gate — not the allowlist — decides mounting.
			allowlistFor: (id: string) =>
				id === "app/agent-2"
					? ["inspect", "act", "launch", "screenshot", "ask_operator"]
					: null,
			desktopFor: (id: string) => (id === "app/agent-2" ? desktop : null),
		}) as unknown as AgentChildren;

	test("a computer child mounts the desktop tools and ask_operator — never agent or desktop", () => {
		const tools = rigTools(computerEngine("desk"), desktopsStub)(computerConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch", "ask_operator"]) {
			expect(names).toContain(name);
		}
		// Allowlisted but gate-blocked: no configured provider carries
		// image tool results for this model, so screenshot stays absent.
		expect(names).not.toContain("screenshot");
		for (const banned of ["agent", "delegate", "desktop", "subagent", "speak", "ui"]) {
			expect(names).not.toContain(banned);
		}
	});

	test("a parent turn never mounts the computer tools", () => {
		const tools = rigTools(computerEngine("desk"), desktopsStub)(parentConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch", "ask_operator"]) {
			expect(names).not.toContain(name);
		}
		expect(names).toContain("agent");
	});

	test("a computer child with no bound desktop mounts none of them", () => {
		const tools = rigTools(computerEngine(null), desktopsStub)(computerConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch"]) {
			expect(names).not.toContain(name);
		}
		// ask_operator is not desktop-bound — it still mounts.
		expect(names).toContain("ask_operator");
	});
});

describe("screenshotCapable — issue #606 mount gate", () => {
	// The tool mounts only when the model takes image input AND the
	// provider pipe carries image tool results. Either failure means the
	// tool is absent, never erroring. The catalog and config share the
	// provider names the model refs use.
	const conv = (model: string | null) => ({ model }) as Conversation;
	const cfg = {
		providers: {
			or: { kind: "openrouter", auth: "x" },
			oai: { kind: "openai-compatible", baseUrl: "https://x.test", auth: "x" },
			cx: { kind: "codex" },
			cc: { kind: "claude-code", auth: "x" },
		},
	} as unknown as Config;
	const models = (input: string[]) => ({ modalities: { input } });
	const primeAll = () =>
		_primeModelsDevForTest({
			or: { models: { seer: models(["text", "image"]), blind: models(["text"]) } },
			oai: { models: { seer: models(["text", "image"]) } },
			cx: { models: { seer: models(["text", "image"]) } },
			cc: { models: { seer: models(["text", "image"]) } },
		});

	test("image model + image-capable pipe mounts; every other combo does not", () => {
		try {
			primeAll();
			expect(screenshotCapable(conv("or/seer"), cfg)).toBe(true);
			expect(screenshotCapable(conv("cc/seer"), cfg)).toBe(true);
			// openai-compatible stringifies tool results — never.
			expect(screenshotCapable(conv("oai/seer"), cfg)).toBe(false);
			// codex runs the stock Responses model — tool results carry images (#731).
			expect(screenshotCapable(conv("cx/seer"), cfg)).toBe(true);
			// Text-only model — never, even on a carrying pipe.
			expect(screenshotCapable(conv("or/blind"), cfg)).toBe(false);
			// No model, unknown provider, unknown model — never.
			expect(screenshotCapable(conv(null), cfg)).toBe(false);
			expect(screenshotCapable(conv("ghost/seer"), cfg)).toBe(false);
			expect(screenshotCapable(conv("or/ghost"), cfg)).toBe(false);
		} finally {
			_resetModelsDevForTest();
		}
	});

	test("a cold catalog is conservative: the tool stays absent", () => {
		_resetModelsDevForTest();
		expect(screenshotCapable(conv("or/seer"), cfg)).toBe(false);
	});
});
