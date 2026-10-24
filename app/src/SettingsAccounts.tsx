// Accounts & keys — the ChatGPT sign-in card, the model services
// (providers), and one status line per service key the draft names.
// Secret values are never editable here: keys land through KeyStatus's
// paste box only.

import { useState } from "react";
import type { ProviderPreset } from "../../src/http/operator-wire.ts";
import { ChatGptAccount } from "./ChatGptAccount.tsx";
import {
	type ChainEntry,
	FETCH_META,
	type KindMeta,
	type ProvDraft,
	SEARCH_META,
	switchProviderKind,
} from "./settingsDraft.ts";
import { authDefault, displayName, KeyStatus, type SettingsCtx } from "./settingsKit.tsx";

// The provider's effective key record — explicit auth, else the
// materialized name (openrouter's kind default, otherwise its own).
const effectiveAuth = (p: ProvDraft, openrouterDefault: string): string =>
	p.auth.trim() || (p.kind === "openrouter" ? openrouterDefault : p.name.trim());

// A provider equals a preset when the name, kind, and (for endpoints)
// the base url all agree — the preset's display name then wins.
const presetFor = (p: ProvDraft, presets: ProviderPreset[]): ProviderPreset | undefined =>
	presets.find((pr) => {
		if (pr.id !== p.name || pr.provider.kind !== p.kind) return false;
		const pb = "baseUrl" in pr.provider ? pr.provider.baseUrl : undefined;
		return pb === undefined || pb === p.baseUrl;
	});

function ServiceCard({ prov, ctx }: { prov: ProvDraft; ctx: SettingsCtx }) {
	const {
		provs: _p,
		kinds,
		authNames,
		authCommandNames,
		serviceNames,
		providerPresets,
		token,
		providerRefs,
		removeProvider,
		patchProv,
		renameProvider,
		reportNameDirty,
		rememberAuthName,
	} = ctx;
	const [nameDraft, setNameDraft] = useState(prov.name);
	const [nameErr, setNameErr] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const preset = presetFor(prov, providerPresets);
	const label = preset?.name ?? prov.name;
	const commitName = () => {
		const v = nameDraft.trim();
		if (v === prov.name) {
			setNameDraft(prov.name);
			setNameErr(null);
			return;
		}
		const err = renameProvider(prov.id, v);
		if (err !== null) {
			setNameDraft(prov.name);
			setNameErr(err);
		} else setNameErr(null);
	};
	const refs = prov.name === "" ? [] : providerRefs(prov.name);
	const effective = effectiveAuth(prov, kinds.authDefaults.openrouter);
	// The edit disclosure needs the kind list minus the two kinds this
	// section never offers: codex signs in above, openrouter is a preset.
	const editableKinds = kinds.provider.filter((k) => k !== "codex" && k !== "openrouter");
	return (
		<div className="chain-card">
			<div className="chain-head">
				<span className="fav-cell">
					<span className="fav-name">{label}</span>
					{label !== prov.name && <span className="fav-ref">{prov.name}</span>}
					{refs.length > 0 && <span className="fav-ref">Used by {refs.join(", ")}</span>}
				</span>
				<KeyStatus
					token={token}
					name={effective}
					commandNames={authCommandNames}
					authNames={authNames}
					onStored={(n) => {
						rememberAuthName(n);
						patchProv(prov.id, { auth: n });
					}}
				/>
				<span className="chain-btns">
					<button type="button" aria-label={`edit ${prov.name}`} onClick={() => setOpen((o) => !o)}>
						{open ? "Done" : "Edit"}
					</button>
					<button
						type="button"
						aria-label={`remove ${prov.name}`}
						onClick={() => removeProvider(prov)}
					>
						×
					</button>
				</span>
			</div>
			{nameErr !== null && <div className="cap err-inline">{nameErr}</div>}
			{open && (
				<>
					<div className="frow">
						<label className="flabel">Name</label>
						<input
							className="mono"
							value={nameDraft}
							onChange={(e) => {
								setNameDraft(e.target.value);
								reportNameDirty(prov.id, e.target.value !== prov.name);
							}}
							onBlur={() => {
								commitName();
								reportNameDirty(prov.id, false);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") (e.target as HTMLInputElement).blur();
							}}
							autoComplete="off"
							spellCheck={false}
							autoCapitalize="off"
							aria-label="service name"
						/>
					</div>
					<div className="frow">
						<label className="flabel">Protocol</label>
						<select
							className="mono"
							value={prov.kind}
							aria-label="protocol"
							onChange={(e) => patchProv(prov.id, switchProviderKind(prov, e.target.value))}
						>
							{editableKinds.map((k) => (
								<option key={k} value={k}>
									{k === "openai-compatible"
										? "OpenAI-compatible (Chat Completions)"
										: k === "responses"
											? "OpenAI Responses"
											: (serviceNames[k] ?? k)}
								</option>
							))}
						</select>
					</div>
					{(prov.kind === "openai-compatible" || prov.kind === "responses") && (
						<div className="frow">
							<label className="flabel">Base url</label>
							<input
								className="mono"
								value={prov.baseUrl}
								onChange={(e) => patchProv(prov.id, { baseUrl: e.target.value })}
								placeholder="https://…"
								autoComplete="off"
								spellCheck={false}
								autoCapitalize="off"
								aria-label="base url"
							/>
						</div>
					)}
				</>
			)}
		</div>
	);
}

// Distinct key records the draft's services reference, with the
// surfaces that use them — surfaced so a missing or stored key is
// visible without hunting through chains.
function serviceKeys(ctx: SettingsCtx): { name: string; label: string; users: string[] }[] {
	const { draft, kinds, serviceNames } = ctx;
	const byName = new Map<string, { label: string; users: Set<string> }>();
	const add = (name: string, kindLabel: string, user: string) => {
		if (name === "") return;
		const e = byName.get(name) ?? { label: kindLabel, users: new Set<string>() };
		e.users.add(user);
		byName.set(name, e);
	};
	const chain = (entries: ChainEntry[] | null, meta: Record<string, KindMeta>, user: string) =>
		(entries ?? []).forEach((e) => {
			if (meta[e.kind]?.auth === "none") return;
			add(
				e.auth.trim() || authDefault(kinds.authDefaults, e.kind),
				displayName(serviceNames, e.kind),
				user,
			);
		});
	chain(draft.search, SEARCH_META, "Search");
	chain(draft.fetch, FETCH_META, "Page reading");
	if (draft.tts !== null && draft.tts.kind !== "edge") {
		add(
			draft.tts.auth.trim() || kinds.ttsDefaults[draft.tts.kind].auth,
			displayName(serviceNames, draft.tts.kind),
			"Speaking",
		);
	}
	if (draft.transcription !== null) {
		const tr = [draft.transcription, ...draft.transcription.fallbacks];
		for (const e of tr)
			if (e.kind !== "whistle")
				add(
					e.auth.trim() || kinds.trDefaults[e.kind].auth,
					displayName(serviceNames, e.kind),
					"Transcription",
				);
	}
	if (draft.memory !== null && draft.memory.auth.trim() !== "")
		add(draft.memory.auth.trim(), "Hindsight", "Memory");
	return [...byName.entries()].map(([name, v]) => ({
		name,
		label: v.label,
		users: [...v.users],
	}));
}

export function SettingsAccounts({ ctx }: { ctx: SettingsCtx }) {
	const { token, provs, addProv, providerPresets, kinds, authNames, authCommandNames, reload } =
		ctx;
	const services = provs.filter((p) => p.kind !== "codex");
	const [addOpen, setAddOpen] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const [custom, setCustom] = useState({ name: "", protocol: "openai-compatible", baseUrl: "" });
	const missingPresets = providerPresets.filter((pr) => !provs.some((p) => p.name === pr.id));
	const keys = serviceKeys(ctx);
	return (
		<>
			<ChatGptAccount token={token} onSignedIn={reload} />
			<h2 className="ops-h2">Model services</h2>
			<div className="card">
				{services.map((p) => (
					<ServiceCard key={p.id} prov={p} ctx={ctx} />
				))}
				{!addOpen && (
					<button className="ghost" type="button" onClick={() => setAddOpen(true)}>
						+ Add model service
					</button>
				)}
				{addOpen && (
					<div className="addrow">
						<select
							aria-label="add a service"
							value=""
							onChange={(e) => {
								if (e.target.value === "__custom") {
									setCustomOpen(true);
									return;
								}
								const pr = providerPresets.find((x) => x.id === e.target.value);
								if (pr !== undefined) {
									const w = pr.provider as { baseUrl?: string; auth?: string };
									addProv({
										name: pr.id,
										kind: pr.provider.kind,
										baseUrl: w.baseUrl ?? "",
										auth: w.auth ?? "",
									});
									setAddOpen(false);
								}
							}}
						>
							<option value="">Add…</option>
							{missingPresets.map((pr) => (
								<option key={pr.id} value={pr.id}>
									{pr.name}
								</option>
							))}
							<option value="__custom">Custom endpoint…</option>
						</select>
						<button
							className="addbtn"
							type="button"
							onClick={() => {
								setAddOpen(false);
								setCustomOpen(false);
							}}
						>
							Cancel
						</button>
					</div>
				)}
				{addOpen && customOpen && (
					<>
						<div className="cap ops-cap">Custom endpoint</div>
						<div className="frow">
							<label className="flabel">Name</label>
							<input
								className="mono"
								value={custom.name}
								onChange={(e) => setCustom({ ...custom, name: e.target.value })}
								placeholder="my-endpoint"
								autoComplete="off"
								aria-label="service name"
							/>
						</div>
						<div className="frow">
							<label className="flabel">Protocol</label>
							<select
								value={custom.protocol}
								aria-label="custom protocol"
								onChange={(e) => setCustom({ ...custom, protocol: e.target.value })}
							>
								<option value="openai-compatible">OpenAI-compatible (Chat Completions)</option>
								<option value="responses">OpenAI Responses</option>
							</select>
						</div>
						<div className="frow">
							<label className="flabel">Base url</label>
							<input
								className="mono"
								value={custom.baseUrl}
								onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })}
								placeholder="https://…"
								aria-label="custom base url"
							/>
						</div>
						<button
							className="addbtn"
							type="button"
							disabled={custom.name.trim() === "" || custom.baseUrl.trim() === ""}
							onClick={() => {
								addProv({
									name: custom.name.trim(),
									kind: custom.protocol,
									baseUrl: custom.baseUrl.trim(),
									auth: "",
								});
								setCustom({ name: "", protocol: "openai-compatible", baseUrl: "" });
								setAddOpen(false);
								setCustomOpen(false);
							}}
						>
							Add service
						</button>
					</>
				)}
			</div>
			<h2 className="ops-h2">Service keys</h2>
			<div className="card">
				{keys.length === 0 && (
					<div className="cap">
						Keys for search and voice services appear here once you use them.
					</div>
				)}
				{keys.map((k) => (
					<div className="frow" key={k.name}>
						<span className="flabel" title={k.name}>
							{k.label}
						</span>
						<div className="cap">{k.users.join(" · ")}</div>
						<KeyStatus
							token={token}
							name={k.name}
							commandNames={authCommandNames}
							authNames={authNames}
							onStored={ctx.rememberAuthName}
						/>
					</div>
				))}
			</div>
		</>
	);
}
