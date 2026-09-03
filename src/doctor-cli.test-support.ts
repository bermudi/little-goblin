import { writeFileSync } from "node:fs";

/**
 * Preloaded only by doctor.test.ts's nested-Bun test harness. Production
 * doctor code never imports this module or reads these variables, so normal
 * `bun run doctor` invocations cannot skip connectivity probes.
 */
const rawErrorBodyBytes = process.env.GOBLIN_DOCTOR_TEST_HTTP_ERROR_BYTES;
const cancelMarker = process.env.GOBLIN_DOCTOR_TEST_HTTP_CANCEL_MARKER;
const HTTP_ERROR_CHUNK_BYTES = 4 * 1024;

function parseErrorBodyBytes(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("GOBLIN_DOCTOR_TEST_HTTP_ERROR_BYTES must be a positive integer");
  }
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("GOBLIN_DOCTOR_TEST_HTTP_ERROR_BYTES must be a safe integer");
  }
  return bytes;
}

function oversizedErrorBody(
  totalBytes: number,
  marker: string | undefined,
): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(totalBytes, HTTP_ERROR_CHUNK_BYTES));
  chunk.fill("x".charCodeAt(0));
  let emitted = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(chunk.byteLength, totalBytes - emitted);
      controller.enqueue(chunk.slice(0, length));
      emitted += length;
    },
    cancel(): void {
      if (marker !== undefined) writeFileSync(marker, "canceled\n");
    },
  });
}

const errorBodyBytes = parseErrorBodyBytes(rawErrorBodyBytes);
const productionFetch = globalThis.fetch;

const testFetch = Object.assign(
  async (): Promise<Response> => {
    if (errorBodyBytes === 0) {
      return new Response("{}", { status: 200 });
    }
    return new Response(oversizedErrorBody(errorBodyBytes, cancelMarker), { status: 503 });
  },
  { preconnect: productionFetch.preconnect },
);

globalThis.fetch = testFetch;
