/**
 * Groq speech-to-text transcription.
 *
 * Internal provider-shaped module. Only Groq is implemented today; the narrow
 * `AsrInput`/`AsrResult` surface keeps a seam for future providers without a
 * premature registry.
 *
 * Contract: this module reports transport/API outcomes only. A successful HTTP
 * response with empty/whitespace text is `{ ok: true, text: "" }` — the caller
 * (intake) owns the semantic "no speech detected" judgment. Ordinary external
 * failures (non-2xx, malformed JSON, missing key, network/timeout) are returned
 * as `{ ok: false, error }` rather than thrown; only programming errors throw.
 *
 * The Groq API key (bearer token) MUST NOT appear in any result or log line.
 *
 * API reference: https://console.groq.com/docs/speech-to-text
 *   POST https://api.groq.com/openai/v1/audio/transcriptions
 *   multipart/form-data: `file` (binary), `model` (required)
 *   response_format=json (default) → { "text": "..." }
 */

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Hardcoded 30-second request timeout. Groq Whisper transcription of Telegram
 * voice notes (≤20 MiB, Goblin's download cap) completes well under 30s in
 * practice. Not a config field.
 */
const GROQ_TIMEOUT_MS = 30_000;

export type AsrModel = "whisper-large-v3-turbo" | "whisper-large-v3";

export interface AsrInput {
  audioBytes: Uint8Array;
  /** MIME type of the audio bytes; e.g. `audio/ogg` for Telegram voice. */
  mimeType: string;
  model: AsrModel;
  /** Groq bearer token. Empty/undefined yields a sanitized setup failure. */
  apiKey: string | undefined;
}

export type AsrResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Transcribe audio bytes via the Groq Whisper endpoint. */
export async function transcribeWithGroq(input: AsrInput): Promise<AsrResult> {
  if (!input.apiKey) {
    return { ok: false, error: "Groq ASR is not configured (missing API key)." };
  }

  const form = new FormData();
  const blob = new Blob([input.audioBytes], { type: input.mimeType });
  // Append non-file fields first: Groq's parser validates the file part by its
  // filename extension, and some multipart stacks treat the first file field
  // as the upload target. The extension must be one Groq recognizes (ogg,
  // opus, etc.); `.oga` is rejected with a "file must be one of..." error.
  form.append("model", input.model);
  form.append("response_format", "json");
  form.append("file", blob, `voice.${extForMimeType(input.mimeType)}`);

  let resp: Response;
  try {
    resp = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: sanitizeTransportError(err) };
  }

  if (!resp.ok) {
    // Status code is non-secret; the response body is not surfaced to avoid
    // echoing any echoed request detail. The bearer token was header-only.
    return { ok: false, error: `Groq ASR request failed (HTTP ${resp.status}).` };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    return { ok: false, error: "Groq ASR returned a malformed response." };
  }

  if (typeof parsed !== "object" || parsed === null || !("text" in parsed)) {
    return { ok: false, error: "Groq ASR returned a malformed response." };
  }
  const textField = (parsed as { text: unknown }).text;
  if (typeof textField !== "string") {
    return { ok: false, error: "Groq ASR returned a malformed response." };
  }

  return { ok: true, text: textField.trim() };
}

/**
 * Map an audio MIME type to a filename extension for the multipart `file`
 * field. Groq validates the upload by filename extension, not MIME type, so the
 * extension must be one of its supported set (`flac mp3 mp4 mpeg mpga m4a ogg
 * opus wav webm`). `audio/ogg` (Telegram voice) maps to `ogg` for the upload;
 * the local saved copy still uses `.oga` per the project file naming spec.
 */
function extForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/mp4":
    case "audio/m4a":
      return "m4a";
    case "audio/flac":
      return "flac";
    default:
      return "bin";
  }
}

/**
 * Turn a thrown fetch error into a sanitized, non-secret message. Network
 * errors do not contain the bearer token (it travels in a header, not the URL
 * or body), but we never echo the raw error verbatim defensively. Timeout
 * aborts (from `AbortSignal.timeout`) are reported with a clear indication.
 */
function sanitizeTransportError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `Groq ASR request timed out after ${GROQ_TIMEOUT_MS / 1000}s.`;
  }
  return "Groq ASR request failed due to a network error.";
}
