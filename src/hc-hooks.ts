import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { durableWriteBytes } from "./durable.ts";
import { ensureDir } from "./home-layout.ts";
import { log } from "./log.ts";

export function installHcHooks(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const name of readdirSync(sourceDir).sort()) {
		const sourcePath = join(sourceDir, name);
		const targetPath = join(targetDir, name);
		const sourceStat = statSync(sourcePath);
		if (!sourceStat.isFile()) {
			throw new Error(`hc hook asset is not a regular file: ${sourcePath}`);
		}
		const source = readFileSync(sourcePath);
		let unchanged = false;
		try {
			const targetStat = statSync(targetPath);
			unchanged =
				targetStat.isFile() &&
				(targetStat.mode & 0o777) === 0o755 &&
				readFileSync(targetPath).equals(source);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (unchanged) continue;
		durableWriteBytes(targetPath, source, 0o755);
		chmodSync(targetPath, 0o755);
		log.info("hc hook asset installed", { name, path: targetPath });
	}
}
