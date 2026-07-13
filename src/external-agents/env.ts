import type { ExternalAgentBackend, ExternalAgentPermissionProfile } from "./types.ts";

export interface EnvOptions {
  runId: string;
  sessionId: string;
  backend: ExternalAgentBackend;
  permissionProfile: ExternalAgentPermissionProfile;
}

const EXACT_KEYS = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
]);

const KEY_PREFIXES = ["LC_"];

function isKeyAllowed(key: string): boolean {
  // Generic provider API keys and Goblin secrets must not be forwarded.
  if (key.endsWith("_API_KEY")) return false;
  if (EXACT_KEYS.has(key)) return true;
  for (const prefix of KEY_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function prepareEnv(options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isKeyAllowed(key)) {
      env[key] = value;
    }
  }

  env.EXTERNAL_AGENT = "true";
  env.EXTERNAL_AGENT_BACKEND = options.backend;
  env.EXTERNAL_AGENT_RUN_ID = options.runId;
  env.EXTERNAL_AGENT_SESSION_ID = options.sessionId;
  env.EXTERNAL_AGENT_PERMISSION_PROFILE = options.permissionProfile;

  return env;
}
