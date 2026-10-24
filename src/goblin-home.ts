// The goblin home directory — a dependency-free leaf so pre-install
// tooling (scripts/check-auth.ts) resolves the same root as the full
// config module without pulling in its json5/zod chain. config.ts
// re-exports this; GOBLIN_HOME wins, ~/goblin is the default.

import { homedir } from "node:os";
import { join } from "node:path";

export function goblinHome(): string {
	return process.env.GOBLIN_HOME ?? join(homedir(), "goblin");
}
