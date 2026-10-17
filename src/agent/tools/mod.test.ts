// Prompt names must reflect every combination of optional dependencies.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import { HindsightClient } from "../../memory/hindsight.ts";
import { MEMORY_DEFAULTS } from "../../memory/policy.ts";
import type { ProgramsStore } from "../../programs.ts";
import {
	type DelegateToolDeps,
	type HistorySearchDeps,
	type ImageToolDeps,
	type MailToolDeps,
	makeTools,
	toolNames,
	type VisionToolDeps,
} from "./mod.ts";

const programs = {} as unknown as ProgramsStore;
const memoryClient = {} as unknown as HindsightClient;

describe("toolNames ↔ makeTools", () => {
	test("reflection uses shared defaults and never mutates the recall-health latch", async () => {
		const outcomes: boolean[] = [];
		let reflectOk = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				if (new URL(request.url).pathname.endsWith("/reflect")) {
					expect(await request.json()).toMatchObject({
						budget: MEMORY_DEFAULTS.reflectBudget,
						max_tokens: MEMORY_DEFAULTS.reflectMaxTokens,
					});
					return reflectOk
						? Response.json({
								text: "A synthesis.",
								based_on: { memories: [{ id: "f", text: "A fact." }] },
							})
						: new Response("synthetic failure", { status: 503 });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const tools = makeTools({
				cwd: "/tmp",
				memory: {
					client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
					maxTokens: 256,
					budget: "low",
					timeoutMs: 1000,
					isExcluded: () => false,
					noteRecall: (ok) => outcomes.push(ok),
				},
			});
			const run = async (name: string) => {
				const execute = tools[name]?.execute;
				if (!execute) throw new Error("Expected executable tool");
				return execute({ query: "x" }, { toolCallId: name, messages: [], context: {} });
			};
			await run("memory_search");
			expect(outcomes).toEqual([true]);
			expect(await run("memory_reflect")).toMatchObject({
				error: "memory investigation unavailable",
			});
			expect(outcomes).toEqual([true]);
			reflectOk = true;
			expect(await run("memory_reflect")).toMatchObject({ synthesis: "A synthesis." });
			expect(outcomes).toEqual([true]);
		} finally {
			server.stop(true);
		}
	});

	for (const voice of [false, true]) {
		for (const program of [false, true]) {
			for (const file of [false, true]) {
				for (const memory of [false, true]) {
					for (const transcribe of [false, true]) {
						for (const vision of [false, true]) {
							for (const image of [false, true]) {
								test(`voice=${voice}, program=${program}, file=${file}, memory=${memory}, transcribe=${transcribe}, vision=${vision}, image=${image}`, () => {
									const tools = makeTools({
										cwd: "/tmp",
										voice: voice
											? { synthesize: async () => [], deliver: async () => {} }
											: undefined,
										program: program
											? {
													programs,
													chatId: 1,
													threadId: null,
													publicUrl: () => "https://g.ts.net",
													sendPrivate: async () => {},
												}
											: undefined,
										file: file ? { deliver: async () => {} } : undefined,
										memory: memory
											? {
													client: memoryClient,
													maxTokens: 256,
													budget: "low",
													isExcluded: () => false,
													noteRecall: () => {},
												}
											: undefined,
										transcribe: transcribe ? { transcribe: async () => null } : undefined,
										vision: vision ? ({} as VisionToolDeps) : undefined,
										image: image ? ({} as ImageToolDeps) : undefined,
									});
									expect(toolNames(tools)).toEqual([
										"read_file",
										"write_file",
										"edit_file",
										"bash",
										...(voice ? ["speak"] : []),
										...(transcribe ? ["transcribe"] : []),
										...(vision ? ["vision"] : []),
										...(image ? ["generate_image"] : []),
										...(program ? ["program"] : []),
										...(file ? ["send_file"] : []),
										...(memory ? ["memory_search", "memory_reflect"] : []),
									]);
								});
							}
						}
					}
				}
			}
		}
	}
	test("herdr mounts on its own dep — no delegation config required", () => {
		const tools = makeTools({ cwd: "/tmp", herdr: { herdr: {} as never } });
		expect(toolNames(tools)).toContain("herdr");
		expect(toolNames(tools)).not.toContain("delegate");
	});

	test("every tool's wire schema is a root-level object (unions break providers)", () => {
		// Some providers cannot generate arguments against a root-level
		// oneOf — every call arrives as `{}` and fails validation. That
		// silently killed mail, then program, then delegate and
		// history_search. Per-tool tests pin the shapes we know; this one
		// pins the invariant for every tool that will ever join the set.
		const tools = makeTools({
			cwd: "/tmp",
			voice: { synthesize: async () => [], deliver: async () => {} },
			program: {
				programs,
				chatId: 1,
				threadId: null,
				publicUrl: () => "https://g.ts.net",
				sendPrivate: async () => {},
			},
			file: { deliver: async () => {} },
			memory: {
				client: memoryClient,
				maxTokens: 256,
				budget: "low",
				isExcluded: () => false,
				noteRecall: () => {},
			},
			web: {
				// makeTools reads configRef.current.search even when merely
				// deciding whether to mount the search tool.
				configRef: { current: {} as Config },
				auth: {} as AuthStore,
			},
			transcribe: { transcribe: async () => null },
			// delegateTool's description lists the configured harnesses,
			// so the dep needs a real config block even in a shape test.
			delegate: {
				config: { harnesses: { codex: { kind: "codex" } } },
				lifecycle: {},
				pin: () => ({ address: { chatId: 0, threadId: null } }),
				workspaceDir: "/tmp",
			} as unknown as DelegateToolDeps,
			mail: {} as unknown as MailToolDeps,
			// Mounted so the wire-schema invariant covers herdr too.
			herdr: { herdr: {} as never },
			history: {} as unknown as HistorySearchDeps,
			// Mounted so the wire-schema invariant covers vision too.
			vision: {} as unknown as VisionToolDeps,
			// Same for the subagents pair — the invariant only covers the
			// tools the call actually mounts.
			subagent: {
				conversation: "dm:1",
				workspace: "/tmp",
				subagents: {} as never,
				workerEnabled: true,
				computerEnabled: true,
			},
			desktop: {
				conversation: "dm:1",
				workspace: "/tmp",
				desktops: {} as never,
			},
			image: {} as unknown as ImageToolDeps,
		});
		for (const [name, t] of Object.entries(tools)) {
			const schema = (t as unknown as { inputSchema?: unknown }).inputSchema;
			expect(schema, `${name} exposes an input schema`).toBeDefined();
			const wire = z.toJSONSchema(schema as z.ZodType);
			expect(wire.type, `${name} wire schema must be an object, got ${wire.type}`).toBe("object");
		}
	});

	test("subagent/desktop mount only with their deps, ordered before ui", () => {
		const without = toolNames(makeTools({ cwd: "/tmp", ui: true }));
		expect(without).not.toContain("subagent");
		expect(without).not.toContain("desktop");
		expect(without).toContain("ui");

		const withBoth = toolNames(
			makeTools({
				cwd: "/tmp",
				subagent: {
					conversation: "dm:1",
					workspace: "/tmp",
					subagents: {} as never,
					workerEnabled: true,
					computerEnabled: true,
				},
				desktop: {
					conversation: "dm:1",
					workspace: "/tmp",
					desktops: {} as never,
				},
				ui: true,
			}),
		);
		expect(withBoth.indexOf("subagent")).toBeLessThan(withBoth.indexOf("ui"));
		expect(withBoth.indexOf("desktop")).toBeLessThan(withBoth.indexOf("ui"));
		expect(withBoth.at(-1)).toBe("ui");
	});
});
