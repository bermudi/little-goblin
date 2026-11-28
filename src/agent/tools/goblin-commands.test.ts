import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config-schema.ts";
import type { AuthStore } from "../../auth.ts";
import type { Conversation } from "../../conversation-read.ts";
import { openStore } from "../../conversation.ts";
import { openNotes } from "../../notes.ts";
import { openProjects } from "../../projects.ts";
import type { Watches } from "../../watches.ts";
import type { T3 } from "../../t3.ts";
import type { GitHub } from "../../github.ts";
import type { MailApproval } from "../../mail-approval.ts";
import type { ProgramApproval } from "../../program-approval.ts";
import type { Sandboxes } from "../../sandboxes.ts";
import type { Asks } from "../../asks.ts";
import type { HindsightClient } from "../../memory/hindsight.ts";
import { useHome } from "../../testkit.ts";
import { fenceTools } from "../../turn/tool-fence.ts";
import { makeTurnTools } from "../turn-tools.ts";
import { TOOL_NAMES, policyOf } from "../tool-policy.ts";
import type { ProgramsStore } from "../../programs.ts";

const commandNames: string[] = TOOL_NAMES.filter((name) => policyOf(name).command);
const flagsByTool: Record<string, string> = {
	program: "--name",
	send_file: "--path",
	history_search: "--query",
	memory_search: "--query",
	memory_reflect: "--query",
	note: "--title",
	watch: "--thread",
	mail: "--to",
	transcribe: "--path",
	speak: "--text",
	post: "--text",
};
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

describe("assembled Goblin commands at the bash boundary", () => {
	test("all mounted command tools show schema help and dispatch representative inputs", async () => {
		const home = useHome("goblin-commands-assembled-");
		const state = join(home, "state");
		const cwd = join(home, "workspace");
		mkdirSync(state, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "clip.wav"), "audio");
		writeFileSync(join(cwd, "out.txt"), "file");
		const store = openStore(join(state, "goblin.sqlite"));
		const projects = openProjects(store);
		const notes = openNotes(store, { projects });
		const received: Record<string, unknown> = {};
		const configRef = {
			current: {
				commands: {},
				mail: {},
				transcription: {},
				search: [{ kind: "ddg" }],
				memory: {
					searchMaxTokens: 256,
					searchBudget: "low",
					searchTimeoutMs: 1000,
					searchMinScores: {},
					preferObservations: true,
					reflectMaxTokens: 256,
					reflectBudget: "low",
					reflectTimeoutMs: 1000,
				},
				tts: { kind: "edge", voice: "en-US-AriaNeural", voices: [] },
			} as unknown as Config,
			ttsDown: false,
		};
		const fakeMemory = {
			recall: async (query: string) => {
				received.memory_search = { query };
				return [];
			},
			reflect: async (query: string) => {
				received.memory_reflect = { query };
				return {
					text: "A harmless synthesis.",
					based_on: { memories: [], mental_models: [], directives: [] },
				};
			},
		} as unknown as HindsightClient;
		const fakePrograms = {
			list: () => {
				received.program = { action: "list" };
				return [];
			},
			proposals: { pending: () => [] },
		} as unknown as ProgramsStore;
		const fakeWatches = {
			forConversation: () => {
				received.watch = { action: "list" };
				return [];
			},
		} as unknown as Watches;
		const conv = {
			id: "app/commands-test",
			model: "openai-compatible/test",
			projectId: null,
			persona: "operator",
			agentType: null,
			memoryExcluded: false,
		} as unknown as Conversation;
		const tools = makeTurnTools({
			now: () => new Date(0),
			configRef,
			auth: {} as unknown as AuthStore,
			store: {
				...store,
				promptSnapshot: () => null,
				searchHistory: (query: string) => {
					received.history_search = { query };
					return [];
				},
				get: (id: string) => store.get(id),
				bots: { membership: () => null },
			} as never,
			projects: {
				get: () => ({ dir: cwd }),
			} as never,
			notes,
			programs: fakePrograms,
			memory: {
				client: fakeMemory,
				config: configRef.current.memory!,
				noteRecall: () => {},
			} as never,
			transcribe: async (file) => {
				received.transcribe = { path: file.path };
				return "transcript";
			},
			delegateDeps: () => undefined,
			mail: {
				requestDraft: async (input: unknown) => {
					received.mail = input;
					return { queued: 1, status: "awaiting approval" };
				},
			} as unknown as Pick<MailApproval, "requestDraft">,
			programApproval: {
				requestApproval: async () => {},
			} as Pick<ProgramApproval, "requestApproval">,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: null,
			t3: {
				showThread: async () => null,
			} as unknown as T3,
			watches: fakeWatches,
			posts: {
				add: (input: { conversationId: string; text: string }) => {
					received.post = input;
					return { id: "post-1", createdAt: "2026-01-01T00:00:00.000Z" };
				},
			} as never,
			asks: {} as unknown as Pick<Asks, "open" | "listOpen" | "close">,
			github: {} as unknown as GitHub,
			agents: null,
			filterGuests: (_conversation, assembled) => assembled,
		});
		const raw = tools(conv, async () => { received.speak = true; }, undefined, async (file) => {
			received.send_file = file;
		});
		const mounted = Object.keys(raw).filter((name) => policyOf(name).command);
		expect(mounted).toEqual(commandNames);
		const speak = raw.speak;
		if (speak === undefined || "hosted" in speak) throw new Error("speak did not mount");
		raw.speak = {
			...speak,
			execute: async (input: unknown) => {
				received.speak = input;
				return { sent: 1 };
			},
		};
		const fenced = fenceTools({
			tools: raw,
			convId: conv.id,
			epoch: 1,
			journal: undefined,
			checkAuthority: () => {},
		});
		const bash = fenced.bash;
		if (bash === undefined || "hosted" in bash) throw new Error("bash did not mount");
		const run = async (command: string): Promise<Record<string, unknown>> =>
			await bash.execute(
				{ command },
				{ toolCallId: `commands-${Math.random()}`, messages: [], context: {} } as never,
			) as Record<string, unknown>;
		try {
			const allHelp = await run("goblin --help");
			expect(allHelp.exit_code).toBe(0);
			const helpText = String(allHelp.output);
			for (const name of commandNames) {
				expect(helpText).toContain(`Usage: goblin ${name}`);
				const flag = flagsByTool[name];
				if (flag === undefined) throw new Error(`no expected help flag for ${name}`);
				expect(helpText).toContain(flag);
			}
			expect((await run("goblin fetch --url https://example.com")).output).toContain("fetch is not available");

			const cases = [
				["program", "goblin program list"],
				["send_file", "goblin send_file --path out.txt"],
				["history_search", "goblin history_search search --query handoff"],
				["memory_search", "goblin memory_search --query preferences"],
				["memory_reflect", "goblin memory_reflect --query patterns"],
				["note", "goblin note create --title CLI --body from-command --what 'Create note' --reason 'command boundary test'"],
				["watch", "goblin watch list"],
				["mail", `goblin mail send --json ${quote(JSON.stringify({ to: ["alex@example.com"], subject: "Late", body: "I will be late." }))}`],
				["transcribe", "goblin transcribe --path clip.wav"],
				["speak", "goblin speak --text Hello"],
				["post", "goblin post --text 'A short update'"],
			] as const;
			for (const [name, command] of cases) {
				const expectedFlag = flagsByTool[name];
				if (expectedFlag === undefined) throw new Error(`no expected help flag for ${name}`);
				const help = await run(`goblin ${name} --help`);
				expect(help.exit_code, `${name} help`).toBe(0);
				expect(String(help.output), `${name} help flag`).toContain(expectedFlag);
				const result = await run(command);
				expect(result.exit_code, `${name} call: ${String(result.output)}`).toBe(0);
			}
			expect(received).toMatchObject({
				program: { action: "list" },
				send_file: { filename: "out.txt" },
				history_search: { query: "handoff" },
				memory_search: { query: "preferences" },
				memory_reflect: { query: "patterns" },
				watch: { action: "list" },
				mail: { to: ["alex@example.com"], subject: "Late", body: "I will be late." },
				transcribe: { path: join(cwd, "clip.wav") },
				speak: { text: "Hello" },
				post: { conversationId: conv.id, text: "A short update" },
			});
			const repeated = await run("goblin mail send --to alex@example.com --to '[\"sam@example.com\"]' --subject Late --body 'I will be late.'");
			expect(repeated.exit_code, String(repeated.output)).toBe(0);
			expect(received.mail).toMatchObject({ to: ["alex@example.com", "sam@example.com"], subject: "Late" });
			const noAction = await run("goblin mail --to alex@example.com --body Late");
			expect(noAction.exit_code).toBe(2);
			expect(String(noAction.output)).toContain("mail needs an action first");
			expect(String(noAction.output)).toContain("Actions: send");
			const mailHelp = String((await run("goblin mail --help")).output);
			expect(mailHelp).toContain("Actions: send");
			expect(mailHelp).toContain("--to <string> (repeat for more)");
			const created = notes.list({ project: "loose" }).find((note) => note.title === "CLI");
			expect(created).toBeDefined();
			expect(notes.get(created!.id)?.body).toBe("from-command");
		} finally {
			store.db.close();
		}
	});
});
