import { join } from "node:path";

/**
 * Pure path utilities for the inner-life filesystem layout.
 *
 * Only these helpers construct inner-life paths; the wake store is the only
 * module that performs wake-record I/O through them (decision 0035, decision
 * 0008).
 */

/**
 * Wake ids are deterministic `wake_<16 lowercase hex>` values derived from the
 * source window, so a duplicate reservation for the same window lands on the
 * same path and coalesces or conflicts instead of forking a second wake.
 */
export const SAFE_WAKE_ID_RE = /^wake_[0-9a-f]{16}$/;

export function validateWakeId(id: string): void {
  if (!SAFE_WAKE_ID_RE.test(id)) {
    throw new Error(
      `Invalid wake id ${JSON.stringify(id)}: must be wake_ followed by 16 lowercase hex characters`,
    );
  }
}

export function innerLifeRoot(home: string): string {
  return join(home, "state", "inner-life");
}

export function wakesDir(home: string): string {
  return join(innerLifeRoot(home), "wakes");
}

export function wakeRecordPath(home: string, wakeId: string): string {
  validateWakeId(wakeId);
  return join(wakesDir(home), `${wakeId}.json`);
}
