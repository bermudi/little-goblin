import { type CSSProperties, useState } from "react";

// A row already flattened for display — App owns the title/preview rules.
export type ArchiveRow = {
	id: string;
	label: string;
	preview: string | null;
	archivedAt: string;
	updatedAt: string;
};

// Rows render in slices: the page exists because the archive gets long.
const PAGE_SIZE = 100;

const ARCHIVE_COLS = {
	"--dt-cols": "minmax(12rem, 3fr) 6rem 6rem 11rem",
} as CSSProperties;

const monthOf = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});
const dayOf = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});

// /app/archive — every shelved chat, newest-archived first, grouped by
// the month it was archived. The rail only links here; a long archive
// never crowds the rail (design/app.md → Archive page).
export function ArchiveView({
	rows,
	error,
	onOpen,
	onUnarchive,
	onDelete,
}: {
	rows: ArchiveRow[];
	error: string | null;
	onOpen: (id: string) => void;
	onUnarchive: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const [filter, setFilter] = useState("");
	const [shown, setShown] = useState(PAGE_SIZE);
	const needle = filter.trim().toLowerCase();
	const matching =
		needle === ""
			? rows
			: rows.filter((r) => `${r.label} ${r.preview ?? ""}`.toLowerCase().includes(needle));
	const visible = matching.slice(0, shown);

	const groups: { month: string; rows: ArchiveRow[] }[] = [];
	for (const r of visible) {
		const month = monthOf(r.archivedAt);
		const last = groups[groups.length - 1];
		if (last?.month === month) last.rows.push(r);
		else groups.push({ month, rows: [r] });
	}

	return (
		<div className="ops">
			<h2 className="ops-h2">
				Archive <span className="count">{rows.length}</span>
			</h2>
			{rows.length > 0 && (
				<input
					className="rail-search ops-search"
					type="search"
					placeholder="Filter archived chats"
					aria-label="Filter archived chats"
					value={filter}
					onChange={(e) => {
						setFilter(e.target.value);
						setShown(PAGE_SIZE);
					}}
				/>
			)}
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{rows.length === 0 && (
				<p className="empty">Nothing archived — archive a chat from the rail to shelve it here.</p>
			)}
			{rows.length > 0 && matching.length === 0 && (
				<p className="empty">No archived chat matches.</p>
			)}
			{groups.map((g, i) => (
				<section key={g.month}>
					<h3 className="ops-h3">{g.month}</h3>
					<div className="dtable archive-table" style={ARCHIVE_COLS}>
						{i === 0 && (
							<div className="dt-head" aria-hidden="true">
								<span>Chat</span>
								<span>Archived</span>
								<span>Last active</span>
								<span />
							</div>
						)}
						{g.rows.map((r) => (
							<div className="dt-row" key={r.id}>
								<a
									className="dt-cell dt-main"
									href={`/app/c/${r.id.slice("app/".length)}`}
									onClick={(e) => {
										if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
										e.preventDefault();
										onOpen(r.id);
									}}
								>
									{r.label}
									{r.preview !== null && <small>{r.preview}</small>}
								</a>
								<span className="dt-cell dt-hide-m" data-label="Archived">
									{dayOf(r.archivedAt)}
								</span>
								<span className="dt-cell dt-hide-m" data-label="Last active">
									{dayOf(r.updatedAt)}
								</span>
								<span className="dt-cell dt-status dt-actions">
									<button type="button" className="ghost" onClick={() => onUnarchive(r.id)}>
										Unarchive
									</button>
									<button
										type="button"
										className="ghost"
										title="Delete"
										aria-label={`Delete ${r.label}`}
										onClick={() => onDelete(r.id)}
									>
										Delete
									</button>
								</span>
							</div>
						))}
					</div>
				</section>
			))}
			{matching.length > visible.length && (
				<button type="button" className="ghost" onClick={() => setShown((n) => n + PAGE_SIZE)}>
					Show more ({matching.length - visible.length} left)
				</button>
			)}
		</div>
	);
}
