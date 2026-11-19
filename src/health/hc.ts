import { join } from "node:path";
import { hcSessionForHome, makeHc } from "../hc.ts";
import { isPinnedHcBinary } from "../hc-install.ts";
import { failure, result, type HealthResult } from "./shared.ts";

export async function hcCore(home: string, configured: boolean): Promise<HealthResult> {
	const scope = `caller-home:${home}`;
	if (!configured) return result("delegation.hc", scope, "skip", "Delegation is not configured");
	const binary = join(home, "bin", "herdr-core");
	if (!isPinnedHcBinary(binary)) {
		return result("delegation.hc", scope, "fail", "Pinned herdr-core binary is missing or has the wrong hash");
	}
	const started = performance.now();
	try {
		const terminals = await makeHc(hcSessionForHome(home)).list();
		return result("delegation.hc", scope, "pass", `Pinned core is reachable; ${terminals.length} terminals`, started);
	} catch (error) {
		return failure("delegation.hc", scope, error, started, "Inspect the named hc session and runtime socket; doctor does not start or stop the core");
	}
}
