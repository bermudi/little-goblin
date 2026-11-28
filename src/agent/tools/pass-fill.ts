import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { log } from "../../log.ts";
import { parsePassRef } from "../../pass.ts";
import type { PassLane, PassRef } from "../../pass.ts";
import type { AgentBrowser } from "../../agent-browser.ts";

const ERROR_CAP = 300;
const REASON_CAP = 300;

export interface PassFillDeps {
	lane: Pick<PassLane, "readField">;
	browser: Pick<AgentBrowser, "pageUrl" | "fill">;
}

const inputSchema = z
	.object({
		ref: z.string().min(1).max(512),
		target: z.string().min(1).max(512),
		session: z
			.string()
			.regex(/^[\p{L}\p{N}_-]{1,64}$/u)
			.optional(),
	})
	.strict();

type PassFillInput = z.infer<typeof inputSchema>;
type PassFillOutput = { filled: true; field: string; host: string } | { error: string };

function messageOf(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, ERROR_CAP);
}

function loopback(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function passFillTool(deps: PassFillDeps) {
	return defineTool<PassFillInput, PassFillOutput>({
		description:
			"Fill one field of a web page in Goblin's own browser (the browser skill's agent-browser sessions) from a Proton Pass login item. " +
			"The value never reaches you; the result only says whether it filled. " +
			"ref is pass://SHARE_ID/ITEM_ID/FIELD — take the IDs from `pass-cli item list --output json` (pass-cli skill). " +
			"FIELD is username, email, password, totp (fills the current code) or a custom field name. " +
			"target is an @ref from your latest snapshot or a CSS selector. Pass session if you used --session. " +
			"Open the login page first: the page must be on one of the item's saved websites, over https. " +
			"Not for the operator's attached browser, where his own autofill signs in.",
		input: inputSchema,
		async execute(input): Promise<PassFillOutput> {
			const meta: Record<string, unknown> = { session: input.session };
			let outcome = "error";
			try {
				const ref = parsePassRef(input.ref);
				if (ref === null) {
					return {
						error: "ref must be pass://VAULT/ITEM/FIELD with share and item IDs from pass-cli item list, and no ?query",
					};
				}
				meta.vault = ref.vault;
				meta.item = ref.item;
				meta.field = ref.field;
				const field = ref.field.toLowerCase();
				if (field === "urls" || field === "totp_uri") {
					return { error: `the ${ref.field} field can't be filled into a page` };
				}
				let page: URL;
				try {
					page = new URL(await deps.browser.pageUrl(input.session));
				} catch (err) {
					return { error: `the browser page address could not be read — ${messageOf(err)}` };
				}
				const host = page.hostname.toLowerCase();
				meta.host = host;
				if (page.protocol !== "https:" && !(page.protocol === "http:" && loopback(host))) {
					return {
						error: `the page is ${page.protocol}//${host} — pass_fill only fills over https (http only on loopback)`,
					};
				}
				const reason = `goblin pass_fill: ${ref.field} for ${host}`.slice(0, REASON_CAP);
				let urlsValue: string;
				try {
					urlsValue = await deps.lane.readField({ ...ref, field: "urls" }, reason);
				} catch (err) {
					const message = messageOf(err);
					if (/field does not exist/i.test(message)) {
						return {
							error: "this item has no website address — ask the operator to add the site's address to the item in Proton Pass",
						};
					}
					return { error: message };
				}
				const hosts: string[] = [];
				for (const raw of urlsValue.split(",")) {
					const trimmed = raw.trim();
					if (trimmed === "") continue;
					try {
						const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
						if (parsed.hostname !== "") hosts.push(parsed.hostname.toLowerCase());
					} catch {
						continue;
					}
				}
				if (!hosts.some((itemHost) => host === itemHost || host.endsWith(`.${itemHost}`))) {
					return {
						error: `page host ${host} is not one of the item's websites (${hosts.join(", ")})`,
					};
				}
				let value: string;
				try {
					value = await deps.lane.readField(ref, reason);
				} catch (err) {
					return { error: messageOf(err) };
				}
				if (value === "") return { error: "that field is empty" };
				const filled = await deps.browser.fill(input.target, value, input.session);
				if (!filled.ok) {
					return { error: filled.error.split(value).join("[hidden]").slice(0, ERROR_CAP) };
				}
				outcome = "filled";
				return { filled: true, field: ref.field, host };
			} finally {
				log.info("pass_fill", { ...meta, outcome });
			}
		},
	});
}
