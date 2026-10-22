import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

function genUnboundedWebm(seconds: number): Uint8Array {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-af",
		"asetpts=PTS*400",
		"-c:a",
		"libopus",
		"-f",
		"webm",
		"pipe:1",
	]);
	if (gen.exitCode !== 0) throw new Error(`webm gen: ${gen.stderr.toString()}`);
	return gen.stdout;
}

function declaredDuration(path: string): number | null {
	const r = Bun.spawnSync([
		"ffprobe",
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		path,
	]);
	const d = Number.parseFloat(r.stdout.toString().trim());
	return Number.isFinite(d) ? d : null;
}

describe("app attachments", () => {
	test("multipart upload lands durably in workspace/attachments", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([1, 2, 3, 4, 5]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				ref: { path: string; mediaType: string; filename: string; size: number };
			};
			expect(body.ref.filename).toBe("shot.png");
			expect(body.ref.mediaType).toBe("image/png");
			expect(body.ref.size).toBe(5);
			expect(body.ref.path).toContain(join(home, "workspace", "attachments"));
			expect(readFileSync(body.ref.path)).toEqual(Buffer.from(bytes));
		} finally {
			http.stop();
		}
	});

	test("GET attachments/<name> serves stored bytes, confined to the dir", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([137, 80, 78, 71, 13]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: { path: string } };
			const name = ref.path.split("/").pop()!;

			const res = await call(`/api/app/attachments/${encodeURIComponent(name)}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(res.headers.get("cache-control")).toContain("private");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes));

			for (const bad of ["..%2F..%2Fconfig.json", ".deadbeef.tmp", "sub%2Ff.png"]) {
				expect((await call(`/api/app/attachments/${bad}`)).status).toBe(400);
			}
			expect((await call("/api/app/attachments/nope.png")).status).toBe(404);
			expect((await call(`/api/app/attachments/${name}`, {}, null)).status).toBe(401);
		} finally {
			http.stop();
		}
	});

	test("a recorder-broken audio upload is normalized to a seekable file", async () => {
		if (Bun.which("ffmpeg") === null || Bun.which("ffprobe") === null) return;
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const form = new FormData();
			form.append(
				"file",
				new Blob([genUnboundedWebm(2)], { type: "audio/webm;codecs=opus" }),
				"voice-note.webm",
			);
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				ref: { path: string; size: number; mediaType: string };
			};
			const d = declaredDuration(body.ref.path);
			expect(d).not.toBeNull();
			expect(d!).toBeLessThan(10);
			expect(body.ref.mediaType).toBe("audio/webm");
		} finally {
			http.stop();
		}
	});

	test("an unparseable audio upload keeps its verbatim bytes", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([9, 9, 9, 9, 9]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "audio/webm" }), "voice-note.webm");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as { ref: { path: string } };
			expect(readFileSync(body.ref.path)).toEqual(Buffer.from(bytes));
		} finally {
			http.stop();
		}
	});

	test("an upload with no file part is a clean 400, nothing written", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const form = new FormData();
			form.append("note", "no file here");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(400);
			const attDir = join(home, "workspace", "attachments");
			const stat = statSync(attDir, { throwIfNoEntry: false });
			expect(stat === undefined || readdirSync(attDir).length === 0).toBe(true);
		} finally {
			http.stop();
		}
	});
});
