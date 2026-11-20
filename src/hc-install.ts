import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { durableCopyFile } from "./durable.ts";
import { log } from "./log.ts";

export const HC_VERSION = "0.1.21";
export const HC_ARCHIVE_SHA256 =
	"78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1";
export const HC_BINARY_SHA256 =
	"373f1ac70bf78c14e898c3682caafd3fb8b07d39c7f21637a57922e064c7bcba";
const BINARY_NAME = "herdr-core";

export interface HcInstallPin {
	version: string;
	archiveSha256: string;
	binarySha256: string;
}

interface EnsureHcOptions {
	pin?: HcInstallPin;
	download?: (url: string) => Promise<Uint8Array>;
}

const productionPin: HcInstallPin = {
	version: HC_VERSION,
	archiveSha256: HC_ARCHIVE_SHA256,
	binarySha256: HC_BINARY_SHA256,
};

async function downloadArchive(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: "error" });
	if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fileSha256(path: string): string {
	return sha256(readFileSync(path));
}

function runTar(args: string[], cwd?: string): string {
	const result = Bun.spawnSync(["tar", ...args], {
		...(cwd === undefined ? {} : { cwd }),
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) throw new Error("tar failed to inspect or extract the pinned archive");
	return result.stdout.toString("utf8");
}

export async function ensureHc(
	binaryPath: string,
	options: EnsureHcOptions = {},
): Promise<string> {
	const pin = options.pin ?? productionPin;
	const download = options.download ?? downloadArchive;
	const archiveUrl = hcArchiveUrl(pin);
	if (existsSync(binaryPath)) {
		const stat = statSync(binaryPath);
		if (!stat.isFile()) throw new Error(`pinned hc path is not a regular file: ${binaryPath}`);
		if (fileSha256(binaryPath) === pin.binarySha256) {
			log.info("hc binary ready", { path: binaryPath, version: pin.version, outcome: "already-installed" });
			return binaryPath;
		}
	}

	const parent = dirname(binaryPath);
	mkdirSync(parent, { recursive: true, mode: 0o755 });
	const stage = mkdtempSync(join(parent, `.hc-install-${process.pid}-`));
	const archivePath = join(stage, "herdr-core.tar.gz");
	const extractedPath = join(stage, BINARY_NAME);
	const started = performance.now();
	try {
		log.info("hc binary download started", { version: pin.version, url: archiveUrl });
		let archive: Uint8Array;
		try {
			archive = await download(archiveUrl);
		} catch (err) {
			log.error("hc binary download failed", err, { version: pin.version });
			throw new Error(`could not download pinned hc ${pin.version}`, { cause: err });
		}
		const archiveHash = sha256(archive);
		if (archiveHash !== pin.archiveSha256) {
			log.error("hc archive hash mismatch", new Error("pinned hash mismatch"), {
				version: pin.version,
				expected: pin.archiveSha256,
				actual: archiveHash,
			});
			throw new Error(`pinned hc archive hash mismatch for version ${pin.version}`);
		}
		await Bun.write(archivePath, archive);
		const members = runTar(["-tzf", archivePath])
			.split("\n")
			.filter((member) => member.length > 0);
		const allowedMembers = new Set([BINARY_NAME, "LICENSE", "THIRD-PARTY-NOTICES"]);
		if (!members.includes(BINARY_NAME) || members.some((member) => !allowedMembers.has(member))) {
			throw new Error("pinned hc archive has unexpected members");
		}
		runTar(["-xzf", archivePath, "-C", stage, "--no-same-owner", "--no-same-permissions", "--", BINARY_NAME]);
		if (!existsSync(extractedPath) || !statSync(extractedPath).isFile()) {
			throw new Error("pinned hc archive did not contain a regular herdr-core binary");
		}
		const binaryHash = fileSha256(extractedPath);
		if (binaryHash !== pin.binarySha256) {
			throw new Error(`pinned hc binary hash mismatch for version ${pin.version}`);
		}
		chmodSync(extractedPath, 0o755);
		durableCopyFile(extractedPath, binaryPath);
		chmodSync(binaryPath, 0o755);
		log.info("hc binary installed", {
			path: binaryPath,
			version: pin.version,
			ms: Math.round(performance.now() - started),
			outcome: "ok",
		});
		return binaryPath;
	} catch (err) {
		log.error("hc binary install failed", err, {
			version: pin.version,
			path: binaryPath,
			ms: Math.round(performance.now() - started),
		});
		throw err;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export type HcBinaryState = "missing" | "pinned" | "wrong-hash" | "not-a-file" | "not-executable";

export function hcBinaryState(
	binaryPath: string,
	binarySha256: string = productionPin.binarySha256,
): HcBinaryState {
	if (!existsSync(binaryPath)) return "missing";
	if (!statSync(binaryPath).isFile()) return "not-a-file";
	if (fileSha256(binaryPath) !== binarySha256) return "wrong-hash";
	try {
		accessSync(binaryPath, constants.X_OK);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EACCES") return "not-executable";
		throw error;
	}
	return "pinned";
}

export function hcArchiveUrl(pin: HcInstallPin = productionPin): string {
	return `https://releases.herdr.dev/core/${pin.version}/herdr-core-linux-x86_64.tar.gz`;
}
