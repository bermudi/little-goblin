import { readFileSync } from "node:fs";
import { parseAuthFile } from "../src/auth.ts";
import JSON5 from "json5";
import { parseConfig, paths } from "../src/config.ts";

try {
	const config = parseConfig(JSON5.parse(readFileSync(paths.config(), "utf8")) as unknown);
	const records = parseAuthFile(readFileSync(paths.auth(), "utf8"));
	const isPassCommand = (value: string): boolean =>
		/^!(?:\/[A-Za-z0-9_.+-]+\/)*pass-keys(?:\s|$)/.test(value);
	const keys = records.some((record) => isPassCommand(record.value));
	if (
		records.some(
			(record) =>
				isPassCommand(record.value) &&
				!/^!pass-keys get goblin-dev [A-Za-z0-9_-]+$/.test(record.value),
		)
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
