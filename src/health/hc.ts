import { existsSync } from "node:fs";
import { join } from "node:path";
import { HcError, hcSessionForHome, hcSocketPath, makeHc } from "../hc.ts";
import { HC_PINS, hcBinaryState, type HcInstallPin } from "../hc-install.ts";
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
	pins: readonly [HcInstallPin, ...HcInstallPin[]] = HC_PINS,
): Promise<HealthResult> {
	const pinned = pins[0].version;
	const id = "delegation.hc";
	const scope = `caller-home:${home}`;
	if (!configured) return result(id, scope, "skip", "Delegation is not configured");
	const started = performance.now();
	try {
		// A record for another pin is history: the release changed the pin
		// after that failure, and the current pin has not been tried yet.
		const failed = lastSetupFailure(join(home, "state", "hc-setup-failure.json"));
		if (failed !== null && failed.version === pinned) {
			return result(
				id,
				scope,
				"fail",
				`The last delegate run ${failedSetupDetail[failed.stage]} ${failed.version} at ${failed.at}`,
				started,
				`Find "${failedSetupLog[failed.stage]}" in goblin.log; the next successful delegate run clears this record. Doctor does not install or start hc.`,
			);
		}
		const binary = hcBinaryState(join(home, "bin", "herdr-core"), pins);
		if (binary.kind === "missing") {
			return result(
				id,
				scope,
				"pass",
				`Pinned herdr-core ${pinned} is not installed yet; the first delegate run downloads and verifies it (download unverified)`,
				started,
			);
		}
		const binaryFailure: Record<
			Exclude<typeof binary.kind, "missing" | "pinned" | "retired-pin">,
			{ detail: string; next: string }
		> = {
			"wrong-hash": {
				detail: `herdr-core binary matches no known pin, current or retired (pinned ${pinned}): it may be corrupt or tampered`,
				next: "Inspect $GOBLIN_HOME/bin/herdr-core; doctor does not replace it",
			},
			"not-a-file": {
				detail: "herdr-core path is not a regular file",
				next: "Inspect $GOBLIN_HOME/bin/herdr-core; doctor does not replace it",
			},
			"not-executable": {
				detail: `Pinned herdr-core ${pinned} is not executable`,
				next: "Inspect $GOBLIN_HOME/bin/herdr-core permissions and its mount; doctor does not change them",
			},
		};
		if (binary.kind !== "pinned" && binary.kind !== "retired-pin") {
			const failure = binaryFailure[binary.kind];
			return result(
				id,
				scope,
				"fail",
				failure.detail,
				started,
				failure.next,
			);
		}
		const binaryDetail =
			binary.kind === "retired-pin"
				? `herdr-core ${binary.version} is a retired pin; the next delegate run replaces it with pinned ${pinned} (download unverified)`
				: `Pinned herdr-core ${pinned} verified`;
		const session = hcSessionForHome(home);
		if (!existsSync(hcSocketPath(session))) {
			return result(
				id,
				scope,
				"pass",
				`${binaryDetail}; core ${session} is not running and starts on the first delegate run (start unverified)`,
				started,
			);
		}
		try {
			const terminals = await makeHc(session).list();
			const reachable =
				binary.kind === "retired-pin"
					? `Core is reachable; ${terminals.length} terminals; ${binaryDetail}`
					: `Pinned core is reachable; ${terminals.length} terminals`;
			return result(id, scope, "pass", reachable, started);
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
