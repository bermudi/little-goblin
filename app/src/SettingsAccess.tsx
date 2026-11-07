// Access — who may talk to goblin. Operators get the full agent;
// "Other people" is the guest lane (sandboxed, search-only, no memory).

import { ChipsEditor, Row, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsAccess({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, setDraft, addId, capStates } = ctx;
	const guest = capStates?.guest;
	return (
		<>
			<SectionHead title="Operators" purpose="People with full control of goblin, these settings included." />
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
							? "Telegram user ids. The list can't be empty while Telegram is on — that would lock everyone out."
							: "Telegram user ids. The list may be empty while Telegram is off."
					}
				/>
			</div>
			<SectionHead title="Other people" purpose="People who may chat with a limited, safe version of goblin." />
			<div className="card">
				<Row
					label="Answer allowed users"
					cap={
						guest?.state === "needs-setup"
							? (guest.hint ?? "Guest replies need setup first.")
							: "Guests get search only. No memory, no app."
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
				<ChipsEditor
					values={draft.allowedUsers.map(String)}
					onAdd={(v) => addId("allowedUsers", v)}
					onRemove={(i) =>
						patchDraft({ allowedUsers: draft.allowedUsers.filter((_, j) => j !== i) })
					}
					placeholder="telegram user id"
					ariaLabel="add allowed user"
					numeric
					cap={
						draft.capabilities.guest === true
							? "Telegram user ids. They can DM goblin or @mention it in groups. Everyone else gets a refusal."
							: "Off — allowed users get no replies."
					}
				/>
			</div>
		</>
	);
}
