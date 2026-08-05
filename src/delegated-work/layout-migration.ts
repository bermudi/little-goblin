/**
 * Offline migration step 5: delegated-work layout break.
 *
 * No legacy data is migrated. The step exists to advance the filesystem state
 * version so the startup gate refuses to poll against a pre-break home. The
 * plan is a read-only check that the new runs root is writable (or creatable);
 * the apply creates it if absent. Legacy `scratch/subagents` and
 * `workspace/agents/.../instances` trees are abandoned in place — the operator
 * deletes them manually.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { delegatedWorkRunsRoot } from "./paths.ts";

export interface DelegatedWorkLayoutPlan {
  readonly runsRoot: string;
  readonly runsRootExisted: boolean;
}

export function planDelegatedWorkLayout(home: string): DelegatedWorkLayoutPlan {
  const runsRoot = delegatedWorkRunsRoot(home);
  const runsRootExisted = existsSync(runsRoot) && statSync(runsRoot).isDirectory();
  return { runsRoot, runsRootExisted };
}

export function applyDelegatedWorkLayout(_home: string, plan: DelegatedWorkLayoutPlan): void {
  if (!plan.runsRootExisted) {
    mkdirSync(plan.runsRoot, { recursive: true });
  }
}
