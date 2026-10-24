import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLogFile, setLogWriter } from "./log.ts";
import {
	attachmentContentType,
	attachmentPath,
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	listPickerSkills,
	listSkillDir,
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
		expect(res.skills[0]!.truncated).toBe(false);
	});

	test("a tree past the file cap is flagged truncated — files and size are a floor", () => {
		writeRel("skills/fat/SKILL.md", "x");
		for (let i = 0; i < 210; i++) writeRel(`skills/fat/f${String(i).padStart(3, "0")}.md`, "x");
		// The skipped bytes live past the cap: counted files are "x", the
		// unlisted ones carry the payload.
		writeRel("skills/fat/zzz.md", "x".repeat(500));
		const res = listSkills(join(home, "skills"), join(home, "skills-proposed"));
		const fat = res.skills.find((s) => s.name === "fat")!;
		expect(fat.truncated).toBe(true);
		expect(fat.files.length).toBe(200);
	});

	test("a dir beyond the depth cap flags truncated even when never opened", () => {
		writeRel("skills/deep/a/b/c/d/file.md", "x");
		const res = listSkills(join(home, "skills"), join(home, "skills-proposed"));
		expect(res.skills[0]!.truncated).toBe(true);
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

	test("a skills path that is not a directory fails loud, not as an empty catalog", () => {
		// Only ENOENT means empty. ENOTDIR — a file squatting on the
		// path — must not render as a skill-less home.
		writeFileSync(join(home, "skills-file"), "x");
		expect(() => listSkillDir(join(home, "skills-file"))).toThrow(/ENOTDIR/);
	});

	test("a skill dir without SKILL.md still lists, stamped by the directory", () => {
		writeRel("skills/bare/notes.md", "x");
		const res = listSkillDir(join(home, "skills"));
		expect(res.length).toBe(1);
		expect(res[0]!.files).toEqual(["notes.md"]);
		expect(res[0]!.updatedAt).not.toBeNull();
	});

	// Mode-bit probes are meaningless for root — permission checks are
	// bypassed — so they only run for a real unprivileged user.
	test.skipIf(process.getuid?.() === 0)(
		"a non-searchable skill dir propagates the stat failure — never an empty render",
		() => {
			const skill = join(home, "skills", "locked");
			mkdirSync(skill, { recursive: true });
			writeFileSync(join(skill, "SKILL.md"), "x");
			chmodSync(skill, 0o400);
			try {
				expect(() => listSkillDir(join(home, "skills"))).toThrow(/EACCES/);
			} finally {
				chmodSync(skill, 0o700);
			}
		},
	);

	test.skipIf(process.getuid?.() === 0)(
		"an empty non-searchable skill dir propagates the SKILL.md stat failure",
		() => {
			const skill = join(home, "skills", "locked");
			mkdirSync(skill, { recursive: true });
			chmodSync(skill, 0o400);
			try {
				expect(() => listSkillDir(join(home, "skills"))).toThrow(/EACCES/);
			} finally {
				chmodSync(skill, 0o700);
			}
		},
	);
});

describe("listPickerSkills", () => {
	test("rows carry the real SKILL.md size, manual-only included", () => {
		writeRel("skills/tiny/SKILL.md", "---\nname: tiny\ndescription: t\n---\nx");
		writeRel(
			"skills/secret/SKILL.md",
			`---\nname: secret\ndescription: s\ndisable-model-invocation: true\n---\n${"y".repeat(100)}`,
		);
		const items = listPickerSkills(join(home, "skills"));
		const byName = new Map(items.map((i) => [i.name, i]));
		expect(byName.get("tiny")?.bodyBytes).toBe(
			statSync(join(home, "skills", "tiny", "SKILL.md")).size,
		);
		expect(byName.get("secret")?.manualOnly).toBe(true);
	});

	// The race between the catalog scan and the picker's per-row stat
	// can't interpose inside a synchronous call — except through the
	// catalog's own post-scan signal: past MAX_ENTRIES it warns "skill
	// catalog capped" after reading every SKILL.md, before the picker
	// stats one. The designed log-writer seam fires the mutation there.
	function cappedCatalog(mutate: (victimDir: string) => void): () => void {
		const skills = join(home, "skills");
		mkdirSync(join(skills, "a0victim"), { recursive: true });
		writeFileSync(
			join(skills, "a0victim", "SKILL.md"),
			"---\nname: a0victim\ndescription: gone soon\n---\nbody",
		);
		for (let i = 0; i < 129; i++) {
			const name = `filler-${String(i).padStart(3, "0")}`;
			mkdirSync(join(skills, name), { recursive: true });
			writeFileSync(
				join(skills, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: f\n---\nx`,
			);
		}
		setLogFile(join(home, "test.log"));
		setLogWriter((_path, line) => {
			if (line.includes('"skill catalog capped"')) mutate(join(skills, "a0victim"));
		});
		return () => {
			setLogFile(null);
			setLogWriter(null);
		};
	}

	test("a skill that vanishes between scan and stat is omitted, not zero-sized", () => {
		const undo = cappedCatalog((dir) => rmSync(dir, { recursive: true, force: true }));
		try {
			const items = listPickerSkills(join(home, "skills"));
			expect(items.some((i) => i.name === "a0victim")).toBe(false);
			expect(items.length).toBe(127);
			expect(items.every((i) => i.bodyBytes > 0)).toBe(true);
		} finally {
			undo();
		}
	});

	test("a non-ENOENT stat failure propagates — never a synthesized 0 B row", () => {
		const undo = cappedCatalog((dir) => {
			rmSync(dir, { recursive: true, force: true });
			writeFileSync(dir, "occupied");
		});
		try {
			expect(() => listPickerSkills(join(home, "skills"))).toThrow(/ENOTDIR/);
		} finally {
			undo();
		}
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

	test("a double-dot substring is an ordinary name; exact dot segments are refused", () => {
		writeRel("skills/v1..beta/SKILL.md", "installed");
		writeRel("skills/a/ref/file..name.md", "dots");
		const skills = join(home, "skills");
		const proposed = join(home, "skills-proposed");
		expect(readSkillFile(skills, proposed, "skills", "v1..beta", "SKILL.md")?.content).toBe(
			"installed",
		);
		expect(readSkillFile(skills, proposed, "skills", "a", "ref/file..name.md")?.content).toBe(
			"dots",
		);
		expect(readSkillFile(skills, proposed, "skills", ".", "SKILL.md")).toBeNull();
		expect(readSkillFile(skills, proposed, "skills", "..", "SKILL.md")).toBeNull();
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

	test("upload temps (dotfiles) are not listed", () => {
		const now = new Date("2026-10-03T10:00:00Z");
		writeRel("attachments/.app-uuid.tmp", "partial", now);
		writeRel("attachments/settled.png", "a", now);
		const res = listAttachments(join(home, "attachments"));
		expect(res.files.map((f) => f.name)).toEqual(["settled.png"]);
	});

	test("interior dots are ordinary; a leading dot is an upload temp and refuses", () => {
		writeRel("attachments/file..name.txt", "x");
		writeRel("attachments/.app-uuid.tmp", "partial");
		expect(attachmentPath(join(home, "attachments"), "file..name.txt")).not.toBeNull();
		// persistAttachment stages uploads as dotfile temps — never served.
		expect(attachmentPath(join(home, "attachments"), ".app-uuid.tmp")).toBeNull();
		expect(readAttachmentBytes(join(home, "attachments"), ".app-uuid.tmp", 1024)).toBeNull();
		expect(attachmentPath(join(home, "attachments"), ".")).toBeNull();
		expect(attachmentPath(join(home, "attachments"), "..")).toBeNull();
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
		// Filtering is intentional selection, not dropped content.
		expect(tailLog(f, { limit: 10, level: "error" }).truncated).toBe(false);
		expect(tailLog(f, { limit: 10, q: "dm:2" }).truncated).toBe(false);
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

	test("a torn line inside the window is skipped and reported as truncation", () => {
		const f = writeLog([
			JSON.stringify({ ts: "t1", level: "info", msg: "before" }),
			'{"ts":"t2","level":"info","msg":"torn by a cra',
			JSON.stringify({ ts: "t3", level: "info", msg: "after" }),
		]);
		const res = tailLog(f, { limit: 10 });
		expect(res.lines.map((l) => l.msg)).toEqual(["before", "after"]);
		// An unparseable line is a gap the caller has to know about.
		expect(res.truncated).toBe(true);
	});

	test("a window cut drops the partial first line and reports it", () => {
		const pad = "x".repeat(400);
		const f = writeLog([
			JSON.stringify({ ts: "t0", level: "info", msg: pad }),
			JSON.stringify({ ts: "t1", level: "info", msg: "kept" }),
		]);
		// Window starts inside the first line — its head is outside the scan.
		const res = tailLog(f, { limit: 10, windowBytes: 200 });
		expect(res.lines.map((l) => l.msg)).toEqual(["kept"]);
		expect(res.truncated).toBe(true);
	});

	test("malformed lines are skipped, not fatal — and reported as truncation", () => {
		const f = writeLog(["{torn write", JSON.stringify({ ts: "t1", level: "info", msg: "ok" })]);
		const res = tailLog(f, { limit: 10 });
		expect(res.lines.map((l) => l.msg)).toEqual(["ok"]);
		expect(res.truncated).toBe(true);
	});

	test("torn and non-object records count even when the filter would skip them", () => {
		const f = writeLog([
			"{torn write",
			"42",
			JSON.stringify({ ts: "t1", level: "info", msg: "kept", tag: "wanted" }),
		]);
		const res = tailLog(f, { limit: 10, q: "wanted" });
		expect(res.lines.map((l) => l.msg)).toEqual(["kept"]);
	});

	test("a non-object JSON line also reads as truncation", () => {
		const f = writeLog(["42", JSON.stringify({ ts: "t1", level: "info", msg: "ok" })]);
		const res = tailLog(f, { limit: 10 });
		expect(res.lines.map((l) => l.msg)).toEqual(["ok"]);
		expect(res.truncated).toBe(true);
	});

	test("missing log file is an empty view", () => {
		const res = tailLog(join(home, "absent.log"), { limit: 10 });
		expect(res.lines).toEqual([]);
		expect(res.truncated).toBe(false);
		expect(res.scannedBytes).toBe(0);
	});
});
