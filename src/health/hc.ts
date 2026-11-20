import { existsSync } from "node:fs";
import { join } from "node:path";
import { HcError, hcSessionForHome, hcSocketPath, makeHc } from "../hc.ts";
import { HC_BINARY_SHA256, HC_VERSION, hcBinaryState } from "../hc-install.ts";
import { hcSetupFailureSchema, type HcSetupFailure } from "../hc-setup-failure.ts";
import { errno, failure, readBounded, result, type HealthResult } from "./shared.ts";

// Boot never touches hc and doctor never installs or starts it (#733,
// design/doctor.md), so "not installed" and "not running" are the ready
// state before a box's first delegate run; only evidence of breakage is red.

function lastSetupFailure(path: string): HcSetupFailure | null {
	let text: string;
	try {
		text = readBounded(path, 4096).text;
	} catch (error) {
		if (errno(error) === "ENOENT") return null;
		throw error;
	}
	return hcSetupFailureSchema.parse(JSON.parse(text));
}

const failedSetupDetail: Record<HcSetupFailure["stage"], string> = {
	install: "could not install pinned herdr-core",
	start: "could not start the hc core",
};
const failedSetupLog: Record<HcSetupFailure["stage"], string> = {
	install: "hc binary install failed",
	start: "hc core start failed",
};

export async function hcCore(
	home: string,
	configured: boolean,
	binarySha256: string = HC_BINARY_SHA256,
): Promise<HealthResult> {
	const id = "delegation.hc";
	const scope = `caller-home:${home}`;
	if (!configured) return result(id, scope, "skip", "Delegation is not configured");
	const started = performance.now();
	try {
		const failed = lastSetupFailure(join(home, "state", "hc-setup-failure.json"));
		if (failed !== null) {
			return result(
				id,
				scope,
				"fail",
				`The last delegate run ${failedSetupDetail[failed.stage]} ${failed.version} at ${failed.at}`,
				started,
				`Find "${failedSetupLog[failed.stage]}" in goblin.log; the next successful delegate run clears this record. Doctor does not install or start hc.`,
			);
		}
		const binary = hcBinaryState(join(home, "bin", "herdr-core"), binarySha256);
		if (binary === "missing") {
			return result(
				id,
				scope,
				"pass",
				`Pinned herdr-core ${HC_VERSION} is not installed yet; the first delegate run downloads and verifies it (download unverified)`,
				started,
			);
		}
		if (binary !== "pinned") {
			return result(
				id,
				scope,
				"fail",
				binary === "wrong-hash"
					? `herdr-core binary does not match the pinned ${HC_VERSION} hash`
					: "herdr-core path is not a regular file",
				started,
				"Inspect $GOBLIN_HOME/bin/herdr-core; doctor does not replace it",
			);
		}
		const session = hcSessionForHome(home);
		if (!existsSync(hcSocketPath(session))) {
			return result(
				id,
				scope,
				"pass",
				`Pinned herdr-core ${HC_VERSION} verified; core ${session} is not running and starts on the first delegate run (start unverified)`,
				started,
			);
		}
		try {
			const terminals = await makeHc(session).list();
			return result(id, scope, "pass", `Pinned core is reachable; ${terminals.length} terminals`, started);
		} catch (error) {
			if (error instanceof HcError && errno(error.cause) === "ECONNREFUSED") {
				return result(
					id,
					scope,
					"warn",
					`Core ${session} left its socket but refuses connections: it exited without stopping (crash or kill), and its terminals are gone`,
					started,
					"Inspect the core's exit in the user journal; the next delegate run starts a fresh core. Doctor does not start or stop it.",
				);
			}
			return result(
				id,
				scope,
				"fail",
				`Core ${session} is running but terminal.list failed: ${error instanceof HcError ? error.code : errno(error)}`,
				started,
				"Inspect the named hc session and runtime socket; doctor does not start or stop the core",
			);
		}
	} catch (error) {
		return failure(id, scope, error, started, "Inspect hc readiness");
	}
}
