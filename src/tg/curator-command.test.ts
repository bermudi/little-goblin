import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../home-layout.ts";
import { useHome } from "../testkit.ts";
import { fakeApi, type FakeApi } from "../testkit/fake-api.ts";
import { openStore } from "../conversation.ts";
import { SkillSources } from "../skill-provenance.ts";
import { handleCuratorCommand, type CuratorCommandDeps } from "./curator-command.ts";
import { freshUsageRecord, readSkillUsage, writeSkillUsage } from "../skill-usage.ts";

function harness(cfg: unknown): { deps: CuratorCommandDeps; fake: FakeApi } {
	const h = useHome("goblin-curator-cmd-");
	mkdirSync(join(h, "state"), { recursive: true });
	const store = openStore(paths.db());
	const sources = new SkillSources(store.db);
	const fake = fakeApi({});
	const deps: CuratorCommandDeps = {
		api: fake.api as unknown as CuratorCommandDeps["api"],
		configRef: { current: { curator: cfg } } as CuratorCommandDeps["configRef"],
		skillSources: sources,
		chatId: 1,
		threadId: null,
	};
	return { deps, fake };
}

const DAY = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);

describe("/curator", () => {
	test("status renders rows and the off state", async () => {
		const { deps, fake } = harness(undefined);
		const file = readSkillUsage(paths.skillUsage());
		file.skills["demo"] = { ...freshUsageRecord(ago(3)), useCount: 2 };
		writeSkillUsage(paths.skillUsage(), file);
		expect(await handleCuratorCommand(deps, "/curator status")).toBe(true);
		const text = fake.texts.join("\n");
		expect(text).toContain("demo");
		expect(text).toContain("curator: off");
	});

	test("status shows on with day counts and pin markers", async () => {
		const { deps, fake } = harness({ staleDays: 7, archiveDays: 21 });
		const file = readSkillUsage(paths.skillUsage());
		file.skills["pinned-one"] = { ...freshUsageRecord(ago(3)), useCount: 1, pinned: true };
		writeSkillUsage(paths.skillUsage(), file);
		expect(await handleCuratorCommand(deps, "/curator status")).toBe(true);
		const text = fake.texts.join("\n");
		expect(text).toContain("stale 7d, archive 21d");
		expect(text).toContain("📌");
	});

	test("run refuses when off, runs when on", async () => {
		const { deps: offDeps, fake: offFake } = harness(undefined);
		expect(await handleCuratorCommand(offDeps, "/curator run")).toBe(true);
		expect(offFake.texts.join("\n")).toContain("curator is off");

		const { deps, fake } = harness({});
		expect(await handleCuratorCommand(deps, "/curator run")).toBe(true);
		const text = fake.texts.join("\n");
		expect(text).toContain("pass run: 0 checked");
		expect(readSkillUsage(paths.skillUsage()).lastCuratorRun).not.toBeNull();
	});

	test("pin / unpin / restore round-trip through the sidecar", async () => {
		const { deps, fake } = harness({});
		// A recorded skill pins (a use created the record); an unknown
		// name refuses — the pin has nothing to attach to.
		const file = readSkillUsage(paths.skillUsage());
		file.skills["demo-skill"] = freshUsageRecord(new Date());
		writeSkillUsage(paths.skillUsage(), file);
		expect(await handleCuratorCommand(deps, "/curator pin demo-skill")).toBe(true);
		const rec = readSkillUsage(paths.skillUsage()).skills["demo-skill"];
		expect(rec?.pinned).toBe(true);
		expect(await handleCuratorCommand(deps, "/curator unpin demo-skill")).toBe(true);
		expect(readSkillUsage(paths.skillUsage()).skills["demo-skill"]?.pinned).toBe(false);

		// Restore with nothing archived.
		expect(await handleCuratorCommand(deps, "/curator restore demo-skill")).toBe(true);
		expect(fake.texts.join("\n")).toContain("no archive yet");
	});

	test("bad names and bare invocations answer usage", async () => {
		const { deps, fake } = harness({});
		expect(await handleCuratorCommand(deps, "/curator pin Not-A-Name!")).toBe(true);
		expect(fake.texts.join("\n")).toContain("not a skill name");
		fake.texts.length = 0;
		expect(await handleCuratorCommand(deps, "/curator")).toBe(true);
		expect(fake.texts.join("\n")).toContain("usage: /curator");
	});
});
