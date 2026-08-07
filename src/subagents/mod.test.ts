// The pi module mock is process-global; install it once in this bootstrap.
import { installStandardPiMock } from "./test/support.ts";

installStandardPiMock();

await import("./test/host.suite.ts");
await import("./test/fake-lifecycle.suite.ts");
await import("./test/spawn.suite.ts");
await import("./test/revive.suite.ts");
await import("./test/lifecycle.suite.ts");
await import("./test/guards.suite.ts");
await import("./test/tools.suite.ts");
await import("./test/memory.suite.ts");
await import("./test/surface-authority.suite.ts");
await import("./test/runtime-authority.suite.ts");
await import("./test/quiescence.suite.ts");
await import("./test/meta.suite.ts");
