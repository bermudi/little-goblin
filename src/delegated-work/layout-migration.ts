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

import { accessSync, constants, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { delegatedWorkRunsRoot } from "./paths.ts";

export interface DelegatedWorkLayoutPlan {
  readonly runsRoot: string;
  readonly runsRootExisted: boolean;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function nearestWritableAncestor(dir: string): string {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`cannot create delegated-work runs root: ${dir} is not a directory`);
    }
  } catch (err) {
    if (!isNodeErrnoException(err) || err.code !== "ENOENT") throw err;
    // statSync ENOENT: either genuinely absent, or a dangling symlink.
    // A dangling symlink in an intermediate component would make the later
    // recursive mkdirSync fail mid-migration, so detect and reject it here.
    try {
      lstatSync(dir);
      throw new Error(`delegated-work runs root ancestor is a dangling symlink: ${dir}`);
    } catch (lerr) {
      if (isNodeErrnoException(lerr) && lerr.code === "ENOENT") {
        // genuinely absent — continue upward
      } else {
        throw lerr;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot create delegated-work runs root: no writable ancestor for ${dir}`);
    }
    return nearestWritableAncestor(parent);
  }

  accessSync(dir, constants.W_OK | constants.X_OK);
  return dir;
}

export function planDelegatedWorkLayout(home: string): DelegatedWorkLayoutPlan {
  const runsRoot = delegatedWorkRunsRoot(home);
  let runsRootExisted = false;
  try {
    // Follow symlinks: a symlink pointing at a real, writable directory is a
    // valid runs root (common for parking state/ on another volume).
    if (!statSync(runsRoot).isDirectory()) {
      throw new Error(`delegated-work runs root exists but is not a directory: ${runsRoot}`);
    }
    runsRootExisted = true;
    accessSync(runsRoot, constants.W_OK | constants.X_OK);
  } catch (err) {
    if (!isNodeErrnoException(err) || err.code !== "ENOENT") throw err;
    // statSync ENOENT: either genuinely absent, or a dangling symlink.
    // mkdirSync({recursive:true}) would EEXIST on a dangling symlink
    // mid-migration, so detect and reject it here via lstatSync (which
    // does not follow symlinks and reports the symlink itself).
    try {
      lstatSync(runsRoot);
      throw new Error(`delegated-work runs root is a dangling symlink: ${runsRoot}`);
    } catch (lerr) {
      if (isNodeErrnoException(lerr) && lerr.code === "ENOENT") {
        // genuinely absent — verify it can be created
        nearestWritableAncestor(dirname(runsRoot));
      } else {
        throw lerr;
      }
    }
  }
  return { runsRoot, runsRootExisted };
}

export function applyDelegatedWorkLayout(_home: string, plan: DelegatedWorkLayoutPlan): void {
  if (!plan.runsRootExisted) {
    mkdirSync(plan.runsRoot, { recursive: true });
  }
}
