/**
 * Test-only helper: build a `PiServices` whose `ModelRuntime` can see the faux
 * provider.
 *
 * pi-coding-agent 0.80.8+ `ModelRuntime` only surfaces its curated builtin
 * catalog + models.json + extensions; it does NOT pick up globally-registered
 * test providers such as faux. goblin's contract / vertical-slice tests drive
 * the real SDK with faux, so they must register it explicitly here — using
 * the *same* `faux` handle the test queues responses on, so the stream reads
 * the queued responses.
 *
 * `allowModelNetwork: false` keeps init offline, matching production
 * `createPiServices` (no ~15s catalog refresh when the network is slow).
 */

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { join } from "node:path";
import { piAgentDir, type PiServices } from "../pi-host.ts";

export async function createFauxPiServices(
  home: string,
  faux: FauxProviderRegistration,
): Promise<PiServices> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(piAgentDir(home), "auth.json"),
    modelsPath: join(piAgentDir(home), "models.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(
    "faux",
    { models: faux.models } as Parameters<typeof modelRuntime.registerProvider>[1],
  );
  modelRuntime.setRuntimeApiKey("faux", "fake-key");
  return { modelRuntime, settingsManager: SettingsManager.inMemory({}) };
}
