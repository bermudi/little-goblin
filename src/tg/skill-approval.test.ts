// Skill proposal taps (design/skills.md, "It proposes, then tells"):
// the tap decides mechanically on disk — install swaps the proposal
// into skills/ (replacing a live copy atomically, rollback on failure),
// discard deletes the staged dir. Symlinks on either path are operator
// state: the decision refuses loudly and the proposal stands. Disk is
// the state, so the tests exercise real directories; the api is faked
// at the grammy boundary like every delivery test.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { describe, expect, test } from "bun:test";
import { setLogFile, setLogWriter } from "../log.ts";
import {
	parseSkillCallback,
	skillDiscardData,
	skillInstallData,
	startSkillApproval,
} from "./skill-approval.ts";

interface Harness {
	handle(query: {
		data: string;
		// null = the notice died — no message to stamp or strip.
		message?: { message_id: number; chat: { id: number } } | null;
	}): Promise<void>;
	skillsDir: string;
	proposedDir: string;
	edits: Array<{ chatId: number; messageId: number; text: string; keyboard: unknown }>;
	strips: number[];
	answers: Array<string | undefined>;
	appends: Array<{ conversationId: string; text: string }>;
	cleanup(): void;
}

function harness(initialProposals: string[], initialSkills: string[] = []): Harness {
	const root = mkdtempSync(join(tmpdir(), "goblin-skill-approval-"));
	const workspaceDir = join(root, "workspace");
	const skillsDir = join(workspaceDir, "skills");
	const proposedDir = join(workspaceDir, "skills-proposed");
	mkdirSync(proposedDir, { recursive: true });
	for (const name of initialProposals) {
		mkdirSync(join(proposedDir, name), { recursive: true });
		writeFileSync(join(proposedDir, name, "SKILL.md"), `# ${name}\n`);
	}
	for (const name of initialSkills) {
		mkdirSync(join(skillsDir, name), { recursive: true });
		writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name} live\n`);
	}
	const edits: Harness["edits"] = [];
	const strips: number[] = [];
	const answers: Array<string | undefined> = [];
	const appends: Harness["appends"] = [];
	const api = {
		answerCallbackQuery: async (_id: string, other?: { text?: string }) => {
			answers.push(other?.text);
			return true;
		},
		editMessageText: async (
			chatId: number,
			messageId: number,
			text: string,
			other?: { reply_markup?: unknown },
		) => {
			edits.push({ chatId, messageId, text, keyboard: other?.reply_markup });
			return true;
		},
		editMessageReplyMarkup: async (_chatId: number, messageId: number, _m: unknown) => {
			strips.push(messageId);
			return true;
		},
	} as unknown as Api;
	const approval = startSkillApproval({
		api,
		store: {
			append: (conversationId, messages) => {
				appends.push({
					conversationId,
					text: (messages[0]!.parts[0] as { type: "text"; text: string }).text,
				});
			},
		},
		workspaceDir,
		skillsDir,
		proposedDir,
		now: () => new Date(1_700_000_000_000),
	});
	return {
		handle: (query: {
			data: string;
			// null = the notice died — no message to stamp or strip.
			message?: { message_id: number; chat: { id: number } } | null;
		}) =>
			approval.handleTap({
				id: "q1",
				data: query.data,
				...(query.message === null
					? {}
					: { message: query.message ?? { message_id: 55, chat: { id: 42 } } }),
			}),
		skillsDir,
		proposedDir,
		edits,
		strips,
		answers,
		appends,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("skill callback parse", () => {
	test("round-trips install and discard data", () => {
		expect(parseSkillCallback(skillInstallData("dm:42", "smoke-test"))).toEqual({
			op: "install",
			conversationId: "dm:42",
			skill: "smoke-test",
		});
		expect(parseSkillCallback(skillDiscardData("tg:-100:5", "smoke-test"))).toEqual({
			op: "discard",
			conversationId: "tg:-100:5",
			skill: "smoke-test",
		});
	});

	test("rejects names the catalog would reject", () => {
		expect(parseSkillCallback("skill:install:dm:42:../escape")).toBeNull();
		expect(parseSkillCallback("skill:install:dm:42:Upper")).toBeNull();
		expect(parseSkillCallback("skill:install:dm:42:double--hyphen")).toBeNull();
		expect(parseSkillCallback("skill:install:dm:42:-leading")).toBeNull();
		expect(parseSkillCallback("skill:burn:dm:42:x")).toBeNull();
	});
});

describe("skill approval taps", () => {
	const silenceLogs = () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-approval-logs-"));
		setLogFile(join(dir, "test.log"));
		setLogWriter(() => {});
		return () => {
			setLogFile(null);
			setLogWriter(null);
		};
	};

	test("install moves the proposal into skills/ and stamps the message", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"]);
		try {
			await h.handle({ data: skillInstallData("dm:42", "smoke-test") });
			expect(existsSync(join(h.skillsDir, "smoke-test", "SKILL.md"))).toBe(true);
			expect(existsSync(join(h.proposedDir, "smoke-test"))).toBe(false);
			expect(h.edits).toHaveLength(1);
			expect(h.edits[0]!.text).toBe("✅ skill smoke-test installed.");
			expect(h.edits[0]!.keyboard).toEqual({ inline_keyboard: [] });
			expect(h.appends).toEqual([
				{ conversationId: "dm:42", text: "skill proposal resolved: smoke-test — installed" },
			]);
		} finally {
			h.cleanup();
			done();
		}
	});

	test("install over a live copy replaces it and says so", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"], ["smoke-test"]);
		try {
			await h.handle({ data: skillInstallData("dm:42", "smoke-test") });
			expect(existsSync(join(h.skillsDir, "smoke-test", "SKILL.md"))).toBe(true);
			const text = (await Bun.file(join(h.skillsDir, "smoke-test", "SKILL.md")).text()) as string;
			expect(text).toBe("# smoke-test\n"); // the proposal, not the live copy
			expect(h.edits[0]!.text).toBe("✅ skill smoke-test installed — replaced the live copy.");
		} finally {
			h.cleanup();
			done();
		}
	});

	test("a symlink at the live path refuses the install, proposal stands", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"]);
		try {
			mkdirSync(h.skillsDir, { recursive: true });
			const outside = join(h.proposedDir, "..", "outside-skill");
			mkdirSync(outside, { recursive: true });
			symlinkSync(outside, join(h.skillsDir, "smoke-test"));
			await h.handle({ data: skillInstallData("dm:42", "smoke-test") });
			// The linked dir is untouched, the proposal still parked.
			expect(existsSync(join(h.proposedDir, "smoke-test", "SKILL.md"))).toBe(true);
			expect(h.edits[0]!.text).toContain("live skill is a symlink");
			expect(h.appends).toEqual([]);
		} finally {
			h.cleanup();
			done();
		}
	});

	test("a permission failure is not 'gone' — logged, buttons kept, proposal intact", async () => {
		const lines: Array<Record<string, unknown>> = [];
		const dir = mkdtempSync(join(tmpdir(), "skill-approval-logs-"));
		setLogFile(join(dir, "test.log"));
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		const h = harness(["smoke-test"]);
		try {
			// An unreadable parent makes the proposal's lstat throw EACCES —
			// real filesystem state, not absence. Nothing decides, nothing
			// moves, the error line carries it, and the tap answers with the
			// failure instead of a silent dead press.
			chmodSync(h.proposedDir, 0o000);
			await h.handle({ data: skillInstallData("dm:42", "smoke-test") });
			expect(h.strips).toEqual([]);
			expect(h.edits).toEqual([]);
			expect(h.appends).toEqual([]);
			expect(h.answers).toEqual(["internal error — nothing applied; check goblin logs"]);
			expect(lines.some((l) => l.msg === "skill approval handler failed")).toBe(true);
		} finally {
			chmodSync(h.proposedDir, 0o755);
			expect(existsSync(join(h.proposedDir, "smoke-test", "SKILL.md"))).toBe(true);
			h.cleanup();
			setLogFile(null);
			setLogWriter(null);
		}
	});

	test("a tap on a gone proposal answers and stamps the card, no history", async () => {
		const done = silenceLogs();
		const h = harness([]);
		try {
			await h.handle({ data: skillDiscardData("dm:42", "vanished") });
			// The header contract: "a tap on a gone proposal answers 'already
			// handled'" — a textless answer is a dead press from the operator's
			// side, and a bare button-strip leaves "approve to install" lying.
			expect(h.strips).toEqual([]);
			expect(h.edits.length).toBe(1);
			expect(h.edits[0]!.text).toContain("no longer exists");
			expect(h.edits[0]!.keyboard).toEqual({ inline_keyboard: [] });
			expect(h.answers).toEqual(["already handled — the proposal is gone, nothing applied"]);
			expect(h.appends).toEqual([]);
		} finally {
			h.cleanup();
			done();
		}
	});

	test("discard deletes the staged proposal", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"]);
		try {
			await h.handle({ data: skillDiscardData("dm:42", "smoke-test") });
			expect(existsSync(join(h.proposedDir, "smoke-test"))).toBe(false);
			expect(existsSync(join(h.skillsDir, "smoke-test"))).toBe(false);
			expect(h.edits[0]!.text).toBe("🚫 skill smoke-test discarded — proposal deleted.");
			expect(h.appends).toEqual([
				{
					conversationId: "dm:42",
					text: "skill proposal resolved: smoke-test — discarded (deleted)",
				},
			]);
		} finally {
			h.cleanup();
			done();
		}
	});

	test("garbage callback data answers and does nothing", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"]);
		try {
			await h.handle({ data: "skill:burn:dm:42:x" });
			expect(h.answers).toEqual(["unknown button"]);
			expect(existsSync(join(h.proposedDir, "smoke-test", "SKILL.md"))).toBe(true);
			expect(h.edits).toEqual([]);
		} finally {
			h.cleanup();
			done();
		}
	});

	test("a tap whose notice message is gone still decides on disk", async () => {
		const done = silenceLogs();
		const h = harness(["smoke-test"]);
		try {
			await h.handle({ data: skillInstallData("dm:42", "smoke-test"), message: null });
			expect(existsSync(join(h.skillsDir, "smoke-test", "SKILL.md"))).toBe(true);
			expect(h.edits).toEqual([]);
			expect(h.appends).toHaveLength(1);
		} finally {
			h.cleanup();
			done();
		}
	});
});
