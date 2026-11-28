import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatPassRef, makePassLane, parsePassRef } from "./pass.ts";
import { tmpDir } from "./testkit.ts";

const PROFILE = "goblin-task";

const PASS_CLI = `#!/usr/bin/env bash
printf 'argv:' >> "$FAKE_STATE/pass-cli.log"; printf ' %s' "$@" >> "$FAKE_STATE/pass-cli.log"; printf '\\n' >> "$FAKE_STATE/pass-cli.log"
printf 'session=%s reason=%s passfoo=%s\\n' "\${PROTON_PASS_SESSION_DIR-unset}" "\${PROTON_PASS_AGENT_REASON-unset}" "\${PROTON_PASS_FOO-unset}" >> "$FAKE_STATE/env.log"
if [ "$1" = "info" ]; then
	if [ -f "$FAKE_STATE/session-ok" ]; then
		echo "Logged in as Personal Access Token [Agent] goblin-dev"
		exit 0
	fi
	echo "no session" >&2
	exit 1
fi
if [ "$1" = "item" ] && [ "$2" = "view" ]; then
	case "$3" in
		pass://S/I/password) printf 'FAKE-value\\n'; exit 0 ;;
		pass://S/I/twonl) printf 'FAKE-two\\n\\n'; exit 0 ;;
		pass://S/I/urls) printf 'https://example.com\\n'; exit 0 ;;
		*) echo "Field does not exist: \${3##*/}" >&2; exit 1 ;;
	esac
fi
exit 1
`;

const PASS_KEYS = `#!/usr/bin/env bash
printf 'argv:' >> "$FAKE_STATE/pass-keys.log"; printf ' %s' "$@" >> "$FAKE_STATE/pass-keys.log"; printf '\\n' >> "$FAKE_STATE/pass-keys.log"
if [ "$1" = "login" ]; then
	if [ -f "$FAKE_STATE/login-fails" ]; then
		echo "pass-keys: $2: agent login failed: fake" >&2
		exit 1
	fi
	touch "$FAKE_STATE/session-ok"
	echo "pass-keys: $2: agent session ready"
	exit 0
fi
exit 1
`;

function install(target: string, body: string): void {
	writeFileSync(target, body, { mode: 0o755 });
}

function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

const savedEnv = { FAKE_STATE: process.env.FAKE_STATE, PROTON_PASS_FOO: process.env.PROTON_PASS_FOO };
afterEach(() => {
	if (savedEnv.FAKE_STATE === undefined) delete process.env.FAKE_STATE;
	else process.env.FAKE_STATE = savedEnv.FAKE_STATE;
	if (savedEnv.PROTON_PASS_FOO === undefined) delete process.env.PROTON_PASS_FOO;
	else process.env.PROTON_PASS_FOO = savedEnv.PROTON_PASS_FOO;
});

function rig() {
	const home = tmpDir("pass-home-");
	const goblinHome = join(home, "goblin");
	const state = tmpDir("pass-fake-state-");
	mkdirSync(join(home, "bin"), { recursive: true });
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	install(join(home, "bin", "pass-cli"), PASS_CLI);
	install(join(home, ".local", "bin", "pass-keys"), PASS_KEYS);
	process.env.FAKE_STATE = state;
	const lane = makePassLane({ goblinHome, home, loginProfile: PROFILE });
	const sessionDir = join(goblinHome, "state", "pass-cli-task");
	return { home, goblinHome, state, lane, sessionDir };
}

const password = { vault: "S", item: "I", field: "password" };

describe("pass lane", () => {
	test("valid session reads the field without pass-keys and strips one trailing newline", async () => {
		const r = rig();
		writeFileSync(join(r.state, "session-ok"), "");
		expect(await r.lane.readField(password, "reason one")).toBe("FAKE-value");
		expect(await r.lane.readField({ ...password, field: "twonl" }, "reason two")).toBe("FAKE-two\n");
		expect(read(join(r.state, "pass-keys.log"))).toBe("");
	});

	test("expired session renews through pass-keys login once, then reads", async () => {
		const r = rig();
		expect(await r.lane.readField(password, "reason")).toBe("FAKE-value");
		expect(read(join(r.state, "pass-keys.log"))).toBe(`argv: login ${PROFILE}\n`);
	});

	test("a failed renewal surfaces the pass-keys stderr line", async () => {
		const r = rig();
		writeFileSync(join(r.state, "login-fails"), "");
		await expect(r.lane.readField(password, "reason")).rejects.toThrow("agent login failed: fake");
		expect(read(join(r.state, "pass-cli.log"))).not.toContain("item view");
	});

	test("concurrent reads on an expired session share one login", async () => {
		const r = rig();
		const values = await Promise.all([
			r.lane.readField(password, "a"),
			r.lane.readField(password, "b"),
			r.lane.readField(password, "c"),
		]);
		expect(values).toEqual(["FAKE-value", "FAKE-value", "FAKE-value"]);
		expect(read(join(r.state, "pass-keys.log"))).toBe(`argv: login ${PROFILE}\n`);
	});

	test("the child env is scrubbed, the session dir is set, and the reason rides item view", async () => {
		const r = rig();
		writeFileSync(join(r.state, "session-ok"), "");
		process.env.PROTON_PASS_FOO = "leak";
		expect(await r.lane.readField(password, "audit reason")).toBe("FAKE-value");
		const envLog = read(join(r.state, "env.log"));
		for (const line of envLog.trim().split("\n")) {
			expect(line).toContain("passfoo=unset");
		}
		expect(envLog).toContain(`session=${r.sessionDir} reason=unset`);
		expect(envLog).toContain(`session=${r.sessionDir} reason=audit reason`);
	});

	test("a session dir symlinked to the owner dir is refused before any spawn", async () => {
		const r = rig();
		const ownerDir = join(r.home, ".local", "share", "proton-pass-cli");
		mkdirSync(ownerDir, { recursive: true });
		mkdirSync(join(r.goblinHome, "state"), { recursive: true });
		symlinkSync(ownerDir, r.sessionDir);
		await expect(r.lane.readField(password, "reason")).rejects.toThrow("owner session dir");
		expect(read(join(r.state, "pass-cli.log"))).toBe("");
		expect(read(join(r.state, "pass-keys.log"))).toBe("");
	});
});

describe("parsePassRef", () => {
	test("accepts pass://VAULT/ITEM/FIELD and formats it back", () => {
		const ref = parsePassRef("pass://share-id/item-id/password");
		expect(ref).toEqual({ vault: "share-id", item: "item-id", field: "password" });
		expect(formatPassRef(ref!)).toBe("pass://share-id/item-id/password");
	});

	test.each([
		"pass://a/b",
		"pass://a/b/c/d",
		"pass://a/b/",
		"pass://a//c",
		"pass:///b/c",
		"pass://a/b/c?totp=uri",
		"pass://a/b/c#frag",
		"pass://a/b/c?x#f",
		"https://a/b/c",
		"pass://",
		"",
	])("rejects %s", (text) => {
		expect(parsePassRef(text)).toBeNull();
	});
});
