import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface CheckoutIdentity {
	repo: string;
	commit: string;
	dirty: boolean;
}

export function matchesCheckout(
	recorded: CheckoutIdentity,
	current: CheckoutIdentity,
): boolean {
	return (
		recorded.repo === current.repo &&
		recorded.commit === current.commit &&
		recorded.dirty === current.dirty
	);
}

export function startupAction(
	recorded: CheckoutIdentity,
	current: CheckoutIdentity,
): "reuse" | "restart" {
	return matchesCheckout(recorded, current) ? "reuse" : "restart";
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export async function withNameLock<T>(
	path: string,
	run: () => Promise<T>,
	onWait: () => void,
): Promise<T> {
	let fd: number;
	for (;;) {
		const reaperPath = `${path}.reaper`;
		if (existsSync(reaperPath)) {
			onWait();
			await Bun.sleep(100);
			continue;
		}
		try {
			fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, `${process.pid}\n`);
			break;
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") {
				throw error;
			}
			onWait();
			if (existsSync(path)) {
				const owner = Number(readFileSync(path, "utf8").trim());
				if (Number.isSafeInteger(owner) && owner > 0 && !pidIsAlive(owner)) {
					let reaperFd: number;
					try {
						reaperFd = openSync(reaperPath, "wx", 0o600);
					} catch (reaperError) {
						if (
							typeof reaperError !== "object" ||
							reaperError === null ||
							!("code" in reaperError) ||
							reaperError.code !== "EEXIST"
						) {
							throw reaperError;
						}
						continue;
					}
					closeSync(reaperFd);
					try {
						const currentOwner = Number(readFileSync(path, "utf8").trim());
						if (currentOwner === owner && !pidIsAlive(currentOwner)) unlinkSync(path);
					} finally {
						unlinkSync(reaperPath);
					}
					continue;
				}
			}
			await Bun.sleep(100);
		}
	}
	closeSync(fd);
	try {
		return await run();
	} finally {
		try {
			const owner = Number(readFileSync(path, "utf8").trim());
			if (owner === process.pid) unlinkSync(path);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
		}
	}
}
