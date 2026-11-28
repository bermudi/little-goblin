import { useId, useState } from "react";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import type { AppBot } from "../../src/http/app-wire.ts";
import { convertSideChat } from "./api.ts";

export function BotConversionDialog({
	token,
	conversationId,
	title,
	onClose,
	onConverted,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	onClose: () => void;
	onConverted: (bot: AppBot) => void;
}) {
	const nameId = useId();
	const [name, setName] = useState(title ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		if (busy || name.trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			onConverted(await convertSideChat(token, conversationId, { name: name.trim() }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open, details) => {
			if (busy) details.cancel();
			else if (!open) onClose();
		}}>
			<div className="veil">
				<DialogContent className="msheet confirm-sheet" initialFocus={`[id="${nameId}"]`}>
					<header className="msheet-head">
						<DialogTitle render={<h3 />}>Convert to bot</DialogTitle>
					</header>
					<form className="confirm-body" onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}>
						<DialogDescription className="confirm-msg">
							This side chat becomes the bot’s main chat. It keeps its messages and links.
						</DialogDescription>
						<Field className="frow">
							<FieldLabel className="flabel">Bot name</FieldLabel>
							<Input
								id={nameId}
								name="name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								disabled={busy}
								maxLength={200}
								required
							/>
						</Field>
						{error !== null && <p className="err-inline" role="alert">{error}</p>}
						<div className="confirm-actions">
							<DialogClose className="ghost confirm-cancel" disabled={busy}>Cancel</DialogClose>
							<button type="submit" className="addbtn" disabled={busy || name.trim() === ""}>
								{busy ? "Converting…" : "Convert to bot"}
							</button>
						</div>
					</form>
				</DialogContent>
			</div>
		</Dialog>
	);
}
