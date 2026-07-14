const EXACT_KEYS = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TMPDIR",
  "COLORTERM",
  "SSL_CERT_FILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
]);

function isKeyAllowed(key: string): boolean {
  // Generic provider API keys and Goblin secrets must not be forwarded.
  if (key.endsWith("_API_KEY")) return false;
  return EXACT_KEYS.has(key);
}

export function prepareEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isKeyAllowed(key)) {
      env[key] = value;
    }
  }
  return env;
}
