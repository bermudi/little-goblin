import { expect, test } from "bun:test";
import { commandProgramName } from "./commandProgramName.ts";

test("finds the first real program in shell commands", () => {
  const cases: [string, string | null][] = [
    ["sed -n 1p x", "sed"],
    ["cd /a && FOO=1 sudo -n git status", "git"],
    ["timeout 5 bun test", "bun"],
    ["/usr/bin/env python x", "python"],
    ["", null], ["$(x)", null], ["ls;", "ls"], ["a|b", "a"],
    ["cd a\nls", "ls"], ["set -euo pipefail\nbun test", "bun"],
    ["export A=1 && git status", "git"], ["# note\ngit status", "git"],
    ["for f in *; do echo x; done", null], ["if true; then ls; fi", null],
    ["sudo -u x git status", "git"], ["nice -n 5 make", "make"],
    ["timeout -k 5 10 bun test", "bun"], ['cd "a b" && ls', "ls"],
    ["(cd x && ls)", null], ["cd x 2>&1 && ls", "ls"], ["cd x &>/dev/null; make", "make"],
    ["cd a && \\\n  ls -la", "ls"], ["time make", "make"], ["cat <<EOF\nhello\nEOF", "cat"],
  ];
  for (const [command, expected] of cases)
    expect(commandProgramName(command), command).toBe(expected);
});
