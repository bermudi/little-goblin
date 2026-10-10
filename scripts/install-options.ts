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
		return executable && basename(executable) === "pass-keys" ? executable : undefined;
	};
	const keys = records.some((record) => passCommand(record.value) !== undefined);
	if (
		records.some((record) => {
			const executable = passCommand(record.value);
			return (
				executable !== undefined &&
				!/^ get goblin-dev [A-Za-z0-9_-]+$/.test(record.value.slice(1 + executable.length))
			);
		})
	) {
		throw new Error("unsupported-pass-profile");
	}
	process.stdout.write(
		JSON.stringify({ delegation: config.delegation !== undefined, keys, port: config.http.port }),
	);
} catch {
	process.stderr.write(
		"install: unable to inspect setup options — validate config/auth and use pass-keys get goblin-dev NAME with the shipped warmer\n",
	);
	process.exitCode = 1;
}
