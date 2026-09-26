// The delegate tool — hand a task to an external coding harness running
// in goblin's herdr session (DESIGN.md, "Delegation"). One herdr
// workspace per delegation; the watcher (delegations.ts) polls the
// agent and reports back here as a `[delegation: …]` turn. Bound
// per-turn to the running conversation like program — notices pin to
// the chat/topic it was born in, the model never handles chat ids.

import { tool } from "ai";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { log } from "../../log.ts";
import {
	agentNameFor,
	type Delegation,
	type DelegationsStore,
} from "../../delegations.ts";
import type { Herdr } from "../../herdr.ts";
import type { DelegationConfig } from "../../config.ts";

export interface DelegateToolDeps {
	delegations: DelegationsStore;
	herdr: Herdr;
	config: DelegationConfig;
	/** The conversation this tool call runs in — pinned onto new rows. */
	chatId: number;
	threadId: number | null;
	/** Goblin's workspace — the default and the relative-cwd anchor. */
	workspaceDir: string;
	/** Report dirs live under <delegationsDir>/<id>/report.md. */
	delegationsDir: string;
}

function view(d: Delegation): Record<string, unknown> {
	return {
		id: d.id,
		name: d.name,
		harness: d.harness,
		cwd: d.cwd,
		status: d.status,
		agent_name: d.agentName || undefined,
		workspace_id: d.workspaceId || undefined,
		created_at: d.createdAt,
		finished_at: d.finishedAt,
	};
}

const REPORT_NOTE =
	"\n\nWhen you are completely finished, write your final report (what you did, what's left, anything you need from the operator) as Markdown to ";

export const delegateTool = (deps: DelegateToolDeps) =>
	tool({
		description:
			"Delegate a task to an external coding harness (a separate agent in its own workspace, running full-auto — you may delegate on your own judgment for long or coding-heavy work instead of blocking the chat with bash, and you must tell the operator you did). Results arrive later as a [delegation: …] message — the task does not answer immediately. If a delegation ends at 'needs input' (an approval, a question, a startup dialog), relay it to the operator and send back their answer with 'send' — never answer an agent's question on the operator's behalf. Follow-ups to a finished delegation also go through 'send' — it re-prompts the agent in the workspace it kept.",
		inputSchema: z.discriminatedUnion("action", [
			z.object({
				action: z.literal("start"),
				harness: z.string().min(1),
				task: z.string().min(1),
				cwd: z.string().min(1).optional(),
				name: z.string().min(1).max(40).optional(),
			}),
			z.object({ action: z.literal("list") }),
			z.object({
				action: z.literal("read"),
				id: z.number().int().positive(),
				lines: z.number().int().min(1).max(200).optional(),
			}),
			z.object({
				action: z.literal("send"),
				id: z.number().int().positive(),
				text: z.string().min(1),
			}),
			z.object({ action: z.literal("stop"), id: z.number().int().positive() }),
		]),
		execute: async (input) => {
			switch (input.action) {
				case "start":
					return start(input);
				case "list": {
					// Everything live, plus a tail of finished rows for
					// context — the table only ever grows.
					const rows = deps.delegations.list();
					const live = rows.filter(
						(d) => d.status === "running" || d.status === "needs_input",
					);
					const recent = rows
						.filter((d) => d.status !== "running" && d.status !== "needs_input")
						.slice(-10);
					return { delegations: [...live, ...recent].map(view) };
				}
				case "read": {
					const d = deps.delegations.get(input.id);
					if (d === null) return { error: `no delegation ${input.id}` };
					const lines = input.lines ?? 60;
					if (d.agentName) {
						try {
							return { id: d.id, status: d.status, screen: await deps.herdr.readAgent(d.agentName, lines) };
						} catch (err) {
							// Agent gone — the pane may still hold the tail.
							log.warn("delegation agent read failed — trying pane", {
								delegation: d.id,
								error: err instanceof Error ? err.message : String(err),
							});
							if (d.paneId) {
								try {
									return { id: d.id, status: d.status, screen: await deps.herdr.readPane(d.paneId, lines) };
								} catch {
									// fall through to the error below
								}
							}
							return { error: `screen unreadable: ${err instanceof Error ? err.message : String(err)}` };
						}
					}
					return { error: `delegation ${d.id} never launched (status ${d.status})` };
				}
				case "send": {
					const d = deps.delegations.get(input.id);
					if (d === null) return { error: `no delegation ${input.id}` };
					// Everything but stopped takes input — follow-ups to a
					// finished delegation are the natural next ask and its
					// workspace is kept alive for exactly that. A dead
					// agent is herdr's own error to report.
					if (d.status === "stopped") {
						return { error: `delegation ${d.id} is stopped — its workspace is closed` };
					}
					try {
						await deps.herdr.prompt(d.agentName, input.text);
					} catch (err) {
						return { error: err instanceof Error ? err.message : String(err) };
					}
					let seq = d.baselineSeq;
					try {
						seq = (await deps.herdr.get(d.agentName))?.state_change_seq ?? seq;
					} catch (err) {
						// baseline stays — a failed get doesn't break the send
						log.warn("delegation post-send baseline read failed", {
							delegation: d.id,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					// Back to running with a fresh baseline: the stall/done
					// comparisons restart from this prompt.
					deps.delegations.setStatus(d.id, "running");
					deps.delegations.markPrompted(d.id, seq);
					log.info("delegation prompted", { delegation: d.id, name: d.name });
					return { sent: d.id, status: "running" };
				}
				case "stop": {
					const d = deps.delegations.get(input.id);
					if (d === null) return { error: `no delegation ${input.id}` };
					const notes: string[] = [];
					if (d.status === "running" || d.status === "needs_input") {
						try {
							await deps.herdr.interrupt(d.agentName);
						} catch (err) {
							notes.push(`interrupt: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
					if (d.workspaceId) {
						try {
							await deps.herdr.closeWorkspace(d.workspaceId);
						} catch (err) {
							notes.push(`close: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
					deps.delegations.setStatus(d.id, "stopped");
					log.info("delegation stopped", { delegation: d.id, name: d.name, notes });
					return { stopped: d.id, ...(notes.length ? { notes } : {}) };
				}
			}

			async function start(input: {
				harness: string;
				task: string;
				cwd?: string | undefined;
				name?: string | undefined;
			}): Promise<Record<string, unknown>> {
				const h = deps.config.harnesses[input.harness];
				if (!h) {
					return {
						error: `unknown harness "${input.harness}" — configured: ${Object.keys(deps.config.harnesses).join(", ")}`,
					};
				}

				const cwd = input.cwd
					? isAbsolute(input.cwd)
						? input.cwd
						: resolve(deps.workspaceDir, input.cwd)
					: deps.workspaceDir;
				if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
					return { error: `cwd "${cwd}" does not exist or is not a directory` };
				}

				const running = deps.delegations.active();
				if (running.length >= deps.config.maxRunning) {
					return {
						error: `delegation cap reached (${deps.config.maxRunning} running): ${running.map((d) => `#${d.id} ${d.name}`).join(", ")}`,
					};
				}

				const name =
					input.name ??
					(input.task.split("\n", 1)[0]!.slice(0, 40).trim() || "delegation");
				const d = deps.delegations.create({
					name,
					harness: input.harness,
					cwd,
					task: input.task,
					address: { chatId: deps.chatId, threadId: deps.threadId },
				});
				const reportDir = join(deps.delegationsDir, String(d.id));
				mkdirSync(reportDir, { recursive: true });
				const reportPath = join(reportDir, "report.md");

				const fail = async (why: string): Promise<Record<string, unknown>> => {
					deps.delegations.setStatus(d.id, "failed");
					const bound = deps.delegations.get(d.id);
					if (bound?.workspaceId) {
						try {
							await deps.herdr.closeWorkspace(bound.workspaceId);
						} catch (err) {
							log.warn("delegation cleanup failed", {
								delegation: d.id,
								error: String(err),
							});
						}
					}
					log.info("delegation failed at start", { delegation: d.id, name, why });
					return { error: `delegation ${d.id} failed at start: ${why}` };
				};

				let ws: { workspaceId: string; paneId: string };
				try {
					ws = await deps.herdr.createWorkspace(cwd, name);
				} catch (err) {
					return fail(err instanceof Error ? err.message : String(err));
				}
				const agentName = agentNameFor(d.id, name);
				deps.delegations.bindLaunch(d.id, {
					agentName,
					workspaceId: ws.workspaceId,
					paneId: ws.paneId,
				});

				try {
					await deps.herdr.startAgent(agentName, h.kind, ws.paneId, h.args ?? []);
				} catch (err) {
					// Blocked/not-ready starts leave the pane alive — its
					// screen explains the refusal (trust dialogs, update
					// prompts); attach it to the error the model sees.
					let screen = "";
					try {
						screen = `\n--- screen ---\n${await deps.herdr.readPane(ws.paneId, 40)}`;
					} catch (err2) {
						// no screen — the error text carries it
						log.warn("delegation start-failure screen unreadable", {
							delegation: d.id,
							error: err2 instanceof Error ? err2.message : String(err2),
						});
					}
					return fail(`${err instanceof Error ? err.message : String(err)}${screen}`);
				}

				try {
					await deps.herdr.prompt(agentName, input.task + REPORT_NOTE + reportPath);
				} catch (err) {
					return fail(err instanceof Error ? err.message : String(err));
				}
				let baseline = 0;
				try {
					baseline = (await deps.herdr.get(agentName))?.state_change_seq ?? 0;
				} catch (err) {
					// A get failure right after prompt must not fail the
					// delegation — the watcher's next poll reconciles.
					log.warn("delegation baseline read failed", {
						delegation: d.id,
						error: String(err),
					});
				}
				deps.delegations.markPrompted(d.id, baseline);
				log.info("delegation started", {
					delegation: d.id,
					name,
					harness: input.harness,
					kind: h.kind,
					cwd,
					conversation: `${deps.chatId}/${deps.threadId ?? "-"}`,
				});
				return {
					id: d.id,
					name,
					agent_name: agentName,
					status: "running",
					attach: `herdr session attach ${deps.config.session}`,
				};
			}
		},
	});
