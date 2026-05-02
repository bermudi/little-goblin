/**
 * Subagent test bootstrap.
 *
 * The pi module mock is process-global, so we install it once here and then
 * load focused suites under `test/`. This keeps navigation sane without
 * reintroducing cross-file mock ordering hazards.
 */

import { installStandardPiMock } from "./test/support.ts";

installStandardPiMock();

await import("./test/spawn.suite.ts");
await import("./test/revive.suite.ts");
await import("./test/lifecycle.suite.ts");
await import("./test/guards.suite.ts");
await import("./test/tools.suite.ts");
