// Boundary tests for the state viewer: the containment wall (a resolved
// path must stay under its base), the ENOENT-means-empty rule, and the
// log tail's window/filter/limit mechanics. The zod layer at the router
// is input hygiene; these tests hold the module alone.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	attachmentContentType,
	attachmentPath,
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	listSkills,
	readAttachmentBytes,
	readSkillFile,
	readStateFile,
	tailLog,
} from "./stateview.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "stateview-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeRel(rel: string, content: string, mtime?: Date): string {
	const full = join(home, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	if (mtime !== undefined) utimesSync(full, mtime, mtime);
	return full;
}

describe("listSkills", () => {
	test("lists installed and proposed skills, SKILL.md first", () => {
		writeRel("skills/weather/SKILL.md", "---\ndescription: weather\n---\nbody");
		writeRel("skills/weather/extra.md", "x");
		writeRel("skills-proposed/talk-first/SKILL.md", "draft");
		const res = listSkills(join(home, "skills"), join(home, "skills-proposed"));
		expect(res.skills.length).toBe(1);
		expect(res.skills[0]!.name).toBe("weather");
		expect(res.skills[0]!.files).toEqual(["SKILL.md", "extra.md"]);
		expect(res.skills[0]!.sizeBytes).toBeGreaterThan(0);
		expect(res.skills[0]!.updatedAt).not.toBeNull();
		expect(res.proposed.map((s) => s.name)).toEqual(["talk-first"]);
	});

	test("nested files are listed within the depth/file bounds", () => {
		writeRel("skills/deep/a/b/c.md", "nested");
		const res = listSkills(join(home, "skills"), join(home, "skills-proposed"));
		expect(res.skills[0]!.files).toEqual(["a/b/c.md"]);
	});

	test("every listed path can be read unchanged under its skill", () => {
		writeRel("skills/weather/SKILL.md", "installed");
		writeRel("skills/weather/ref/example.md", "nested");
		writeRel("skills-proposed/draft/SKILL.md", "proposed");
		const skills = join(home, "skills");
		const proposed = join(home, "skills-proposed");
		const catalog = listSkills(skills, proposed);
		for (const origin of ["skills", "proposed"] as const) {
			for (const skill of catalog[origin]) {
				for (const path of skill.files) {
					const file = readSkillFile(skills, proposed, origin, skill.name, path);
					expect(file).not.toBeNull();
					expect(file?.content ?? null).toBe(
						readStateFile(join(origin === "skills" ? skills : proposed, skill.name), path),
					);
				}
			}
		}
	});

	test("missing directories render as empty, not an error", () => {
		const res = listSkills(join(home, "nope"), join(home, "also-nope"));
		expect(res.skills).toEqual([]);
		expect(res.proposed).toEqual([]);
	});
});

describe("readStateFile containment", () => {
	beforeEach(() => {
		writeRel("skills/weather/SKILL.md", "body");
		writeRel("skills/weather/ref/example.md", "referenced");
		writeRel("secret.txt", "top secret");
	});

	test("reads files inside the base, nested included", () => {
		expect(readStateFile(join(home, "skills/weather"), "SKILL.md")).toBe("body");
		expect(readStateFile(join(home, "skills/weather"), "ref/example.md")).toBe("referenced");
	});

	test("climbing out is refused", () => {
		expect(readStateFile(join(home, "skills/weather"), "../secret.txt")).toBeNull();
		expect(readStateFile(join(home, "skills/weather"), "..//secret.txt")).toBeNull();
		// An absolute path must not escape the join either.
		expect(readStateFile(join(home, "skills/weather"), "/secret.txt")).toBeNull();
	});

	test("missing file and directories are null, other errors propagate", () => {
		expect(readStateFile(join(home, "skills/weather"), "nope.md")).toBeNull();
		expect(readStateFile(join(home, "nope"), "SKILL.md")).toBeNull();
		expect(readStateFile(join(home, "skills"), "weather")).toBeNull(); // a directory
	});

	test("an over-cap file throws instead of truncating", () => {
		writeRel("skills/weather/huge.md", "x".repeat(3 * 1024 * 1024));
		expect(() => readStateFile(join(home, "skills/weather"), "huge.md")).toThrow(/file too large/);
	});

	test("symlink indirection is refused — file, parent dir, and dangling", () => {
		symlinkSync(join(home, "secret.txt"), join(home, "skills/weather/link.md"));
		expect(readStateFile(join(home, "skills/weather"), "link.md")).toBeNull();
		// A linked parent is the case an lstat on the final component
		// misses: the walk goes through the link and lands outside base.
		// (A link that resolves back INSIDE base serves — the bytes stay
		// in the tree, which is the property realpath containment holds.)
		symlinkSync(home, join(home, "skills/weather/up"));
		expect(readStateFile(join(home, "skills/weather"), "up/secret.txt")).toBeNull();
		symlinkSync(join(home, "absent-target"), join(home, "skills/weather/dangling.md"));
		expect(readStateFile(join(home, "skills/weather"), "dangling.md")).toBeNull();
	});

	test("symlinked skill dirs don't list", () => {
		mkdirSync(join(home, "skills-proposed"), { recursive: true });
		symlinkSync(join(home, "skills/weather"), join(home, "skills-proposed/linked"));
		const res = listSkills(join(home, "skills"), join(home, "skills-proposed"));
		expect(res.proposed).toEqual([]);
	});
});

describe("readSkillFile", () => {
	test("a linked skill directory cannot become the trusted base", () => {
		writeRel("outside/SKILL.md", "synthetic outside marker");
		writeRel("skills/weather/SKILL.md", "installed");
		mkdirSync(join(home, "skills-proposed"), { recursive: true });
		for (const origin of ["skills", "proposed"] as const) {
			const dir = join(home, origin === "skills" ? "skills" : "skills-proposed");
			symlinkSync(join(home, "outside"), join(dir, "outside-link"));
			symlinkSync(join(home, "skills/weather"), join(dir, "inside-link"));
			symlinkSync(join(home, "missing"), join(dir, "dangling-link"));
			for (const name of ["outside-link", "inside-link", "dangling-link"]) {
				expect(
					readSkillFile(
						join(home, "skills"),
						join(home, "skills-proposed"),
						origin,
						name,
						"SKILL.md",
					),
				).toBeNull();
			}
		}
	});

	test("an in-skill file link can serve, but cross-skill links cannot", () => {
		writeRel("skills/weather/SKILL.md", "installed");
		writeRel("skills/other/SKILL.md", "other");
		symlinkSync(join(home, "skills/weather/SKILL.md"), join(home, "skills/weather/local.md"));
		symlinkSync(join(home, "skills/other/SKILL.md"), join(home, "skills/weather/other.md"));
		const skills = join(home, "skills");
		const proposed = join(home, "skills-proposed");
		expect(readSkillFile(skills, proposed, "skills", "weather", "local.md")?.content).toBe(
			"installed",
		);
		expect(readSkillFile(skills, proposed, "skills", "weather", "other.md")).toBeNull();
	});

	test("defaults to SKILL.md and resolves the origin dir", () => {
		writeRel("skills/a/SKILL.md", "installed");
		writeRel("skills-proposed/b/SKILL.md", "draft");
		expect(
			readSkillFile(join(home, "skills"), join(home, "skills-proposed"), "skills", "a", "SKILL.md")
				?.content,
		).toBe("installed");
		expect(
			readSkillFile(
				join(home, "skills"),
				join(home, "skills-proposed"),
				"proposed",
				"b",
				"SKILL.md",
			)?.content,
		).toBe("draft");
		expect(
			readSkillFile(join(home, "skills"), join(home, "skills-proposed"), "skills", "a", "SKILL.md")
				?.path,
		).toBe("a/SKILL.md");
	});

	test("a name that is not one segment is refused", () => {
		writeRel("skills/a/SKILL.md", "x");
		expect(
			readSkillFile(
				join(home, "skills"),
				join(home, "skills-proposed"),
				"skills",
				"../a",
				"SKILL.md",
			),
		).toBeNull();
		expect(
			readSkillFile(
				join(home, "skills"),
				join(home, "skills-proposed"),
				"skills",
				"a/../../x",
				"SKILL.md",
			),
		).toBeNull();
	});
});

describe("attachments", () => {
	test("lists files newest first", () => {
		const old = new Date("2026-10-01T10:00:00Z");
		const newer = new Date("2026-10-02T10:00:00Z");
		writeRel("attachments/old.png", "a", old);
		writeRel("attachments/newer.ogg", "bb", newer);
		const res = listAttachments(join(home, "attachments"));
		expect(res.files.map((f) => f.name)).toEqual(["newer.ogg", "old.png"]);
		expect(res.files[0]!.sizeBytes).toBe(2);
	});

	test("a symlinked attachment is refused, not followed", () => {
		writeRel("attachments/.keep", "");
		writeRel("secret.txt", "outside");
		symlinkSync(join(home, "secret.txt"), join(home, "attachments/evil.png"));
		expect(attachmentPath(join(home, "attachments"), "evil.png")).toBeNull();
		expect(readAttachmentBytes(join(home, "attachments"), "evil.png", 1024)).toBeNull();
	});

	test("readAttachmentBytes caps and reports the type", () => {
		writeRel("attachments/big.bin", "x".repeat(16));
		expect(() => readAttachmentBytes(join(home, "attachments"), "big.bin", 8)).toThrow(
			AttachmentTooLargeError,
		);
		const ok = readAttachmentBytes(join(home, "attachments"), "big.bin", 1024);
		expect(ok?.bytes.length).toBe(16);
		expect(ok?.contentType).toBe("application/octet-stream");
	});

	test("attachmentPath holds the wall", () => {
		writeRel("attachments/ok.png", "a");
		expect(attachmentPath(join(home, "attachments"), "ok.png")).toBe(
			join(home, "attachments/ok.png"),
		);
		expect(attachmentPath(join(home, "attachments"), "sub/ok.png")).toBeNull();
		expect(attachmentPath(join(home, "attachments"), "../secret.txt")).toBeNull();
		expect(attachmentPath(join(home, "attachments"), "missing.png")).toBeNull();
	});

	test("content types cover the media goblin actually stores", () => {
		expect(attachmentContentType("voice-1.ogg")).toBe("audio/ogg");
		expect(attachmentContentType("photo.JPG")).toBe("image/jpeg");
		expect(attachmentContentType("bundle.zip")).toBe("application/zip");
		expect(attachmentContentType("mystery.bin")).toBe("application/octet-stream");
	});
});

describe("identityFiles", () => {
	test("present files carry content, missing ones null", () => {
		writeRel("workspace/SOUL.md", "# soul");
		const res = identityFiles(join(home, "workspace"));
		const byName = new Map(res.files.map((f) => [f.name, f.content]));
		expect(byName.get("SOUL.md")).toBe("# soul");
		expect(byName.get("USER.md")).toBeNull();
		expect(byName.get("AGENTS.md")).toBeNull();
	});
});

describe("tailLog", () => {
	function writeLog(lines: string[]): string {
		const full = join(home, "goblin.log");
		writeFileSync(full, lines.join("\n") + "\n");
		return full;
	}

	test("parses records and keeps file order, newest last", () => {
		const f = writeLog([
			JSON.stringify({ ts: "2026-10-11T10:00:00Z", level: "info", msg: "first" }),
			JSON.stringify({ ts: "2026-10-11T10:01:00Z", level: "error", msg: "boom", chat: 7 }),
		]);
		const res = tailLog(f, { limit: 10 });
		expect(res.truncated).toBe(false);
		expect(res.lines.length).toBe(2);
		expect(res.lines[1]!.level).toBe("error");
		expect(res.lines[1]!.msg).toBe("boom");
		expect(res.lines[1]!.line).toContain('"chat":7');
	});

	test("level and substring filters apply to the raw line", () => {
		const f = writeLog([
			JSON.stringify({ ts: "t1", level: "info", msg: "send ok", conversation: "dm:1" }),
			JSON.stringify({ ts: "t2", level: "warn", msg: "slow", conversation: "dm:2" }),
			JSON.stringify({ ts: "t3", level: "error", msg: "send failed", conversation: "dm:1" }),
		]);
		expect(tailLog(f, { limit: 10, level: "error" }).lines.length).toBe(1);
		expect(tailLog(f, { limit: 10, q: "dm:2" }).lines.length).toBe(1);
		expect(tailLog(f, { limit: 10, q: "dm:1", level: "error" }).lines[0]!.msg).toBe("send failed");
	});

	test("limit keeps the newest matches and reports truncation", () => {
		const f = writeLog([
			JSON.stringify({ ts: "t1", level: "info", msg: "a" }),
			JSON.stringify({ ts: "t2", level: "info", msg: "b" }),
			JSON.stringify({ ts: "t3", level: "info", msg: "c" }),
		]);
		const res = tailLog(f, { limit: 2 });
		expect(res.lines.map((l) => l.msg)).toEqual(["b", "c"]);
		expect(res.truncated).toBe(true);
	});

	test("a window cut drops the partial first line and reports it", () => {
		const pad = "x".repeat(400);
		const f = writeLog([
			JSON.stringify({ ts: "t0", level: "info", msg: pad }),
			JSON.stringify({ ts: "t1", level: "info", msg: "kept" }),
		]);
		// Window starts inside the first line — its head is outside.
		const res = tailLog(f, { limit: 10, windowBytes: 200 });
		expect(res.lines.map((l) => l.msg)).toEqual(["kept"]);
		expect(res.truncated).toBe(true);
	});

	test("malformed lines are skipped, not fatal", () => {
		const f = writeLog(["{torn write", JSON.stringify({ ts: "t1", level: "info", msg: "ok" })]);
		const res = tailLog(f, { limit: 10 });
		expect(res.lines.map((l) => l.msg)).toEqual(["ok"]);
	});

	test("missing log file is an empty view", () => {
		const res = tailLog(join(home, "absent.log"), { limit: 10 });
		expect(res.lines).toEqual([]);
		expect(res.truncated).toBe(false);
		expect(res.scannedBytes).toBe(0);
	});
});
