// The program tool — standing orders (DESIGN.md, "Programs"). A
// program is standing authority for one concern: a charter plus the
// triggers that wake it (a cron; optionally a webhook — a secret URL
// whose bearer wakes the program). Management is state mutation:
// zod-validated actions against the programs store, every action
// logged. The creating conversation is bound by the runtime (the model
// never handles chat ids); replies to a fired program land in that
// same chat/topic.
//
// The hook token never enters model context: only its sha256 is
// stored, and the URL goes straight to the operator via sendPrivate —
// the tool result carries just "url_sent". The hash is never logged.

import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { nextFire, type Program, type ProgramsStore } from "../../programs.ts";

function programView(program: Program): Record<string, unknown> {
	return {
		id: program.id,
		name: program.name,
		charter: program.charter,
		cron: program.cron,
		has_hook: program.hookHash !== null,
		mail_filter: program.mailFilter,
		enabled: program.enabled,
		last_run: program.lastRun,
		next_run: program.nextRun,
	};
}

export interface ProgramToolDeps {
	programs: ProgramsStore;
	/** The conversation this tool call runs in — pinned onto new programs. */
	chatId: number;
	threadId: number | null;
	/** Live read — the operator can change publicUrl in the mini app. */
	publicUrl(): string | undefined;
	/** Direct delivery to the operators' DMs — bypasses history, so the
	 *  hook token never becomes model context next turn. Built by
	 *  makePrivateSender in production. */
	sendPrivate(text: string): Promise<void>;
}

// 32 random bytes, base64url — the whole URL path is the credential.
function newHookToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

// Builds the tool's sendPrivate dep. The hook URL is a bearer
// credential and DESIGN.md rules group readers aren't implicitly
// authorized — so it goes to each operator's private chat (user id as
// chat id), never the possibly-shared topic the tool ran in. One
// delivered DM counts as sent; zero deliveries throws so the caller
// can surface "rotate to resend".
export function makePrivateSender(
	send: (chatId: number, text: string) => Promise<unknown>,
	operatorIds: () => number[],
): (text: string) => Promise<void> {
	return async (text) => {
		let delivered = 0;
		for (const id of operatorIds()) {
			try {
				await send(id, text);
				delivered++;
				log.info("private delivery", { user: id });
			} catch (err) {
				log.warn("private delivery failed", {
					user: id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (delivered === 0) {
			throw new Error(
				"couldn't DM the operator — they may need to open a private chat with the bot first",
			);
		}
	};
}

export function hookTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export const programTool = (deps: ProgramToolDeps) =>
	tool({
		description:
			"Manage programs — a program is standing authority for one concern. Its charter says what it owns: scope, what needs the operator's OK, when to escalate, what not to do, and the steps — write that, not a one-line instruction. A cron is 5 fields (minute hour day month weekday) in server local time; translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. The 'hook' action gives a program a secret URL that external services POST to wake it — the URL is sent to the operator privately and never appears to you. A mail filter (Gmail query syntax, e.g. from:bank is:important) wakes the program when new matching mail arrives. Creating a program or widening its authority needs the operator's explicit ask — you may propose one, never grant yourself one. Rewording, rescheduling, or toggling within the charter's intent needs no go-ahead.",
		inputSchema: z.discriminatedUnion("action", [
			z.object({ action: z.literal("list") }),
			z.object({
				action: z.literal("create"),
				name: z.string().min(1).max(100),
				charter: z.string().min(1),
				cron: z.string().min(5).optional(),
				hook: z.boolean().optional(),
				mailFilter: z.string().min(1).max(500).optional(),
			}),
			z.object({
				action: z.literal("update"),
				id: z.number().int().positive(),
				name: z.string().min(1).max(100).optional(),
				charter: z.string().min(1).optional(),
				// null clears the cron — allowed only while a hook remains.
				cron: z.string().min(5).nullable().optional(),
				// null clears the mail filter — allowed only while another trigger remains.
				mailFilter: z.string().min(1).max(500).nullable().optional(),
			}),
			z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
			z.object({ action: z.literal("toggle"), id: z.number().int().positive() }),
			z.object({
				action: z.literal("hook"),
				id: z.number().int().positive(),
				op: z.enum(["enable", "rotate", "disable"]),
			}),
		]),
		execute: async (input) => {
			switch (input.action) {
				case "list":
					return { programs: deps.programs.list().map(programView) };
				case "create": {
					if (input.cron !== undefined) {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					// A requested hook needs its token+URL up front: the row's
					// trigger invariant counts the hook from creation.
					const minted = input.hook === true ? mintHook(deps) : null;
					if (minted !== null && "error" in minted) return { error: minted.error };
					try {
						const program = deps.programs.create(
							{
								name: input.name,
								charter: input.charter,
								...(input.cron !== undefined ? { cron: input.cron } : {}),
								...(minted !== null ? { hookHash: hookTokenHash(minted.token) } : {}),
								...(input.mailFilter !== undefined ? { mailFilter: input.mailFilter } : {}),
								address: { chatId: deps.chatId, threadId: deps.threadId },
							},
						);
						log.info("program created", {
							program: program.id,
							name: program.name,
							cron: program.cron,
							hook: program.hookHash !== null,
							mail: program.mailFilter !== null,
							conversation: `${deps.chatId}/${deps.threadId ?? "-"}`,
						});
						if (minted !== null) {
							const err = await sendHookUrl(deps, program, minted.url);
							if (err !== null) {
								return {
									program: programView(program),
									error: `hook is set but the URL delivery failed: ${err} — run hook/rotate to resend`,
								};
							}
							return { program: programView(program), hook: "enabled", url_sent: true };
						}
						return { program: programView(program) };
					} catch (err) {
						if (isTriggerError(err)) {
							return { error: err instanceof Error ? err.message : String(err) };
						}
						throw err;
					}
				}
				case "update": {
					if (typeof input.cron === "string") {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					// exactOptionalPropertyTypes: never pass an explicit undefined.
					const patch: { name?: string; charter?: string; cron?: string | null; mailFilter?: string | null } = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.charter !== undefined) patch.charter = input.charter;
					if (input.cron !== undefined) patch.cron = input.cron;
					if (input.mailFilter !== undefined) patch.mailFilter = input.mailFilter;
					try {
						const program = deps.programs.update(input.id, patch);
						if (program === null) return { error: `no program ${input.id}` };
						log.info("program updated", { program: program.id, name: program.name });
						return { program: programView(program) };
					} catch (err) {
						// The trigger invariant is model-actionable; storage
						// failures propagate — never swallowed.
						if (isTriggerError(err)) {
							return { error: err instanceof Error ? err.message : String(err) };
						}
						throw err;
					}
				}
				case "delete": {
					const ok = deps.programs.remove(input.id);
					log.info("program deleted", { program: input.id, existed: ok });
					return ok ? { deleted: input.id } : { error: `no program ${input.id}` };
				}
				case "toggle": {
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
					const program = deps.programs.update(input.id, { enabled: !current.enabled })!;
					log.info("program toggled", { program: program.id, enabled: program.enabled });
					return { program: programView(program) };
				}
				case "hook": {
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
					if (input.op === "disable") {
						try {
							deps.programs.setHook(input.id, null);
						} catch (err) {
							if (isTriggerError(err)) {
								return { error: err instanceof Error ? err.message : String(err) };
							}
							throw err;
						}
						log.info("program hook disabled", { program: input.id, name: current.name });
						return { program: programView(deps.programs.get(input.id)!) };
					}
					// enable | rotate — same work; the difference is only in
					// what we call it to the model.
					const minted = mintHook(deps);
					if ("error" in minted) return { error: minted.error };
					deps.programs.setHook(input.id, hookTokenHash(minted.token));
					const op = input.op === "rotate" ? "rotated" : "enabled";
					const err = await sendHookUrl(deps, current, minted.url);
					if (err !== null) {
						// The hook IS set — the failure is delivery, and rotate
						// is the recovery path.
						return { error: `hook ${op} but the URL delivery failed: ${err} — run hook/rotate to resend` };
					}
					log.info(`program hook ${op}`, { program: input.id, name: current.name });
					return { hook: op, url_sent: true };
				}
			}
		},
	});

// The store's trigger-invariant message is the one thrown error a
// tool call can fix — everything else (storage failures) propagates.
function isTriggerError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("at least one trigger");
}

// Token + URL + the publicUrl gate. Returns the minted pair or an
// error — checked before any row change.
function mintHook(deps: ProgramToolDeps): { token: string; url: string } | { error: string } {
	const base = deps.publicUrl();
	if (base === undefined) {
		return { error: "publicUrl is not set — set it in the mini app first" };
	}
	const token = newHookToken();
	return { token, url: `${base.replace(/\/+$/, "")}/hook/${token}` };
}

// The URL goes straight to the operator — never into the tool result.
async function sendHookUrl(
	deps: ProgramToolDeps,
	program: Program,
	url: string,
): Promise<string | null> {
	try {
		await deps.sendPrivate(
			`Webhook for program ${program.name}: ${url}\nKeep it secret; rotate via goblin if it leaks.`,
		);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
