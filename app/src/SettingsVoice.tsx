// Voice — speaking (tts) and transcription. Keys ride KeyStatus; the
// whistle engine/weights stay opaque and round-trip through the draft.

import {
	emptyTranscription,
	emptyTrEntry,
	type TranscriptionKind,
	type TrEntryDraft,
	switchTranscriptionKind,
	switchTtsKind,
	type TtsKind,
	VOICE_SUGGESTIONS,
} from "./settingsDraft.ts";
import {
	ChipsEditor,
	displayName,
	Field,
	KeyStatus,
	OrderedList,
	Row,
	type SettingsCtx,
	Switch,
} from "./settingsKit.tsx";

const WHISTLE_LANGS = ["en", "de", "fr", "es", "it", "nl", "pl"] as const;

function TrFallbackCard({
	entry,
	index,
	ctx,
	onPatch,
}: {
	entry: TrEntryDraft;
	index: number;
	ctx: SettingsCtx;
	onPatch: (p: Partial<TrEntryDraft>) => void;
}) {
	const { kinds, token, authNames, authCommandNames, serviceNames, rememberAuthName } = ctx;
	const def = entry.kind === "whistle" ? { model: "", auth: "" } : kinds.trDefaults[entry.kind];
	const effective = entry.auth.trim() || def.auth;
	return (
		<>
			<select
				className="mono"
				value={entry.kind}
				aria-label={`fallback ${index + 1} engine`}
				onChange={(ev) => {
					const kind = kinds.transcription.find((k) => k === ev.target.value);
					if (kind !== undefined) onPatch(switchTranscriptionKind(entry, kind));
				}}
			>
				{kinds.transcription.map((k) => (
					<option key={k} value={k}>
						{displayName(serviceNames, k)}
					</option>
				))}
			</select>
			{entry.kind === "whistle" ? (
				<div className="cap">Local — no model or key. Ideal last resort.</div>
			) : (
				<>
					<input
						className="mono"
						value={entry.model}
						onChange={(ev) => onPatch({ model: ev.target.value })}
						placeholder={def.model}
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label={`fallback ${index + 1} model`}
					/>
					<KeyStatus
						token={token}
						name={effective}
						commandNames={authCommandNames}
						authNames={authNames}
						onStored={(n) => {
							rememberAuthName(n);
							onPatch({ auth: n });
						}}
					/>
				</>
			)}
			{entry.kind === "mimo" ? (
				<select
					aria-label={`fallback ${index + 1} language`}
					value={entry.language}
					onChange={(ev) => onPatch({ language: ev.target.value })}
				>
					<option value="">Detect</option>
					<option value="auto">Auto</option>
					<option value="zh">Chinese</option>
					<option value="en">English</option>
				</select>
			) : (
				<input
					className="mono"
					value={entry.language}
					onChange={(ev) => onPatch({ language: ev.target.value })}
					placeholder="language — blank detects"
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="off"
					aria-label={`fallback ${index + 1} language`}
				/>
			)}
		</>
	);
}

export function SettingsVoice({ ctx }: { ctx: SettingsCtx }) {
	const {
		draft,
		setDraft,
		patchDraft,
		patchTts,
		patchTranscription,
		setCapability,
		kinds,
		authNames,
		authCommandNames,
		serviceNames,
		token,
		rememberAuthName,
		last,
		ttsStash,
		trStash,
	} = ctx;
	const tts = draft.tts;
	const tr = draft.transcription;
	return (
		<>
			<h2 className="ops-h2">Speaking</h2>
			<div className="card">
				<Row
					label="Text to speech"
					cap="Read replies aloud and send voice notes."
				>
					<Switch
						on={tts !== null}
						ariaLabel="text to speech"
						onChange={(on) =>
							setDraft((d) => {
								if (on) {
									return {
										...d,
										tts: last.current.tts ?? {
											kind: "edge",
											voice: "",
											rate: "",
											voices: [],
											model: "",
											auth: "",
										},
									};
								}
								last.current.tts = d.tts;
								return { ...d, tts: null };
							})
						}
					/>
				</Row>
				{tts !== null && (
					<>
						<Row
							label="Engine"
							cap={
								tts.kind === "edge"
									? "Free Microsoft voices, run through ffmpeg on this machine."
									: `Uses your ${displayName(serviceNames, tts.kind)} key.`
							}
						>
							<select
								className="mono"
								aria-label="tts kind"
								value={tts.kind}
								onChange={(e) =>
									setDraft((d) =>
										d.tts === null
											? d
											: {
													...d,
													tts: switchTtsKind(d.tts, e.target.value as TtsKind, ttsStash.current),
												},
									)
								}
							>
								{(["edge", "openrouter", "logfare", "mimo", "onemin"] as const).map((k) => (
									<option key={k} value={k}>
										{displayName(serviceNames, k)}
									</option>
								))}
							</select>
						</Row>
						{tts.kind !== "edge" && (
							<>
								<Field
									label="Model"
									value={tts.model}
									onChange={(v) => patchTts({ model: v })}
									// The defaults ride the settings response — an
									// old server predating a kind this client
									// offers answers without the key. Degrade to
									// the caption fallbacks; never throw here.
									placeholder={kinds.ttsDefaults[tts.kind]?.model}
									mono
									cap={`Blank uses ${kinds.ttsDefaults[tts.kind]?.model ?? "the kind's default"}.`}
								/>
								<Row label="Key">
									<KeyStatus
										token={token}
										name={tts.auth.trim() || (kinds.ttsDefaults[tts.kind]?.auth ?? "")}
										commandNames={authCommandNames}
										authNames={authNames}
										onStored={(n) => {
											rememberAuthName(n);
											patchTts({ auth: n });
										}}
									/>
								</Row>
							</>
						)}
						<Field
							label="Voice"
							value={tts.voice}
							onChange={(v) => patchTts({ voice: v })}
							placeholder={tts.kind === "edge" ? "en-US-AriaNeural" : "model default"}
							mono
							list={tts.kind === "edge" ? "goblin-voices" : undefined}
							cap={
								tts.kind === "edge"
									? "Default for /voice mode, the speaker button, and the speak tool — an alternate matching the reply's language wins."
									: "The upstream voice id. Blank speaks the model's default voice."
							}
						/>
						{tts.kind === "edge" && (
							<datalist id="goblin-voices">
								{VOICE_SUGGESTIONS.map((s) => (
									<option key={s} value={s} />
								))}
							</datalist>
						)}
						{tts.kind === "edge" && (
							<>
								<Field
									label="Rate"
									value={tts.rate}
									cap="Speed, like +10% or -5%."
									onChange={(v) => patchTts({ rate: v })}
									placeholder="+10%"
									mono
								/>
								<ChipsEditor
									values={tts.voices}
									onAdd={(v) =>
										setDraft((d) => ({
											...d,
											tts: d.tts === null ? d.tts : { ...d.tts, voices: [...d.tts.voices, v] },
										}))
									}
									onRemove={(i) =>
										setDraft((d) => ({
											...d,
											tts:
												d.tts === null
													? d.tts
													: { ...d.tts, voices: d.tts.voices.filter((_, j) => j !== i) },
										}))
									}
									placeholder="add a voice"
									ariaLabel="add alternate voice"
									suggestions={VOICE_SUGGESTIONS}
									cap="Alternate voices — picked by reply language wherever speech is synthesized. Only English and Spanish are recognized."
								/>
							</>
						)}
					</>
				)}
			</div>
			<h2 className="ops-h2">Transcription</h2>
			<div className="card">
				<Row
					label="Speech to text"
					cap="Voice and video notes are transcribed on arrival; the bot can transcribe other audio files on request."
				>
					<Switch
						on={tr !== null}
						ariaLabel="speech to text"
						onChange={(on) =>
							setDraft((d) => {
								if (on) {
									return {
										...d,
										capabilities: { ...d.capabilities, transcription: true },
										transcription: last.current.transcription ?? emptyTranscription(),
									};
								}
								last.current.transcription = d.transcription;
								return {
									...d,
									capabilities: { ...d.capabilities, transcription: false },
									transcription: null,
								};
							})
						}
					/>
				</Row>
				{tr !== null && (
					<>
						<Row
							label="Engine"
							cap={
									tr.kind === "whistle"
										? "Runs on this machine — no key."
										: `Uses your ${displayName(serviceNames, tr.kind)} key.`
								}
						>
							<select
								className="mono"
								aria-label="transcription kind"
								value={tr.kind}
								onChange={(e) => {
									const next = kinds.transcription.find((k) => k === e.target.value);
									if (next === undefined) return;
									setDraft((d) =>
										d.transcription === null
											? d
											: {
													...d,
													transcription: switchTranscriptionKind(
														d.transcription,
														next,
														trStash.current,
													),
												},
									);
								}}
							>
								{kinds.transcription.map((k) => (
									<option key={k} value={k}>
										{displayName(serviceNames, k)}
									</option>
								))}
							</select>
						</Row>
						{tr.kind === "whistle" ? (
							<>
								<ChipsEditor
									values={tr.keywords}
									onAdd={(v) => patchTranscription({ keywords: [...tr.keywords, v] })}
									onRemove={(i) =>
										patchTranscription({
											keywords: tr.keywords.filter((_, j) => j !== i),
										})
									}
									placeholder="add a word"
									ariaLabel="add keyword"
									cap="Names and words to recognize better."
								/>
								<Row label="Language" cap="Whistle recognizes these languages only.">
									<select
										aria-label="Transcription language"
										value={tr.language}
										onChange={(e) => patchTranscription({ language: e.target.value })}
									>
										<option value="">Automatic</option>
										{WHISTLE_LANGS.map((l) => (
											<option key={l} value={l}>
												{l}
											</option>
										))}
									</select>
								</Row>
							</>
						) : (
							<>
								<Field
									label="Model"
									value={tr.model}
									onChange={(v) => patchTranscription({ model: v })}
									placeholder="kind default"
									mono
									cap="Blank uses the kind's default."
								/>
								<Row label="Key">
									<KeyStatus
										token={token}
										name={tr.auth.trim() || kinds.trDefaults[tr.kind].auth}
										commandNames={authCommandNames}
										authNames={authNames}
										onStored={(n) => {
											rememberAuthName(n);
											patchTranscription({ auth: n });
										}}
									/>
								</Row>
								{tr.kind === "mimo" ? (
									<Row label="Language" cap="Blank lets the engine detect it.">
										<select
											aria-label="Transcription language"
											value={tr.language}
											onChange={(e) => patchTranscription({ language: e.target.value })}
										>
											<option value="">Detect</option>
											<option value="auto">Auto</option>
											<option value="zh">Chinese</option>
											<option value="en">English</option>
										</select>
									</Row>
								) : (
									<Field
										label="Language"
										value={tr.language}
										onChange={(v) => patchTranscription({ language: v })}
										placeholder="detect"
										mono
										cap={
											tr.kind === "onemin"
												? "An ISO code like es, or a locale like en-US. Blank detects on whisper-1, qwen3, and elevenlabs."
												: "An ISO code like es. Blank lets the engine detect it."
										}
									/>
								)}
							</>
						)}
						<div className="cap ops-cap">
							Fallbacks — tried in order after the engine above throws; a real answer (or genuine
							silence) ends the chain.
						</div>
						{tr.fallbacks.map((e, i) => (
							<div className="chain-card" key={`${i}:${e.kind}`}>
								<div className="chain-head">
									<span className="chain-num">{i + 1}</span>
									<span className="chain-btns">
										<button
											type="button"
											aria-label={`move fallback ${i + 1} up`}
											disabled={i === 0}
											onClick={() => {
												const j = i - 1;
												const next = tr.fallbacks.slice();
												next[i] = next[j]!;
												next[j] = tr.fallbacks[i]!;
												patchTranscription({ fallbacks: next });
											}}
										>
											↑
										</button>
										<button
											type="button"
											aria-label={`move fallback ${i + 1} down`}
											disabled={i === tr.fallbacks.length - 1}
											onClick={() => {
												const j = i + 1;
												const next = tr.fallbacks.slice();
												next[i] = next[j]!;
												next[j] = tr.fallbacks[i]!;
												patchTranscription({ fallbacks: next });
											}}
										>
											↓
										</button>
										<button
											type="button"
											aria-label={`remove fallback ${i + 1}`}
											onClick={() =>
												patchTranscription({
													fallbacks: tr.fallbacks.filter((_, j) => j !== i),
												})
											}
										>
											×
										</button>
									</span>
								</div>
								<TrFallbackCard
									entry={e}
									index={i}
									ctx={ctx}
									// Identity, not index — an edit landing after a
									// reorder must not retarget a sibling.
									onPatch={(p) =>
										setDraft((d) =>
											d.transcription === null
												? d
												: {
														...d,
														transcription: {
															...d.transcription,
															fallbacks: d.transcription.fallbacks.map((x) =>
																x === e ? { ...x, ...p } : x,
															),
														},
													},
										)
									}
								/>
							</div>
						))}
						<button
							className="ghost"
							type="button"
							disabled={tr.fallbacks.length >= 4}
							onClick={() => {
								const first = kinds.transcription[0];
								if (first === undefined) return;
								patchTranscription({ fallbacks: [...tr.fallbacks, emptyTrEntry(first)] });
							}}
						>
							+ Add fallback
						</button>
					</>
				)}
			</div>
		</>
	);
}
