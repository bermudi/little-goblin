// Models — chat models, helper models, and the favorites list.

import type { ThinkingLevel } from "../../src/config.ts";
import { displayLevel } from "./settingsDraft.ts";
import { Row, Seg, type SettingsCtx, Switch } from "./settingsKit.tsx";

const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export function SettingsModels({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, levels, modelNames, setSheet, modelButton, moveFavorite } = ctx;
	return (
		<>
			<h2 className="ops-h2">Default models</h2>
			<div className="card">
				{modelButton(
					"App chats",
					"New app conversations only. Each chat remembers its own model and thinking level.",
					"model",
					draft.model,
					"appModelLabel",
				)}
				<Row
					label="Thinking"
					cap={
						levels.app.unavailable
							? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
							: "Only levels this model can express are shown."
					}
					col
				>
					<Seg
						options={levels.app.values}
						value={displayLevel(draft.thinking, levels.app.values)}
						ariaLabel="App default thinking level"
						onChange={(v) => patchDraft({ thinking: v as ThinkingLevel })}
					/>
				</Row>
				{draft.telegramEnabled ? (
					<>
						{modelButton(
							"Telegram",
							"Shared by all Telegram conversations.",
							"telegram",
							draft.telegramModel,
							"tgModelLabel",
						)}
						<Row
							label="Telegram thinking"
							cap={
								levels.telegram.unavailable
									? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
									: "Only levels this model can express are shown."
							}
							col
						>
							<Seg
								options={levels.telegram.values}
								value={displayLevel(draft.telegramThinking, levels.telegram.values)}
								ariaLabel="Telegram thinking level"
								onChange={(v) => patchDraft({ telegramThinking: v as ThinkingLevel })}
							/>
						</Row>
					</>
				) : (
					<div className="cap ops-cap">Telegram is off.</div>
				)}
			</div>
			{/* Helpers run on every surface — Telegram turns included — so
			    the card sits outside both channel groupings. */}
			<h2 className="ops-h2">Helpers</h2>
			<div className="card">
				{modelButton(
					"Topic titles",
					"Names Telegram topics and new app chats, then stops.",
					"title",
					draft.titleModel,
					"titleModelLabel",
				)}
				{modelButton(
					"Vision",
					"Adds a vision tool — answers questions about image files. Needed when the chat model can't see attachments. Telegram and app turns.",
					"vision",
					draft.vision?.model ?? "",
					"visionLabel",
				)}
				{modelButton(
					"Image generation",
					"Adds an image tool for openai-compatible providers — the OpenAI images endpoint.",
					"image",
					draft.image?.model ?? "",
					"imageLabel",
				)}
				{draft.image !== null && (
					<Row label="Image size" cap="A default for the tool's calls — it may pick another." col>
						<Seg
							options={["default", ...IMAGE_SIZES]}
							value={draft.image.size === "" ? "default" : draft.image.size}
							ariaLabel="Image size"
							onChange={(v) =>
								patchDraft({
									image:
										draft.image === null
											? draft.image
											: { ...draft.image, size: v === "default" ? "" : v },
								})
							}
						/>
					</Row>
				)}
			</div>
			<h2 className="ops-h2">Favorites</h2>
			<div className="card">
				{draft.favorites.map((f, i) => {
					const name = modelNames.get(f);
					return (
						<div className="chain-card" key={`${i}:${f}`}>
							<div className="chain-head">
								<span className="fav-cell">
									<span className="fav-name">{name ?? f}</span>
									{name !== undefined && <span className="fav-ref">{f}</span>}
								</span>
								<span className="chain-btns">
									<button
										type="button"
										aria-label={`move ${f} up`}
										disabled={i === 0}
										onClick={() => moveFavorite(i, -1)}
									>
										↑
									</button>
									<button
										type="button"
										aria-label={`move ${f} down`}
										disabled={i === draft.favorites.length - 1}
										onClick={() => moveFavorite(i, 1)}
									>
										↓
									</button>
									<button
										type="button"
										aria-label={`remove ${f}`}
										onClick={() =>
											patchDraft({ favorites: draft.favorites.filter((_, j) => j !== i) })
										}
									>
										×
									</button>
								</span>
							</div>
						</div>
					);
				})}
				<button className="ghost" type="button" onClick={() => setSheet("favorites")}>
					+ Add favorites
				</button>
				<div className="cap">Starred models — offered first in every picker.</div>
			</div>
		</>
	);
}
