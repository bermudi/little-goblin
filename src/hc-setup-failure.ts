import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "./durable.ts";
import { HC_VERSION } from "./hc-install.ts";
import { log } from "./log.ts";

// A failed install or core start leaves nothing else on disk: the install
// stage is removed and the core never binds its socket. Doctor reads this
// record to tell "never ran" from "last setup failed" without running hc.
export const hcSetupFailureSchema = z.object({
	stage: z.enum(["install", "start"]),
	version: z.string(),
	at: z.iso.datetime(),
});
export type HcSetupFailure = z.infer<typeof hcSetupFailureSchema>;

export function failHcSetup(
	path: string,
	stage: HcSetupFailure["stage"],
	cause: unknown,
	now = Date.now(),
): never {
	const record: HcSetupFailure = { stage, version: HC_VERSION, at: new Date(now).toISOString() };
	try {
		mkdirSync(dirname(path), { recursive: true });
		durableWriteFile(path, `${JSON.stringify(record)}\n`, 0o600);
	} catch (writeError) {
		throw new AggregateError([cause, writeError], `hc ${stage} failed and its failure record could not be written`);
	}
	log.warn("hc setup failure recorded", { path, ...record });
	throw cause;
}

export function clearHcSetupFailure(path: string): void {
	if (!existsSync(path)) return;
	rmSync(path);
	log.info("hc setup failure cleared", { path });
}
