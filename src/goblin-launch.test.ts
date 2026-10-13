// deploy/desktop/goblin-launch — the in-image app whitelist. Drives
// the real shell script with stub `id`/`setpriv`/`chromium` binaries
// on PATH (the goblin-mail pattern) — no container, no real setpriv.
// What the stubs pin at the argv boundary: a root invocation must
// dispatch the app THROUGH setpriv to the fixed desk uid/gid with the
// fixed session env, a desk invocation dispatches directly with the
// same fixed env, any other caller is refused, and none of it may be
// steered by environment the caller injected (the desk-writable
// /run/desk/env file the script used to evaluate). The real
// privilege drop is live territory (GOBLIN_DESKTOP_LIVE); this is the
// stub-boundary regression.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "deploy", "desktop", "goblin-launch");

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// id answers -u/-un from the caller's FAKE_UID/FAKE_USER. setpriv only
// records its argv — it must never see the app spawn around it.
// chromium records the identity and env it actually got.
function stubs(dir: string): string {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "id"),
		'#!/bin/sh\ncase "$1" in\n\t-u) echo "${FAKE_UID:-0}" ;;\n\t-un) echo "${FAKE_USER:-root}" ;;\n\t*) echo "id stub: unexpected $*" >&2; exit 1 ;;\nesac\n',
		{ mode: 0o755 },
	);
	writeFileSync(join(bin, "setpriv"), '#!/bin/sh\nprintf "%s\\n" "$@" > "${STUB_LOG}.setpriv"\n', {
		mode: 0o755,
	});
	writeFileSync(
		join(bin, "chromium"),
		'#!/bin/sh\n{ printf "user=%s\\n" "$(id -un)"; printf "DISPLAY=%s\\n" "${DISPLAY:-unset}"; printf "DBUS=%s\\n" "${DBUS_SESSION_BUS_ADDRESS:-unset}"; printf "HOME=%s\\n" "${HOME:-unset}"; printf "XDG=%s\\n" "${XDG_RUNTIME_DIR:-unset}"; printf "argv=%s\\n" "$*"; } > "${STUB_LOG}.app"\n',
		{ mode: 0o755 },
	);
	return bin;
}

async function readWhenLanded(path: string, ms = 3000): Promise<string | null> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (existsSync(path)) return readFileSync(path, "utf8");
		await new Promise((r) => setTimeout(r, 20));
	}
	return null;
}

// The launcher's own environment is poisoned with attacker values —
// every assertion below expects the fixed constants, never these.
function run(
	args: string[],
	who: { uid: string; user: string },
): Promise<{ code: number; err: string; log: string }> {
	const dir = mkdtempSync(join(tmpdir(), "goblin-launch-"));
	dirs.push(dir);
	const bin = stubs(dir);
	const log = join(dir, "stub");
	const proc = Bun.spawn(["/bin/sh", SCRIPT, ...args], {
		env: {
			PATH: `${bin}:/usr/bin:/bin`,
			STUB_LOG: log,
			FAKE_UID: who.uid,
			FAKE_USER: who.user,
			DESK_USER: "mallory",
			DESK_HOME: "/tmp/evil",
			DISPLAY: ":666",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/evil-bus",
			HOME: "/tmp/evil",
			XDG_RUNTIME_DIR: "/tmp/evil",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return (async () => {
		const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		return { code, err, log };
	})();
}

describe("goblin-launch", () => {
	test("a root invocation detaches through setpriv to the fixed desk identity and session env", async () => {
		const { code, log } = await run(["chromium", "https://example.com/"], {
			uid: "0",
			user: "root",
		});
		expect(code).toBe(0);
		const argv = (await readWhenLanded(`${log}.setpriv`))!.trim().split("\n");
		expect(argv).toEqual([
			"--reuid=desk",
			"--regid=desk",
			"--clear-groups",
			"--reset-env",
			"env",
			"HOME=/home/desk",
			"DISPLAY=:99",
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/desk/bus",
			"XDG_RUNTIME_DIR=/home/desk/.runtime",
			"chromium",
			"--force-renderer-accessibility",
			"https://example.com/",
		]);
		// The app only ever spawns inside the setpriv boundary — the
		// poisoned DESK_USER/DISPLAY/HOME in the environment could not
		// retarget identity or session, and the script itself ran the
		// app nowhere outside that argv.
		expect(await readWhenLanded(`${log}.app`, 300)).toBeNull();
	});

	test("a desk invocation detaches the app directly with the same fixed session env", async () => {
		const { code, log } = await run(["chromium", "https://example.com/"], {
			uid: "1000",
			user: "desk",
		});
		expect(code).toBe(0);
		expect(await readWhenLanded(`${log}.setpriv`, 300)).toBeNull();
		const app = (await readWhenLanded(`${log}.app`))!;
		expect(app).toBe(
			[
				"user=desk",
				"DISPLAY=:99",
				"DBUS=unix:path=/run/desk/bus",
				"HOME=/home/desk",
				"XDG=/home/desk/.runtime",
				"argv=--force-renderer-accessibility https://example.com/",
				"",
			].join("\n"),
		);
	});

	test("a caller that is neither root nor desk is refused before any dispatch", async () => {
		const { code, err, log } = await run(["chromium"], {
			uid: "1000",
			user: "mallory",
		});
		expect(code).toBe(64);
		expect(err).toContain("refusing to detach");
		expect(await readWhenLanded(`${log}.setpriv`, 300)).toBeNull();
		expect(await readWhenLanded(`${log}.app`, 300)).toBeNull();
	});

	test("the whitelist still refuses non-url argv and unknown apps", async () => {
		for (const bad of [
			["chromium", "--user-data-dir=/tmp/x"],
			["chromium", "javascript:alert(1)"],
			["xterm"],
		]) {
			const { code, err, log } = await run(bad, { uid: "0", user: "root" });
			expect(code).toBe(64);
			expect(err).toContain("goblin-launch");
			expect(await readWhenLanded(`${log}.setpriv`, 300)).toBeNull();
		}
	});
});
