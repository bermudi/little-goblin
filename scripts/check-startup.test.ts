import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function startupFixture(
	mode: string,
	assetMode = "healthy",
	kind: "accept" | "watch" = "accept",
): Promise<{ exit: number; output: string }> {
	const dir = mkdtempSync(join(tmpdir(), "goblin-startup-test-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === "/app/") {
				if (mode.startsWith("during-http-")) writeFileSync(join(dir, "during-http"), "changed");
				if (assetMode === "stalled-headers") return await new Promise<Response>(() => {});
				return new Response(
					assetMode === "not-html"
						? "other service"
						: `<!doctype html><div id="root"></div><script src="${assetMode === "remote-origin" ? "https://fixture.invalid/app/main.js" : "/app/assets/main.js"}"></script>`,
					{ headers: { "content-type": "text/html" } },
				);
			}
			if (assetMode === "stalled-body")
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("fixture"));
						},
					}),
				);
			if (assetMode === "oversized") return new Response(new Uint8Array(8 * 1024 * 1024 + 1));
			if (assetMode === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://fixture.invalid/app/main.js" },
				});
			if (assetMode === "asset-html")
				return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
			return new Response("fixture JS", { status: assetMode === "missing" ? 404 : 200 });
		},
	});
	try {
		const metadata = join(dir, "metadata.ts");
		writeFileSync(
			metadata,
			`import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const started=${JSON.stringify(join(dir, "started"))}; const countFile=${JSON.stringify(join(dir, "count"))};
const mode=${JSON.stringify(mode)}; const id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
if(process.argv[2]==='start'){writeFileSync(started,String(Math.floor(Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000000)));process.exit(0);}
const active=existsSync(started);const mono=active?readFileSync(started,'utf8'):'0';
if(process.argv[2]==='identity'){
if(active&&mode==='stalled-command')await new Promise(resolve=>setTimeout(resolve,10000));
const changed=existsSync(${JSON.stringify(join(dir, "during-http"))});
const count=existsSync(countFile)?Number(readFileSync(countFile,'utf8')):0; if(active)writeFileSync(countFile,String(count+1));
process.stdout.write('InvocationID='+ (active?((mode==='switch'&&count>0)||(mode==='during-http-switch'&&changed)?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':id):'')+'\\nExecMainStartTimestampMonotonic='+mono+'\\nNRestarts='+(active&&(mode==='restart'||mode==='during-http-restart'&&changed||mode==='watch-restart'&&count>0||mode==='watch-prerestart')?'1':'0')+'\\nActiveState='+(active?'active':'inactive')+'\\n');
}else{
const names=mode==='boot-error'?['boot failed']:mode==='poll-error'?['long polling failed']:mode==='no-polling'?['goblin up']:['goblin up','long polling started'];
for(const msg of names)process.stdout.write(JSON.stringify({_SYSTEMD_INVOCATION_ID:mode==='old-logs'?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':id,__MONOTONIC_TIMESTAMP:mode==='old-time'?'0':mono,__REALTIME_TIMESTAMP:String(mode==='before-attempt'?0:Date.now()*1000),MESSAGE:JSON.stringify({msg,...(msg==='goblin up'&&mode==='generated'?{port:${server.port}}:msg==='goblin up'&&mode==='wrong-port'?{port:${server.port! + 1}}:msg==='goblin up'&&mode==='invalid-port'?{port:0}:{}),error:'FIXTURE_SECRET',body:'FIXTURE_SECRET'})})+'\\n');
process.stdout.write(JSON.stringify({_SYSTEMD_INVOCATION_ID:id,__MONOTONIC_TIMESTAMP:mono,__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:'unstructured FIXTURE_SECRET'})+'\\n');
}`,
		);
		writeFileSync(
			join(bin, "systemctl"),
			`#!/bin/sh\ncase "$*" in\n'--user show goblin.service '*) exec '${process.execPath}' --no-install '${metadata}' identity ;;\n'--user enable goblin.service') exit 0 ;;\n'--user start --no-block goblin.service') exec '${process.execPath}' --no-install '${metadata}' start ;;\n*) exit 99 ;;\nesac\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "journalctl"),
			`#!/bin/sh\nexec '${process.execPath}' --no-install '${metadata}' journal\n`,
			{ mode: 0o755 },
		);
		const runner = join(dir, "runner.ts");
		writeFileSync(
			runner,
			kind === "watch"
				? `import {spawnSync} from 'node:child_process';\nimport {watchStartup} from ${JSON.stringify(join(import.meta.dir, "check-startup.ts"))};\nspawnSync(process.execPath, ['--no-install', ${JSON.stringify(metadata)}, 'start']);\ntry { await watchStartup(${server.port}, 900); process.stdout.write('accepted'); } catch(error) { process.stderr.write(error instanceof Error ? error.message : 'failed'); process.exitCode=1; }`
				: `import {acceptStartup} from ${JSON.stringify(join(import.meta.dir, "check-startup.ts"))};\ntry { await acceptStartup(${mode === "generated" || mode === "missing-port" ? 0 : server.port}, 900); process.stdout.write('accepted'); } catch(error) { process.stderr.write(error instanceof Error ? error.message : 'failed'); process.exitCode=1; }`,
		);
		const proc = Bun.spawn([process.execPath, "--no-install", runner], {
			env: { PATH: `${bin}:/usr/bin`, HOME: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exit, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exit, output: stdout + stderr };
	} finally {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("invocation-specific startup acceptance", () => {
	test("configured zero derives actual positive port from the current invocation ready event", async () => {
		const result = await startupFixture("generated");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("both current lifecycle events and served local HTML/assets are required, private fields never print", async () => {
		const result = await startupFixture("healthy");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	for (const mode of [
		"old-logs",
		"old-time",
		"before-attempt",
		"no-polling",
		"restart",
		"switch",
		"boot-error",
		"poll-error",
		"wrong-port",
		"invalid-port",
		"missing-port",
		"stalled-command",
		"during-http-restart",
		"during-http-switch",
	])
		test(`${mode} prevents acceptance without leaking journal bodies`, async () => {
			const result = await startupFixture(mode);
			expect(result.exit).toBe(1);
			expect(result.output).not.toContain("accepted");
			expect(result.output).not.toContain("FIXTURE_SECRET");
		});
	for (const mode of [
		"missing",
		"not-html",
		"stalled-headers",
		"stalled-body",
		"oversized",
		"redirect",
		"asset-html",
		"remote-origin",
	])
		test(`${mode} app fails even with an active service and both lifecycle events`, async () => {
			const result = await startupFixture("healthy", mode);
			expect(result.exit).toBe(1);
			expect(result.output).not.toContain("accepted");
		});
	test("watch mode accepts the already-started invocation a deploy restart created", async () => {
		const result = await startupFixture("healthy", "healthy", "watch");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("watch mode gates a crash-restart within budget", async () => {
		const result = await startupFixture("watch-restart", "healthy", "watch");
		expect(result.exit).toBe(1);
		expect(result.output).toContain("startup failed or restarted");
		expect(result.output).not.toContain("accepted");
		expect(result.output).not.toContain("FIXTURE_SECRET");
	});
	// An auto-restart that lands between the deploy's restart and the
	// first probe is a replacement invocation — its nonzero count must
	// fail the baseline, not become the accepted one.
	test("watch mode refuses an invocation already replaced before the baseline", async () => {
		const result = await startupFixture("watch-prerestart", "healthy", "watch");
		expect(result.exit).toBe(1);
		expect(result.output).toContain("startup failed or restarted");
		expect(result.output).not.toContain("accepted");
		expect(result.output).not.toContain("FIXTURE_SECRET");
	});
});
