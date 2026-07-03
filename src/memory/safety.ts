/**
 * Deterministic memory safety filter.
 *
 * Runs before any explicit or automatic memory write reaches disk. Rejects
 * obvious secrets, credentials, sensitive identifiers, and known secret-like
 * patterns. Rejected content MUST NOT be written to trusted memory.
 *
 * This filter is intentionally conservative: false positives from reflection
 * go to quarantine for audit; explicit tool writes return a safety error.
 * No runtime configuration surface — patterns are hardcoded heuristics.
 */

export type SafetyReason =
  | "api_key"
  | "bearer_token"
  | "private_key"
  | "password"
  | "cookie"
  | "telegram_bot_token"
  | "financial_identifier"
  | "secret_assignment"
  | "high_entropy_secret"
  | "sensitive_identifier"
  | "tiny_fragment";

export interface SafetyResult {
  ok: boolean;
  reason?: SafetyReason;
  message?: string;
}

export interface CheckMemorySafetyOptions {
  /**
   * When true, the content is a single-line description and tiny-fragment
   * checks are skipped (descriptions are intentionally short).
   */
  isDescription?: boolean;
}

/**
 * Run the deterministic safety filter over proposed memory content.
 *
 * Returns `{ ok: true }` when the content is safe to persist, or
 * `{ ok: false, reason, message }` when it must be rejected.
 */
export function checkMemorySafety(
  content: string,
  opts: CheckMemorySafetyOptions = {},
): SafetyResult {
  if (!opts.isDescription) {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "tiny_fragment", message: "content is empty" };
    }
    // Reject tiny fragments that carry no durable signal.
    if (trimmed.length < 3) {
      return {
        ok: false,
        reason: "tiny_fragment",
        message: "content too short to be a durable memory entry",
      };
    }
  }

  for (const [reason, hit] of scan(content)) {
    return {
      ok: false,
      reason,
      message: hit,
    };
  }
  return { ok: true };
}

/**
 * Description-line safety check. Descriptions are single-line and short,
 * so tiny-fragment filtering does not apply, but secret patterns still do.
 */
export function checkDescriptionSafety(description: string): SafetyResult {
  return checkMemorySafety(description, { isDescription: true });
}

/**
 * Produce a redacted preview of rejected content suitable for quarantine
 * logs. The preview never copies the sensitive value; it shows structural
 * shape and length only.
 *
 * Two redaction passes:
 * 1. Values after secret-assignment operators (`key: value`, `key = value`)
 *    are replaced regardless of length, so short passwords like "hunter2"
 *    do not leak.
 * 2. Long alphanumeric runs (>= 8 chars) are replaced with `[redacted:N]`.
 */
export function redactPreview(content: string, maxLen = 80): string {
  // Pass 1: redact values after secret-assignment operators regardless of
  // value length, so short passwords like "hunter2" do not leak.
  let redacted = content.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|api[_-]?secret|access[_-]?token|auth|cookie|set-cookie)\b\s*[:=]\s*(\S+)/gi,
    (_m, key: string, _value: string) => `${key}[redacted:value]`,
  );
  // Pass 2: redact long alphanumeric runs (>= 8 chars).
  redacted = redacted
    .replace(/[A-Za-z0-9_\-]{8,}/g, (m) => `[redacted:${m.length}]`)
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > maxLen ? redacted.slice(0, maxLen) + "…" : redacted;
}

// ---------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------

interface Pattern {
  reason: SafetyReason;
  re: RegExp;
  label: string;
}

const PATTERNS: Pattern[] = [
  // Private key blocks (PEM)
  {
    reason: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    label: "PEM private key block",
  },
  // Bearer tokens
  {
    reason: "bearer_token",
    re: /\bBearer\s+[A-Za-z0-9._~+\/\-]{16,}/i,
    label: "Bearer token",
  },
  // OpenAI / Anthropic style API keys
  {
    reason: "api_key",
    re: /\bsk-[A-Za-z0-9]{20,}/,
    label: "OpenAI-style API key (sk-...)",
  },
  {
    reason: "api_key",
    re: /\bsk-ant-[A-Za-z0-9_\-]{20,}/,
    label: "Anthropic-style API key (sk-ant-...)",
  },
  // AWS access key ids and secrets
  {
    reason: "api_key",
    re: /\bAKIA[0-9A-Z]{16}/,
    label: "AWS access key id",
  },
  // Google API keys
  {
    reason: "api_key",
    re: /\bAIza[0-9A-Za-z_\-]{35}/,
    label: "Google API key",
  },
  // GitHub tokens
  {
    reason: "api_key",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}/,
    label: "GitHub token",
  },
  // Telegram bot tokens: <numeric id>:<35-char secret>
  {
    reason: "telegram_bot_token",
    re: /\b\d{8,12}:[A-Za-z0-9_\-]{30,}/,
    label: "Telegram bot token",
  },
  // Password / passwd / pwd assignments
  {
    reason: "password",
    re: /\bpassword\b\s*[:=]\s*\S+/i,
    label: "password assignment",
  },
  {
    reason: "password",
    re: /\bpasswd\b\s*[:=]\s*\S+/i,
    label: "passwd assignment",
  },
  {
    reason: "password",
    re: /\bpwd\b\s*[:=]\s*\S+/i,
    label: "pwd assignment",
  },
  // Cookie headers / assignments
  {
    reason: "cookie",
    re: /\bcookie\b\s*[:=]\s*\S+/i,
    label: "cookie assignment",
  },
  {
    reason: "cookie",
    re: /\bset-cookie\b\s*[:=]\s*\S+/i,
    label: "set-cookie assignment",
  },
  // Generic secret/token/api_key assignments
  {
    reason: "secret_assignment",
    re: /\bapi[_-]?key\b\s*[:=]\s*\S+/i,
    label: "api_key assignment",
  },
  {
    reason: "secret_assignment",
    re: /\bapi[_-]?secret\b\s*[:=]\s*\S+/i,
    label: "api_secret assignment",
  },
  {
    reason: "secret_assignment",
    re: /\bsecret\b\s*[:=]\s*\S+/i,
    label: "secret assignment",
  },
  {
    reason: "secret_assignment",
    re: /\btoken\b\s*[:=]\s*\S+/i,
    label: "token assignment",
  },
  {
    reason: "secret_assignment",
    re: /\baccess[_-]?token\b\s*[:=]\s*\S+/i,
    label: "access_token assignment",
  },
  {
    reason: "secret_assignment",
    re: /\bauth\b\s*[:=]\s*\S+/i,
    label: "auth assignment",
  },
  // High-risk financial identifiers: credit card numbers (13-19 digits,
  // optionally grouped). We accept grouped or contiguous digit runs.
  {
    reason: "financial_identifier",
    re: /\b(?:\d[ -]?){13,19}\d\b/,
    label: "possible credit card number",
  },
  // US SSN-like patterns
  {
    reason: "sensitive_identifier",
    re: /\b\d{3}-\d{2}-\d{4}\b/,
    label: "possible SSN",
  },
];

/**
 * Scan content against the pattern table. Yields the first hit.
 */
function* scan(content: string): Generator<[SafetyReason, string]> {
  for (const p of PATTERNS) {
    if (p.re.test(content)) {
      yield [p.reason, p.label];
    }
  }
}
