// Access — who may talk to goblin. Operators get the full agent;
// "Other people" is the guest lane (sandboxed, search-only, no memory).

import { ChipsEditor, Row, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsAccess({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, setDraft, addId, capStates } = ctx;
	const guest = capStates?.guest;
	return (
		<>
			<h2 className="ops-h2">Operators</h2>
			<div className="card">
				<ChipsEditor
					values={draft.operators.map(String)}
					onAdd={(v) => addId("operators", v)}
					onRemove={(i) => patchDraft({ operators: draft.operators.filter((_, j) => j !== i) })}
					placeholder="telegram user id"
					ariaLabel="add operator"
					numeric
					cap={
						draft.telegramEnabled
							? "Telegram user ids with the full personal agent on every surface — these settings included. The list can't be emptied — that would lock everyone out."
							: "Telegram user ids with the full personal agent on every surface — these settings included. The list may be empty while Telegram is off."
					}
				/>
			</div>
			<h2 className="ops-h2">Other people</h2>
			<div className="card">
				<Row
					label="Answer allowed users"
					cap={
						guest?.state === "needs-setup"
							? (guest.hint ?? "Guest replies need setup first.")
							: "A guest persona — search-only tools, no memory, no app."
					}
				>
					<Switch
						on={draft.capabilities.guest === true}
						ariaLabel="answer allowed users"
						disabled={guest?.state === "needs-setup"}
						onChange={(on) =>
							setDraft((d) => ({
								...d,
								capabilities: { ...d.capabilities, guest: on },
							}))
						}
					/>
				</Row>
				{draft.capabilities.guest === true && (
					<ChipsEditor
						values={draft.allowedUsers.map(String)}
						onAdd={(v) => addId("allowedUsers", v)}
						onRemove={(i) =>
							patchDraft({ allowedUsers: draft.allowedUsers.filter((_, j) => j !== i) })
						}
						placeholder="telegram user id"
						ariaLabel="add allowed user"
						numeric
						cap="Telegram user ids that may talk to goblin sandboxed — DM them directly or @mention in groups; everyone else gets a refusal line."
					/>
				)}
			</div>
		</>
	);
}
