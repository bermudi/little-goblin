import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseAuthFile } from "../src/auth.ts";
import JSON5 from "json5";
import { parseConfig, paths } from "../src/config.ts";

try {
	const config = parseConfig(JSON5.parse(readFileSync(paths.config(), "utf8")) as unknown);
	const records = parseAuthFile(readFileSync(paths.auth(), "utf8"));
	const passCommand = (value: string): string | undefined => {
		if (!value.startsWith("!")) return undefined;
		const executable = value.slice(1).match(/^[^\s;&|()"'`]+/)?.[0];
		if (executable === undefined || basename(executable) !== "pass-keys") return undefined;
		// Basename only identifies pass-keys-looking commands — the
		// supported grammar is the literal shipped form, profile and
		// key shape included.
		if (!/^!pass-keys get goblin-dev [A-Z0-9_]{1,128}$/.test(value)) {
			throw new Error("unsupported-pass-command");
		}
		return executable;
	};
	// Evaluate every record before deriving keys — .some short-
	// circuits, so a refusal hiding behind a valid record must not
	// be skippable.
	const keys = records
		.map((record) => passCommand(record.value))
		.some((executable) => executable !== undefined);
	process.stdout.write(
		JSON.stringify({ delegation: config.delegation !== undefined, keys, port: config.http.port }),
	);
} catch {
	process.stderr.write(
		"install: unable to inspect setup options — validate config/auth and use pass-keys get goblin-dev NAME with the shipped warmer\n",
	);
	process.exitCode = 1;
}
