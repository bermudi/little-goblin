import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

const MAX_PID = 2_147_483_647;
const START_TICKS_FIELD = 19;

interface ProcessIdentity {
	pid: number;
	bootId: string;
	startTicks: string;
}

function parseLock(contents: string): ProcessIdentity | null {
	const fields = contents.trim().split(/\s+/);
	if (fields.length !== 3) return null;
	const pidText = fields[0];
	const bootId = fields[1];
	const startTicks = fields[2];
	if (
	pidText === undefined ||
		!/^[1-9]\d*$/.test(pidText) ||
		bootId === undefined ||
		bootId.length === 0 ||
		startTicks === undefined ||
		!/^\d+$/.test(startTicks)
	) {
		return null;
	}
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid > MAX_PID) return null;
	return { pid, bootId, startTicks };
}

function bootId(): string {
	const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	if (id.length === 0) throw new Error("kernel boot id is empty");
	return id;
}

function processStartTicks(pid: number): string | null {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const closeParen = stat.lastIndexOf(")");
	if (closeParen === -1) throw new Error(`malformed /proc/${pid}/stat`);
	const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
	const startTicks = fields[START_TICKS_FIELD];
	if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
		throw new Error(`missing start time in /proc/${pid}/stat`);
	}
	return startTicks;
}

function ownerIsAlive(identity: ProcessIdentity, currentBootId: string): boolean {
	try {
		process.kill(identity.pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (identity.bootId !== currentBootId) return false;
	return processStartTicks(identity.pid) === identity.startTicks;
}

function tryCreate(path: string, identity: ProcessIdentity): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o644);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		writeSync(fd, `${identity.pid} ${identity.bootId} ${identity.startTicks}\n`);
		fsyncSync(fd);
	} catch (err) {
		try {
			unlinkSync(path);
		} catch (cleanupErr) {
			if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupErr;
		}
		throw err;
	} finally {
		closeSync(fd);
	}
	return true;
}

export function acquireHomeLock(home: string): { release(): void } {
	const path = join(home, "state", "goblin.pid");
	const ownStartTicks = processStartTicks(process.pid);
	if (ownStartTicks === null) throw new Error(`cannot read start time for process ${process.pid}`);
	const ownIdentity: ProcessIdentity = {
		pid: process.pid,
		bootId: bootId(),
		startTicks: ownStartTicks,
	};
	if (tryCreate(path, ownIdentity)) return { release: () => releaseOwnedLock(path, ownIdentity) };

	let existing: ProcessIdentity | null = null;
	try {
		existing = parseLock(readFileSync(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	if (
		existing?.pid === ownIdentity.pid &&
		existing.bootId === ownIdentity.bootId &&
		existing.startTicks === ownIdentity.startTicks
	) {
		throw new Error(`goblin process (pid ${process.pid}) already owns ${home}`);
	}
	if (existing !== null && ownerIsAlive(existing, ownIdentity.bootId)) {
		throw new Error(`another goblin process (pid ${existing.pid}) owns ${home} — stop it first`);
	}

	log.warn("home lock stale — taking over", { pid: existing?.pid ?? null, home });
	try {
		unlinkSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (!tryCreate(path, ownIdentity)) throw new Error(`lost race taking home lock for ${home}`);
	return { release: () => releaseOwnedLock(path, ownIdentity) };
}

function releaseOwnedLock(path: string, identity: ProcessIdentity): void {
	let current: ProcessIdentity | null;
	try {
		current = parseLock(readFileSync(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	if (
		current?.pid === identity.pid &&
		current.bootId === identity.bootId &&
		current.startTicks === identity.startTicks
	) {
		unlinkSync(path);
	}
}
