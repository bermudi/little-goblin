// The clock guard (#386, pitfall 5): a test that freezes `NOW` cannot pin
// code that reads the real clock itself — 3acc0ba5 went red once the
// fixture's date passed. New time-dependent code takes `now` from its
// caller; a `now = Date.now()` default parameter is not counted. Direct
// reads in src/ and app/src/ are frozen per file below: a file may lose
// reads, never gain them, and a file not listed may have none. Prune by
// hand; print the live counts to copy from with:
//   GOBLIN_PRINT_CLOCK_READS=1 bun test src/clock-reads.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// A `now = Date.now()` default parameter is the seam, not a read.
const CLOCK_RE = /(?<!(?:^|[(,])\s*now(?:\??\s*:\s*number)?\s*=\s*)\bDate\.now\(\)|\bnew Date\(\s*\)/gm;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

function liveCounts(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app", "src"))]) {
		const n = [...readFileSync(file, "utf8").matchAll(CLOCK_RE)].length;
		if (n > 0) counts.set(file.slice(ROOT.length + 1), n);
	}
	return counts;
}

function clockReadGrowth(live: ReadonlyMap<string, number>, frozen: Readonly<Record<string, number>>): string[] {
	const out: string[] = [];
	for (const [file, n] of live) {
		const allowed = frozen[file] ?? 0;
		if (n > allowed) out.push(`${file}: ${n} direct clock reads, frozen at ${allowed}`);
	}
	return out.sort();
}

describe("clock guard", () => {
	test("no file gains a direct clock read", () => {
		const live = liveCounts();
		if (process.env.GOBLIN_PRINT_CLOCK_READS === "1") {
			const lines = [...live].sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => `\t"${f}": ${n},`);
			process.stderr.write(`clock reads:\n${lines.join("\n")}\n`);
		}
		const shrunk = Object.entries(FROZEN).filter(([f, n]) => (live.get(f) ?? 0) < n);
		if (shrunk.length > 0) {
			process.stderr.write(
				`clock guard: prune FROZEN, these files lost reads: ${shrunk.map(([f]) => f).join(", ")}\n`,
			);
		}
		expect(clockReadGrowth(live, FROZEN)).toEqual([]);
	});

	test("the seam is not a read", () => {
		const seam = "function age(at: number,\n\tnow = Date.now(),\n) {}\nconst f = (now: number = Date.now()) => now;";
		expect([...seam.matchAll(CLOCK_RE)]).toHaveLength(0);
		expect([..."const now = Date.now();".matchAll(CLOCK_RE)]).toHaveLength(1);
	});

	test("the guard fails on the old pattern", () => {
		// The 3acc0ba5 shape: a new view computing age from the real clock.
		const live = new Map([
			["app/src/NewView.tsx", 1],
			["app/src/AttentionView.tsx", 1],
		]);
		expect(clockReadGrowth(live, { "app/src/AttentionView.tsx": 1 })).toEqual([
			"app/src/NewView.tsx: 1 direct clock reads, frozen at 0",
		]);
		expect(clockReadGrowth(new Map([["app/src/AttentionView.tsx", 2]]), { "app/src/AttentionView.tsx": 1 })).toEqual([
			"app/src/AttentionView.tsx: 2 direct clock reads, frozen at 1",
		]);
	});
});

const FROZEN: Readonly<Record<string, number>> = {
	"app/src/AttentionView.tsx": 1,
	"app/src/chat/MetaLine.tsx": 2,
	"app/src/chat/useAttachments.ts": 2,
	"app/src/ChatGptAccount.tsx": 2,
	"app/src/ConversationList.tsx": 1,
	"app/src/LogView.tsx": 1,
	"app/src/memoryShared.tsx": 1,
	"app/src/MemoryView.tsx": 1,
	"app/src/ResponsibilityFeed.tsx": 1,
	"src/agent/catalog-fetch.ts": 5,
	"src/agent/claude-code/engine.ts": 3,
	"src/agent/claude-code/mod.ts": 4,
	"src/agent/codex/auth.ts": 2,
	"src/agent/codex/login.ts": 1,
	"src/agent/compaction.ts": 1,
	"src/agent/image.ts": 2,
	"src/agent/note-rewrite.ts": 3,
	"src/agent/onemin-speech.ts": 2,
	"src/agent/skill-fetch.ts": 4,
	"src/agent/tools/fetch.ts": 7,
	"src/agent/tools/herdr.ts": 2,
	"src/agent/tools/history.ts": 2,
	"src/agent/tools/responsibility.ts": 3,
	"src/agent/tools/script.ts": 3,
	"src/agent/tools/search.ts": 4,
	"src/agent/transcribe.ts": 2,
	"src/agent/tts.ts": 2,
	"src/agent/vision.ts": 3,
	"src/app-push.ts": 2,
	"src/claude-sessions.ts": 1,
	"src/conversation-history.ts": 1,
	"src/conversation-settings.ts": 2,
	"src/conversation.ts": 8,
	"src/delegation-lifecycle.ts": 8,
	"src/delegations.ts": 3,
	"src/desktops.ts": 16,
	"src/durable.ts": 2,
	"src/github.ts": 3,
	"src/health/config-auth.ts": 1,
	"src/health/mod.ts": 1,
	"src/herdr.ts": 3,
	"src/http/app-sse.ts": 3,
	"src/http/app-turns.ts": 2,
	"src/http/auth.ts": 2,
	"src/http/check.ts": 3,
	"src/http/mod.ts": 4,
	"src/http/operator-memory.ts": 8,
	"src/http/operator-status.ts": 1,
	"src/index.ts": 1,
	"src/injection.ts": 3,
	"src/log.ts": 4,
	"src/mail-approval.ts": 3,
	"src/mail-gws.ts": 2,
	"src/mail-outbox.ts": 5,
	"src/mail-watcher.ts": 1,
	"src/mail.ts": 4,
	"src/memory/destinations.ts": 1,
	"src/memory/forget.ts": 5,
	"src/memory/hindsight.ts": 3,
	"src/memory/mod.ts": 3,
	"src/memory/queue.ts": 3,
	"src/notes.ts": 1,
	"src/podman.ts": 6,
	"src/program-approval.ts": 1,
	"src/program-ops.ts": 1,
	"src/program-proposals.ts": 4,
	"src/programs.ts": 4,
	"src/projects.ts": 2,
	"src/reminders/deliver.ts": 1,
	"src/reminders/telegram.ts": 1,
	"src/reply-ratings.ts": 2,
	"src/responsibilities.ts": 3,
	"src/responsibility-observer.ts": 1,
	"src/reviewer.ts": 3,
	"src/rolling.ts": 5,
	"src/sandboxes.ts": 13,
	"src/scheduler.ts": 2,
	"src/skill-decisions.ts": 1,
	"src/skill-provenance.ts": 2,
	"src/subagent-runs.ts": 5,
	"src/subagents/admission.ts": 7,
	"src/subagents/approval-gate.ts": 1,
	"src/subagents/drain.ts": 1,
	"src/subagents/env.ts": 1,
	"src/subagents/mod.ts": 2,
	"src/subagents/recovery.ts": 3,
	"src/subagents/settle.ts": 5,
	"src/subagents/testing.ts": 8,
	"src/subagents/tools.ts": 2,
	"src/test-helpers/boot.ts": 4,
	"src/test-helpers/loopback-preload.ts": 1,
	"src/test-helpers/pr-readiness.ts": 1,
	"src/testkit.ts": 2,
	"src/tg/buffer.ts": 2,
	"src/tg/commands.ts": 1,
	"src/tg/delivery.ts": 8,
	"src/tg/forget-listings.ts": 1,
	"src/tg/guest.ts": 3,
	"src/tg/inbox.ts": 1,
	"src/tg/pings.ts": 1,
	"src/tg/skill-command.ts": 2,
	"src/turn-journal.ts": 10,
	"src/turn/finish.ts": 1,
	"src/turn/stream.ts": 2,
	"src/wake-dispatcher.ts": 1,
	"src/wake-store.ts": 5,
};
