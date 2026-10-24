// Telegram — the bot channel and its reply behavior. The model picks
// live in Models; apiRoot stays file-managed and is never shown.

import { Field, Row, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsTelegram({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft } = ctx;
	return (
		<>
			<h2 className="ops-h2">Telegram</h2>
			<div className="card">
				<Row
					label="Telegram channel"
					cap="Off runs the app without a bot token, polling, or the Telegram mini app. Existing Telegram settings stay saved for a later re-enable; restart applies."
				>
					<Switch
						on={draft.telegramEnabled}
						ariaLabel="telegram channel"
						onChange={(on) => patchDraft({ telegramEnabled: on })}
					/>
				</Row>
				{draft.telegramEnabled && (
					<>
						<Row
							label="Rich replies"
							cap="Markdown replies in your DM with a live draft preview while goblin works. Off restores plain text — the off-switch if streaming misbehaves. Applies to new turns."
						>
							<Switch
								on={draft.richReplies}
								ariaLabel="rich replies"
								onChange={(on) => patchDraft({ richReplies: on })}
							/>
						</Row>
						{draft.richReplies && (
							<Row
								label="Show reasoning"
								cap="The model's thinking streams into its own preview bubble and lands collapsed above the reply. DMs only."
							>
								<Switch
									on={draft.showReasoning}
									ariaLabel="show reasoning"
									onChange={(on) => patchDraft({ showReasoning: on })}
								/>
							</Row>
						)}
						<Field
							label="Start a new conversation after (quiet minutes)"
							value={draft.dmGap}
							onChange={(v) => patchDraft({ dmGap: v })}
							placeholder="45"
							numeric
							mono
							cap="Quiet minutes before a DM may roll into a new conversation. Applies immediately."
						/>
					</>
				)}
			</div>
		</>
	);
}
