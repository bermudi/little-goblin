// Web — the search chain and the page-reading chain. Ordered lists of
// services by display name; keys are managed through KeyStatus, never
// typed as names.

import { type ChainEntry, FETCH_META, type KindMeta, SEARCH_META } from "./settingsDraft.ts";
import {
	authDefault,
	displayName,
	KeyStatus,
	OrderedList,
	Row,
	type SettingsCtx,
	Switch,
} from "./settingsKit.tsx";

// One chain rendered as ordered service rows. `keyless` kinds skip the
// key status entirely; the add-select lists only kinds not yet in use.
function ServiceChain({
	entries,
	kinds,
	meta,
	ctx,
	onChange,
}: {
	entries: ChainEntry[];
	kinds: readonly string[];
	meta: Record<string, KindMeta>;
	ctx: SettingsCtx;
	onChange: (next: ChainEntry[] | ((current: ChainEntry[]) => ChainEntry[])) => void;
}) {
	const { token, authNames, authCommandNames, kinds: kd, serviceNames, rememberAuthName } = ctx;
	const used = new Set(entries.map((e) => e.kind));
	const rest = kinds.filter((k) => !used.has(k));
	const move = (i: number, d: number) => {
		const j = i + d;
		if (j < 0 || j >= entries.length) return;
		const next = entries.slice();
		next[i] = entries[j]!;
		next[j] = entries[i]!;
		onChange(next);
	};
	return (
		<>
			<OrderedList
				items={entries.map((e) => {
					const effective = e.auth.trim() || authDefault(kd.authDefaults, e.kind);
					// Keyless means never takes a key, or optional-with-none-set
					// (e.g. jina reading public pages).
					const keyless =
						meta[e.kind]?.auth === "none" ||
						(meta[e.kind]?.auth === "optional" && effective === "");
					return {
						key: e.kind,
						label: displayName(serviceNames, e.kind),
						aside: (
							<KeyStatus
								token={token}
								name={effective}
								keyless={keyless}
								commandNames={authCommandNames}
								authNames={authNames}
								onStored={(n) => {
									rememberAuthName(n);
									// Current-state map — a store resolving after a
									// remove/reorder must not resurrect a stale row.
									onChange((current) => current.map((x) => (x === e ? { ...x, auth: n } : x)));
								}}
							/>
						),
					};
				})}
				onMove={move}
				onRemove={(i) => onChange(entries.filter((_, j) => j !== i))}
			/>
			{rest.length > 0 && (
				<div className="addrow">
					<select
						aria-label="add a service"
						value=""
						onChange={(e) => {
							const kind = e.target.value;
							if (kind !== "") onChange([...entries, { kind, auth: "" }]);
						}}
					>
						<option value="">+ Add a service</option>
						{rest.map((k) => (
							<option key={k} value={k}>
								{displayName(serviceNames, k)}
								{meta[k]?.auth === "none" ? " (no key)" : ""}
							</option>
						))}
					</select>
				</div>
			)}
		</>
	);
}

export function SettingsWeb({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, setDraft, kinds, last } = ctx;
	// Page reading with no custom chain is the built-in extractor —
	// rendered as its one row; removing it (or leaving it alone)
	// saves "".
	const fetchShown = draft.fetch === null ? [{ kind: "local", auth: "" }] : draft.fetch;
	const writeFetch = (next: ChainEntry[] | ((current: ChainEntry[]) => ChainEntry[])) =>
		setDraft((d) => {
			const cur = d.fetch === null ? [{ kind: "local", auth: "" }] : d.fetch;
			const resolved = typeof next === "function" ? next(cur) : next;
			const real = resolved.filter((e) => e.kind !== "local" || e.auth.trim() !== "");
			return { ...d, fetch: real.length === 0 ? null : resolved };
		});
	return (
		<>
			<h2 className="ops-h2">Search</h2>
			<div className="card">
				<Row label="Web search" cap="Off removes search from the agent's tools.">
					<Switch
						on={draft.search !== null}
						ariaLabel="web search"
						onChange={(on) =>
							setDraft((d) => {
								if (on) return { ...d, search: last.current.search ?? [] };
								last.current.search = d.search;
								return { ...d, search: null };
							})
						}
					/>
				</Row>
				{draft.search !== null && (
					<>
						<ServiceChain
							entries={draft.search}
							kinds={kinds.search}
							meta={SEARCH_META}
							ctx={ctx}
							onChange={(next) =>
								setDraft((d) => ({
									...d,
									search:
										typeof next === "function"
											? // A store landing after the switch went off
												// must not resurrect the disabled chain.
												d.search === null
												? null
												: next(d.search)
											: next,
								}))
							}
						/>
						<div className="cap ops-cap">
							Tried top to bottom; a failure moves to the next. No results is an answer.
						</div>
					</>
				)}
			</div>
			<h2 className="ops-h2">Page reading</h2>
			<div className="card">
				<div className="cap ops-cap">
					Pages are read top to bottom through these services. JS-heavy sites need the browser skill
					either way.
				</div>
				<ServiceChain
					entries={fetchShown}
					kinds={kinds.fetch}
					meta={FETCH_META}
					ctx={ctx}
					onChange={writeFetch}
				/>
			</div>
		</>
	);
}
