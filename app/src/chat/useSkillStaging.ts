import { useRef, useState } from "react";
import type { Chip, SkillChip } from "./draft.ts";

export function useSkillStaging({
	insertChips,
}: {
	insertChips: (chips: Chip[]) => void;
}) {
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	const insertChipsRef = useRef(insertChips);
	insertChipsRef.current = insertChips;
	const stageSkill = (picked: { name: string; ref: SkillChip["ref"] }) =>
		insertChipsRef.current([{ kind: "skill", ref: picked.ref }]);

	return {
		skillPickerOpen,
		setSkillPickerOpen,
		stageSkill,
	};
}
