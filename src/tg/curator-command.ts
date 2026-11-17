// /curator — the Telegram door onto the deterministic curator
// (design/skills.md → Self-authoring, /learn, curator).
//
//   /curator status            usage clock rows, per skill
//   /curator run               one pass now (ignores the interval gate)
//   /curator pin <name>        the operator's keep override
//   /curator unpin <name>
//   /curator restore <name>    move the newest archived copy back
//
// Operator-only like /skill; never submits a turn. The pass, pin and
// restore are the same functions boot and turn completion call.

import type { Api } from "grammy";
import { log } from "../log.ts";
import { paths } from "../home-layout.ts";
import { skillNameSchema, type SkillSources } from "../skill-provenance.ts";
import {
	curatorConfig,
	curatorStatusRows,
	passDue,
	restoreArchivedSkill,
	runCuratorPass,
	setSkillPinned,
} from "../skill-curator.ts";
import { readSkillUsage, writeSkillUsage } from "../skill-usage.ts";
import { withTimeout } from "./deadline.ts";
import type { ConfigRef } from "../config.ts";

export interface CuratorCommandDeps {
	api: Api;
	configRef: Pick<ConfigRef, "current">;
	skillSources: Pick<SkillSources, "managedNames">;
	chatId: number;
	threadId: number | null;
	/** Test seam — the clock in Date.now millis, called per use. */
	now?: () => number;
}

const USAGE = [
	"usage: /curator status|run|pin <name>|unpin <name>|restore <name>",
	"",
	"status — every skill's usage clock and state",
	"run — one curator pass now",
	"pin/unpin <name> — pin skips every pass transition",
	"restore <name> — move the newest archived copy back",
].join("\n");

// Test seam — the exempt clock-read shape: a `now` parameter default
// reading the clock (src/clock-reads.test.ts).
function clock(now = Date.now()): Date {
	return new Date(now);
}
export async function handleCuratorCommand(
	deps: CuratorCommandDeps,
	text: string,
): Promise<boolean> {
	const arg = text.replace(/^\/curator(?:@\S+)?/i, "").trim();
	const sub = arg.split(/\s+/)[0] ?? "";
	const reply = (body: string): Promise<void> =>
		withTimeout(
			deps.api.sendMessage(deps.chatId, body, {
				...(deps.threadId !== null ? { message_thread_id: deps.threadId } : {}),
			} as Parameters<typeof deps.api.sendMessage>[2]),
			"sendMessage (/curator)",
		).then(() => {});

	const cfg = curatorConfig(deps.configRef.current.curator);
	const now = (): Date => clock(deps.now?.());
	if (sub === "status") {
		const file = readSkillUsage(paths.skillUsage());
		const rows = curatorStatusRows(file, deps.skillSources.managedNames(), now());
		const body =
			cfg === undefined
				? [...renderRows(rows), "", "curator: off — pin and restore stay manual."].join("\n")
				: [
						`curator: on — stale ${cfg.staleDays}d, archive ${cfg.archiveDays}d, pass every 168h`,
						...renderRows(rows),
						"",
						passDue(file, now()) ? "a pass is due — it runs after the next settled turn or /curator run." : "pass not due.",
					].join("\n");
		await reply(body);
		return true;
	}
	if (sub === "run") {
		if (cfg === undefined) {
			await reply("curator is off — add a `curator` block to goblin.json5 first.");
			return true;
		}
		const passNow = now();
		const usagePath = paths.skillUsage();
		const { file: next, counters } = runCuratorPass(
			readSkillUsage(usagePath),
			deps.skillSources.managedNames(),
			cfg,
			passNow,
		);
		writeSkillUsage(usagePath, next);
		log.info("curator run via /curator", { ...counters });
		await reply(
			`pass run: ${counters.checked} checked, ${counters.seeded} seeded, ${counters.markedStale} stale, ${counters.archived} archived, ${counters.reactivated} reactivated, ${counters.skippedPinned} pinned-skip.`,
		);
		return true;
	}
	if (sub === "pin" || sub === "unpin") {
		const name = arg.slice(sub.length).trim();
		const parsed = skillNameSchema.safeParse(name);
		if (!parsed.success) {
			await reply(`not a skill name: ${name}`);
			return true;
		}
		const ok = setSkillPinned(
			paths.skillUsage(),
			parsed.data,
			sub === "pin",
			deps.skillSources.managedNames(),
			now(),
		);
		log.info("curator pin via /curator", { skill: parsed.data, pinned: sub === "pin", ok });
		await reply(ok ? `${parsed.data} ${sub === "pin" ? "pinned" : "unpinned"}.` : `no record for ${parsed.data} — invoke it or author it first.`);
		return true;
	}
	if (sub === "restore") {
		const name = arg.slice(sub.length).trim();
		const parsed = skillNameSchema.safeParse(name);
		if (!parsed.success) {
			await reply(`not a skill name: ${name}`);
			return true;
		}
		const { restored, reason } = restoreArchivedSkill(paths.skillUsage(), parsed.data);
		log.info("curator restore via /curator", { skill: parsed.data, restored: restored !== null });
		await reply(restored !== null ? `${restored} restored.` : `restore failed: ${reason}`);
		return true;
	}
	await reply(USAGE);
	return true;
}

function renderRows(rows: ReturnType<typeof curatorStatusRows>): string[] {
	if (rows.length === 0) return ["no skills tracked yet."];
	return rows.map(
		(r) =>
			`${r.pinned ? "📌 " : ""}${r.skill} — ${r.state}, ${r.useCount} uses, ${r.patchCount} patches, idle ${r.idleDays}d`,
	);
}
