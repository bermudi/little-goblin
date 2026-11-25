const SKIP = new Set(["cd", "set", "export", "source", ".", "true", ":"]);
const KEYWORDS = new Set([
  "for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done",
  "case", "esac", "function", "select", "in",
]);
const WRAPPERS = new Set([
  "sudo", "env", "nohup", "time", "exec", "command", "nice", "timeout", "systemd-run",
]);
const VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
    "-C", "--close-from", "-D", "--chdir", "-R", "--chroot"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  "systemd-run": new Set(["-p", "--property", "--unit", "--description",
    "--working-directory", "--setenv", "--uid", "--gid", "--slice"]),
};

function commands(input: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let comment = false;
  const pushWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  const pushCommand = () => {
    pushWord();
    if (words.length) result.push(words);
    words = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (comment) {
      if (char === "\n") { comment = false; pushCommand(); }
      continue;
    }
    if (escaped) {
      if (char !== "\n") word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== "") {
      if (char === quote) quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && word === "") { comment = true; continue; }
    const redirect = char === "&" && (word.endsWith(">") || input[i + 1] === ">");
    if (";&|\n".includes(char) && !redirect) { pushCommand(); continue; }
    if (/\s/.test(char)) { pushWord(); continue; }
    word += char;
  }
  pushCommand();
  return result;
}

export function commandProgramName(command: string): string | null {
  for (const words of commands(command)) {
    let i = 0;
    while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) i++;
    if (SKIP.has(words[i] ?? "")) continue;
    for (;;) {
      const word = words[i];
      if (word === undefined) break;
      const name = word.split("/").at(-1) ?? "";
      if (!WRAPPERS.has(name)) {
        if (KEYWORDS.has(name) || name.length > 40 || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name))
          return null;
        return name;
      }
      i++;
      while (i < words.length) {
        const arg = words[i]!;
        if (/^[A-Za-z_]\w*=/.test(arg)) { i++; continue; }
        if (arg === "--") { i++; break; }
        if (!arg.startsWith("-")) break;
        i++;
        if (VALUE_FLAGS[name]?.has(arg)) i++;
      }
      if (name === "timeout" && words[i] !== undefined) i++;
    }
  }
  return null;
}
