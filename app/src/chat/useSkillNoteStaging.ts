// Skills and notes staged for the next send: the two picker popovers'
// open state, their outside-press dismissal, and the deduping stage
// callbacks that write into the lifted staged lists.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppNoteSummary } from "../../../src/http/app-wire.ts";
import type { StagedNote, StagedSkill } from "./staged.ts";

// Staging dedups by reference, never display name — a catalog skill
// and a fetched copy that named itself the same are distinct skills,
// and two temp refs pin different sources. Catalog refs equal by
// name; temp refs by url and path together.
export const skillRefEquals = (a: StagedSkill["ref"], b: StagedSkill["ref"]): boolean =>
	"name" in a
		? "name" in b && a.name === b.name
		: "url" in b && a.url === b.url && a.path === b.path;

export function useSkillNoteStaging({
	setStagedNotes,
	setStagedSkills,
}: {
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
}) {
	const [notePickerOpen, setNotePickerOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	// Outside-press dismissal — the popover and its opener are both
	// exempt, or pointerdown on the opener would close it before its
	// own click could toggle.
	const notePickRef = useRef<HTMLDivElement | null>(null);
	const noteBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!notePickerOpen) return;
		const onPointer = (e: Event) => {
			const t = e.target as Node | null;
			if (notePickRef.current?.contains(t) === true || noteBtnRef.current?.contains(t) === true)
				return;
			setNotePickerOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setNotePickerOpen(false);
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [notePickerOpen]);

	// Intake expands the id into the authoritative snapshot; the
	// title rides along only so the just-sent chip isn't bare.
	const pickNote = (n: AppNoteSummary) =>
		setStagedNotes((p) =>
			p.some((e) => e.id === n.id)
				? p
				: [...p, { key: crypto.randomUUID(), id: n.id, title: n.title }],
		);

	const stageSkill = (picked: { name: string; ref: StagedSkill["ref"] }) =>
		setStagedSkills((p) =>
			p.some((e) => skillRefEquals(e.ref, picked.ref))
				? p
				: [...p, { key: crypto.randomUUID(), name: picked.name, ref: picked.ref }],
		);

	return {
		notePickerOpen,
		setNotePickerOpen,
		skillPickerOpen,
		setSkillPickerOpen,
		notePickRef,
		noteBtnRef,
		pickNote,
		stageSkill,
	};
}
