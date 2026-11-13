import type { Config } from "../config.ts";
import { command, errno, ProbeError, result, type HealthResult, type ProbeContext } from "./shared.ts";

// The configured sandbox block's engine readiness: podman must answer
// and the pinned image must already be local (goblin never pulls). Both
// probes are read-only — no create, no pull, no socket writes.
export async function sandbox(
	config: Config | undefined,
	probe: ProbeContext = {},
): Promise<HealthResult[]> {
	const scope = "caller-home;configured-sandbox";
	if (config?.sandbox === undefined)
		return [
			result(
				"sandbox.engine",
				scope,
				"skip",
				config === undefined
					? "Blocked by config"
					: "No sandbox block configured — the tool is absent",
			),
		];
	const start = performance.now();
	try {
		await command(["podman", "info"], 5000, probe);
	} catch (error) {
		return [
			result(
				"sandbox.engine",
				scope,
				"fail",
				`podman engine unresponsive: ${errno(error)}; configured sandbox calls cannot run`,
				start,
			),
			result("sandbox.image", scope, "skip", "Blocked by sandbox.engine"),
		];
	}
	const engine = result(
		"sandbox.engine",
		scope,
		"pass",
		"podman info answered — rootless engine responsive",
		start,
	);
	const imageStart = performance.now();
	try {
		await command(["podman", "image", "exists", config.sandbox.image], 5000, probe);
		return [
			engine,
			result(
				"sandbox.image",
				scope,
				"pass",
				`Configured image ${config.sandbox.image} is in the local store`,
				imageStart,
			),
		];
	} catch (error) {
		const category = errno(error);
		return [
			engine,
			result(
				"sandbox.image",
				scope,
				"fail",
				category === "exit:1"
					? `Configured image ${config.sandbox.image} not in the local store; pulls need operator approval: podman pull ${config.sandbox.image}`
					: `Image presence unverified: ${category}`,
				imageStart,
			),
		];
	}
}
