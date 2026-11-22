import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHc, hcBinaryState } from "./hc-install.ts";
import { useHome } from "./testkit.ts";

function makeArchive(script = "#!/bin/sh\nprintf 'hc-test\\n'\n"): { bytes: Uint8Array; binaryHash: string } {
	const root = useHome("goblin-hc-install-test-");
	const source = join(root, "source");
	mkdirSync(source, { recursive: true });
	const binary = join(source, "herdr-core");
	writeFileSync(binary, script, { mode: 0o755 });
	chmodSync(binary, 0o755);
	const archive = join(root, "archive.tar.gz");
	const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", source, "herdr-core"]);
	if (tar.exitCode !== 0) throw new Error("could not create test archive");
	return {
		bytes: readFileSync(archive),
		binaryHash: createHash("sha256").update(readFileSync(binary)).digest("hex"),
	};
}

test("ensureHc installs a pinned binary once and refuses a bad archive hash", async () => {
	const { bytes, binaryHash } = makeArchive();
	const home = useHome("goblin-hc-install-home-");
	const binaryPath = join(home, "bin", "herdr-core");
	const archiveHash = createHash("sha256").update(bytes).digest("hex");
	const pin = { version: "test", archiveSha256: archiveHash, binarySha256: binaryHash };
	let downloads = 0;
	const download = async (url: string): Promise<Uint8Array> => {
		expect(url).toBe("https://releases.herdr.dev/core/test/herdr-core-linux-x86_64.tar.gz");
		downloads += 1;
		return bytes;
	};

	expect(await ensureHc(binaryPath, { pin, download })).toBe(binaryPath);
	const mtime = statSync(binaryPath).mtimeMs;
	expect(existsSync(binaryPath)).toBe(true);
	expect(statSync(binaryPath).mode & 0o111).not.toBe(0);
	expect(await ensureHc(binaryPath, { pin, download })).toBe(binaryPath);
	expect(downloads).toBe(1);
	expect(statSync(binaryPath).mtimeMs).toBe(mtime);

	const badPath = join(home, "bad", "herdr-core");
	await expect(
		ensureHc(badPath, {
			pin: { ...pin, archiveSha256: "0".repeat(64) },
			download,
		}),
	).rejects.toThrow("archive hash mismatch");
	expect(existsSync(badPath)).toBe(false);
});

test("a retired pin's binary reads as retired and the next ensureHc replaces it", async () => {
	const home = useHome("goblin-hc-install-home-");
	const binaryPath = join(home, "bin", "herdr-core");
	const pinOf = (version: string, archive: { bytes: Uint8Array; binaryHash: string }) => ({
		version,
		archiveSha256: createHash("sha256").update(archive.bytes).digest("hex"),
		binarySha256: archive.binaryHash,
	});
	const oldArchive = makeArchive("#!/bin/sh\nprintf 'hc-old\\n'\n");
	const newArchive = makeArchive("#!/bin/sh\nprintf 'hc-new\\n'\n");
	const oldPin = pinOf("0.0.1", oldArchive);
	const newPin = pinOf("0.0.2", newArchive);

	await ensureHc(binaryPath, { pin: oldPin, download: async () => oldArchive.bytes });
	chmodSync(binaryPath, 0o644);
	expect(hcBinaryState(binaryPath, [newPin, oldPin])).toEqual({ kind: "retired-pin", version: "0.0.1" });
	expect(hcBinaryState(binaryPath, [newPin])).toEqual({ kind: "wrong-hash" });

	await ensureHc(binaryPath, { pin: newPin, download: async () => newArchive.bytes });
	expect(hcBinaryState(binaryPath, [newPin, oldPin])).toEqual({ kind: "pinned" });
	expect(Bun.spawnSync([binaryPath]).stdout.toString()).toBe("hc-new\n");
});
