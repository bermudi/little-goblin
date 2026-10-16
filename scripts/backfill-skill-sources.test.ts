// The backfill is the one path that writes prod state outside the
// daemon — it earns real tests: parse correctness, dry-mode purity,
// insert-only semantics (a rerun after live writes never rewinds),
// and loud skips on unparseable/malformed lines.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/conversation.ts";
import { SkillSources } from "../src/skill-provenance.ts";

const script = join(import.meta.dir, "backfill-skill-sources.ts");

const doneLine = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		ts: "2026-10-16T00:00:00.000Z",
		level: "info",
		msg: "reviewer review done",
		review_id: "r-1",
		conversation: "app/1",
		skills: ["herdr"],
		...over,
	});

function run(home: string, log: string, ...extra: string[]) {
	const res = spawnSync("bun", [script, log, ...extra], {
		env: { ...process.env, GOBLIN_HOME: home },
		encoding: "utf8",
	});
	return { code: res.status, out: res.stdout, err: res.stderr };
}

function rowsAt(db: string) {
	const store = openStore(db);
	try {
		return new SkillSources(store.db).forConversation("app/1");
	} finally {
		store.close();
	}
}

describe("backfill-skill-sources", () => {
	const dirs: string[] = [];
	const mkHome = (): { home: string; db: string; log: string } => {
		const home = mkdtempSync(join(tmpdir(), "goblin-backfill-test-"));
		dirs.push(home);
		mkdirSync(join(home, "state"), { recursive: true });
		const db = join(home, "state", "goblin.sqlite");
		const store = openStore(db);
		store.close();
		const log = join(home, "state", "goblin.log");
		return { home, db, log };
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("records proposal lines, and --dry writes nothing", () => {
		const { home, db, log } = mkHome();
		writeFileSync(
			log,
			[
				JSON.stringify({ ts: "x", level: "info", msg: "unrelated" }),
				doneLine(),
				doneLine({ msg: "reviewer review partially proposed", skills: ["a-skill", "b-skill"] }),
				// Not a proposal (changed:false, no skills) — ignored.
				doneLine({ changed: false, skills: [] }),
			].join("\n"),
		);
		const dry = run(home, log, "--dry");
		expect(dry.code).toBe(0);
		expect(dry.out).toContain("[dry] app/1  herdr");
		expect(rowsAt(db)).toEqual([]);

		const real = run(home, log);
		expect(real.code).toBe(0);
		expect(real.out).toContain("recorded 3 rows");
		const rows = rowsAt(db);
		expect(rows.map((r) => r.skill).sort()).toEqual(["a-skill", "b-skill", "herdr"]);
		expect(rows.every((r) => r.kind === "reviewer" && r.reviewId === "r-1")).toBe(true);
	});

	test("skips unparseable and malformed lines loudly, records the rest", () => {
		const { home, db, log } = mkHome();
		writeFileSync(
			log,
			[
				doneLine().slice(0, 80), // mid-append partial, filter phrase intact
				doneLine({ skills: ["../escape"] }), // invalid name
				doneLine({ conversation: 7 }), // wrong type — skipped
				doneLine({ skills: ["good-skill"], review_id: "r-2" }),
			].join("\n"),
		);
		const res = run(home, log);
		expect(res.code).toBe(0);
		expect(res.err).toContain("skipped: 2 unparseable line(s), 1 bad name(s)");
		expect(rowsAt(db).map((r) => r.skill)).toEqual(["good-skill"]);
	});

	test("a rerun after live writes never rewinds — insert-only first_at", () => {
		const { home, db, log } = mkHome();
		writeFileSync(log, `${doneLine({ ts: "2026-10-16T01:00:00.000Z" })}\n`);
		expect(run(home, log).code).toBe(0);
		// A live turn write lands at 05:00 — newer truth than the log.
		const store = openStore(db);
		try {
			new SkillSources(store.db).record("app/1", "herdr", "turn", "2026-10-16T05:00:00.000Z");
		} finally {
			store.close();
		}
		expect(run(home, log).code).toBe(0);
		const row = rowsAt(db)[0]!;
		expect(row).toMatchObject({
			kind: "turn",
			firstAt: "2026-10-16T01:00:00.000Z",
			lastAt: "2026-10-16T05:00:00.000Z",
		});
	});

	test("missing log is a hard error, not a clean empty run", () => {
		const { home } = mkHome();
		const res = run(home, join(home, "state", "absent.log"));
		expect(res.code).toBe(1);
		expect(res.err).toContain("no log at");
	});
});
