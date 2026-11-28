import { z } from "zod";

const replySchema = z.object({
	id: z.number().int(),
	stdout: z.string(),
	stderr: z.string(),
	code: z.number().int(),
});

async function main(): Promise<number> {
	if (process.env.GOBLIN_CHANNEL_FD === undefined) {
		process.stderr.write("goblin: no Goblin channel here — goblin commands work only inside Goblin's bash tool, while that call runs\n");
		return 75;
	}
	const argv = process.argv.slice(2);
	let stdin: string | undefined;
	if (argv.some((arg) => arg === "-")) {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of Bun.stdin.stream()) {
			const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			total += bytes.byteLength;
			if (total > 1024 * 1024) {
				process.stderr.write("goblin: stdin exceeds 1 MiB\n");
				return 2;
			}
			chunks.push(bytes);
		}
		stdin = Buffer.concat(chunks).toString("utf8");
	}
	if (typeof process.send !== "function") {
		process.stderr.write("goblin: the bash call that owned this channel has ended\n");
		return 75;
	}
	const id = process.pid;
	return await new Promise<number>((resolve) => {
		const finish = (code: number): void => {
			process.removeListener("message", onMessage);
			process.removeListener("disconnect", onDisconnect);
			resolve(code);
		};
		const onMessage = (raw: unknown): void => {
			const parsed = replySchema.safeParse(raw);
			if (!parsed.success || parsed.data.id !== id) return;
			process.stdout.write(parsed.data.stdout);
			process.stderr.write(parsed.data.stderr);
			finish(parsed.data.code);
		};
		const onDisconnect = (): void => {
			process.stderr.write("goblin: the bash call that owned this channel has ended\n");
			finish(75);
		};
		process.on("message", onMessage);
		process.once("disconnect", onDisconnect);
		try {
			process.send!({ id, argv, ...(stdin === undefined ? {} : { stdin }) }, (err) => {
				if (err) onDisconnect();
			});
		} catch {
			onDisconnect();
		}
	});
}

process.exitCode = await main();
