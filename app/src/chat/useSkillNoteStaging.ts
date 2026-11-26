import { useEffect, useRef, useState } from "react";
import type { AppNoteSummary } from "../../../src/http/app-wire.ts";
import type { Chip, SkillChip } from "./draft.ts";

export function useSkillNoteStaging({
	insertChips,
}: {
	insertChips: (chips: Chip[]) => void;
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
	const insertChipsRef = useRef(insertChips);
	insertChipsRef.current = insertChips;
	const pickNote = (n: AppNoteSummary) =>
		insertChipsRef.current([{ kind: "note", id: n.id, title: n.title }]);

	const stageSkill = (picked: { name: string; ref: SkillChip["ref"] }) =>
		insertChipsRef.current([{ kind: "skill", ref: picked.ref }]);

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
