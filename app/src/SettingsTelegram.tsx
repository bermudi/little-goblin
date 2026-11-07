// Telegram — the bot channel and its reply behavior. The model picks
// live in Models; apiRoot stays file-managed and is never shown.

import { Field, Row, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsTelegram({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft } = ctx;
	return (
		<>
			<SectionHead title="Telegram" purpose="The bot channel and how it replies. The app works without it." />
			<div className="card">
				<Row
					label="Telegram channel"
					tag="restart"
					cap="Off runs only the app: no bot, no mini app. Your Telegram settings stay saved."
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
							cap="Formatted replies with a live preview while goblin works. Turn off for plain text if streaming misbehaves."
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
								cap="Shows the model's thinking in a separate bubble, folded above the reply. DMs only."
							>
								<Switch
									on={draft.showReasoning}
									ariaLabel="show reasoning"
									onChange={(on) => patchDraft({ showReasoning: on })}
								/>
							</Row>
						)}
						<Field
							label="New conversation after quiet minutes"
							value={draft.dmGap}
							onChange={(v) => patchDraft({ dmGap: v })}
							placeholder="45"
							numeric
							mono
							cap="After this many quiet minutes, your next DM starts a fresh conversation."
						/>
					</>
				)}
			</div>
		</>
	);
}
