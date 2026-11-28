import { useRef, useState } from "react";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import type { AppBot } from "../../src/http/app-wire.ts";
import { moveBotChatBack, renameBot } from "./api.ts";

export function BotSettingsView({ token, bot, onChanged, onMovedBack }: {
	token: string | null;
	bot: AppBot;
	onChanged: () => Promise<unknown>;
	onMovedBack: (conversationId: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [pending, setPending] = useState<"rename" | "move" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const locked = useRef(false);
	const name = draft ?? bot.name;

	const change = async (action: "rename" | "move") => {
		if (locked.current) return;
		locked.current = true;
		setPending(action);
		setError(null);
		try {
			if (action === "rename") {
				await renameBot(token, bot.id, { name });
				await onChanged();
				setDraft(null);
			} else {
				const { conversationId } = await moveBotChatBack(token, bot.id);
				onMovedBack(conversationId);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(null);
			locked.current = false;
		}
	};

	return (
		<div className="ops bot-settings">
			<h2 className="ops-h2">Bot settings</h2>
			<form className="card" onSubmit={(event) => {
				event.preventDefault();
				if (name.trim() !== "" && name.trim() !== bot.name) void change("rename");
			}}>
				<div className="bot-settings-fields">
					<Field className="frow">
						<FieldLabel className="flabel">Bot name</FieldLabel>
						<Input
							name="name"
							value={name}
							onChange={(event) => setDraft(event.target.value)}
							disabled={pending !== null}
							maxLength={200}
							required
						/>
					</Field>
					<button type="submit" className="addbtn" disabled={pending !== null || name.trim() === "" || name.trim() === bot.name}>
						{pending === "rename" ? "Saving…" : "Save name"}
					</button>
				</div>
			</form>
			{error !== null && <p className="err-inline" role="alert">{error}</p>}
			{bot.canMoveBack && (
				<section className="card bot-settings-move">
					<div>
						<p>The main chat returns to Little Goblin’s side chats with its history intact.</p>
						<button
							type="button"
							className="danger"
							disabled={pending !== null}
							onClick={() => void change("move")}
						>
							{pending === "move" ? "Moving…" : "Move back to Little Goblin"}
						</button>
					</div>
				</section>
			)}
		</div>
	);
}
