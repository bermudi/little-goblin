"""Canonical parser and mechanical validator for Nospec batch queues."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

VALID_STATUSES = frozenset(
    {"pending", "in_progress", "verify_failed", "no_progress", "blocked", "done"}
)
HEADING_RE = re.compile(r"^##(?:[ \t]+(.*?))?[ \t]*\r?\n?$")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$")
STATUS_RE = re.compile(r"^Status:[ \t]*(.*?)[ \t]*\r?\n?$")
AGENT_RE = re.compile(r"^Agent:[ \t]*(.*?)[ \t]*\r?\n?$")
VERIFY_RE = re.compile(r"^Verify:[ \t]*\r?\n?$")
CONTENT_FIELD_RE = re.compile(
    r"^(Read first|Constraints|Done means):[ \t]*(.*?)[ \t]*\r?\n?$"
)
FIELD_BOUNDARY_RE = re.compile(
    r"^(?:Agent|Why|Read first|Constraints|Done means|Verify|Status):"
)


@dataclass(frozen=True)
class Diagnostic:
    line: int
    message: str


@dataclass(frozen=True)
class WorkUnit:
    ordinal: int
    title: str
    start: int
    end: int
    start_line: int
    status: str
    status_index: int
    verify: str
    verify_line: int
    agent: str | None
    body: str


def _fence_open(line: str) -> tuple[str, int, str] | None:
    match = FENCE_RE.match(line)
    if match is None:
        return None
    marker = match.group(1)
    return marker[0], len(marker), match.group(2).strip()


def _fence_close(line: str, character: str, length: int) -> bool:
    return (
        re.match(rf"^ {{0,3}}{re.escape(character)}{{{length},}}[ \t]*\r?\n?$", line)
        is not None
    )


def _outside_fence_lines(lines: list[str]) -> tuple[list[bool], int | None]:
    outside: list[bool] = []
    fence_character: str | None = None
    fence_length = 0
    fence_start: int | None = None
    for index, line in enumerate(lines):
        if fence_character is None:
            outside.append(True)
            opened = _fence_open(line)
            if opened is not None:
                fence_character, fence_length, _ = opened
                fence_start = index
        else:
            outside.append(False)
            if _fence_close(line, fence_character, fence_length):
                fence_character = None
                fence_length = 0
                fence_start = None
    return outside, fence_start


def _field_has_content(
    lines: list[str], outside: list[bool], index: int, end: int
) -> bool:
    for candidate in range(index + 1, end):
        if not outside[candidate]:
            continue
        if FIELD_BOUNDARY_RE.match(lines[candidate]) is not None:
            break
        if lines[candidate].strip():
            return True
    return False


def _verify_is_obviously_vacuous(command: str) -> bool:
    meaningful_lines = [
        line.strip()
        for line in command.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not meaningful_lines:
        return True
    if len(meaningful_lines) != 1:
        return False
    return (
        re.fullmatch(
            r"(?:true|:|exit[ \t]+0)[ \t]*;?[ \t]*(?:#.*)?",
            meaningful_lines[0],
        )
        is not None
    )


def _shell_diagnostic(command: str, source_line: int, label: str) -> Diagnostic | None:
    result = subprocess.run(
        ["bash", "-n"],
        input=command,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        return None
    message = (
        result.stderr.strip().splitlines()[-1]
        if result.stderr.strip()
        else "invalid shell syntax"
    )
    match = re.search(r"line (\d+)", message)
    line = source_line + int(match.group(1)) - 1 if match is not None else source_line
    return Diagnostic(line, f"invalid {label} shell syntax: {message}")


def parse_queue(
    path: Path, *, validate_shell: bool = True
) -> tuple[list[WorkUnit], list[Diagnostic]]:
    text = path.read_text()
    lines = text.splitlines(keepends=True)
    outside, unclosed_fence = _outside_fence_lines(lines)
    diagnostics: list[Diagnostic] = []

    starts: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        if not outside[index]:
            continue
        match = HEADING_RE.match(line)
        if match is None:
            continue
        title = (match.group(1) or "").strip()
        starts.append((index, title))

    if not starts:
        diagnostics.append(
            Diagnostic(1, "queue has no work units (`## <outcome>` headings)")
        )
    if unclosed_fence is not None:
        diagnostics.append(Diagnostic(unclosed_fence + 1, "unclosed Markdown fence"))

    units: list[WorkUnit] = []
    for ordinal, (start, title) in enumerate(starts, start=1):
        end = starts[ordinal][0] if ordinal < len(starts) else len(lines)
        start_line = start + 1
        if not title:
            diagnostics.append(Diagnostic(start_line, "work unit outcome is empty"))

        status_matches: list[tuple[int, str]] = []
        agent_matches: list[tuple[int, str]] = []
        verify_labels: list[int] = []
        content_fields: dict[str, list[tuple[int, str]]] = {
            "Read first": [],
            "Constraints": [],
            "Done means": [],
        }
        for index in range(start + 1, end):
            if not outside[index]:
                continue
            status_match = STATUS_RE.match(lines[index])
            if status_match is not None:
                status_matches.append((index, status_match.group(1).strip()))
                continue
            agent_match = AGENT_RE.match(lines[index])
            if agent_match is not None:
                agent_matches.append((index, agent_match.group(1).strip()))
                continue
            if VERIFY_RE.match(lines[index]) is not None:
                verify_labels.append(index)
                continue
            content_match = CONTENT_FIELD_RE.match(lines[index])
            if content_match is not None:
                content_fields[content_match.group(1)].append(
                    (index, content_match.group(2))
                )

        for field in ("Read first", "Constraints", "Done means"):
            matches = content_fields[field]
            if not matches:
                if field == "Done means":
                    diagnostics.append(
                        Diagnostic(start_line, "missing Done means field")
                    )
                continue
            if len(matches) > 1:
                diagnostics.append(
                    Diagnostic(matches[1][0] + 1, f"duplicate {field} fields")
                )
                continue
            field_index, inline = matches[0]
            if inline:
                diagnostics.append(
                    Diagnostic(
                        field_index + 1,
                        f"{field} content must start on the following line",
                    )
                )
            elif not _field_has_content(lines, outside, field_index, end):
                diagnostics.append(
                    Diagnostic(field_index + 1, f"{field} field is empty")
                )

        status = ""
        status_index = -1
        if len(status_matches) != 1:
            message = (
                "missing Status field"
                if not status_matches
                else "duplicate Status fields"
            )
            diagnostics.append(Diagnostic(start_line, message))
        else:
            status_index, status = status_matches[0]
            if status not in VALID_STATUSES:
                allowed = ", ".join(sorted(VALID_STATUSES))
                diagnostics.append(
                    Diagnostic(
                        status_index + 1,
                        f"unknown status `{status}` (expected one of: {allowed})",
                    )
                )

        agent: str | None = None
        if len(agent_matches) > 1:
            diagnostics.append(
                Diagnostic(agent_matches[1][0] + 1, "duplicate Agent fields")
            )
        elif agent_matches:
            agent_index, agent = agent_matches[0]
            if not agent:
                diagnostics.append(
                    Diagnostic(agent_index + 1, "Agent override is empty")
                )
            elif validate_shell:
                shell_error = _shell_diagnostic(agent, agent_index + 1, "Agent")
                if shell_error is not None:
                    diagnostics.append(shell_error)

        verify = ""
        verify_line = start_line
        if len(verify_labels) != 1:
            message = (
                "missing Verify field"
                if not verify_labels
                else "duplicate Verify fields"
            )
            diagnostics.append(Diagnostic(start_line, message))
        else:
            label_index = verify_labels[0]
            opening_index = label_index + 1
            while opening_index < end and not lines[opening_index].strip():
                opening_index += 1
            opened = _fence_open(lines[opening_index]) if opening_index < end else None
            if opened is None or opened[2] != "bash":
                diagnostics.append(
                    Diagnostic(
                        label_index + 1,
                        "Verify must be followed by a fenced `bash` block",
                    )
                )
            else:
                character, length, _ = opened
                closing_index = opening_index + 1
                while closing_index < end and not _fence_close(
                    lines[closing_index], character, length
                ):
                    closing_index += 1
                if closing_index >= end:
                    diagnostics.append(
                        Diagnostic(opening_index + 1, "Verify fence is not closed")
                    )
                else:
                    verify = "".join(lines[opening_index + 1 : closing_index])
                    verify_line = opening_index + 2
                    if not verify.strip():
                        diagnostics.append(
                            Diagnostic(verify_line, "Verify command is empty")
                        )
                    elif _verify_is_obviously_vacuous(verify):
                        diagnostics.append(
                            Diagnostic(
                                verify_line,
                                "Verify command is obviously vacuous; assert the unit outcome",
                            )
                        )
                    elif validate_shell:
                        shell_error = _shell_diagnostic(verify, verify_line, "Verify")
                        if shell_error is not None:
                            diagnostics.append(shell_error)

        units.append(
            WorkUnit(
                ordinal=ordinal,
                title=title,
                start=start,
                end=end,
                start_line=start_line,
                status=status,
                status_index=status_index,
                verify=verify,
                verify_line=verify_line,
                agent=agent,
                body="".join(lines[start:end]),
            )
        )

    title_lines: dict[str, int] = {}
    for unit in units:
        if unit.title in title_lines:
            diagnostics.append(
                Diagnostic(
                    unit.start_line, f"duplicate work unit outcome `{unit.title}`"
                )
            )
        else:
            title_lines[unit.title] = unit.start_line

    return units, diagnostics


def _print_diagnostics(path: Path, diagnostics: list[Diagnostic]) -> None:
    for diagnostic in diagnostics:
        print(f"{path}:{diagnostic.line}: {diagnostic.message}", file=sys.stderr)


def _validated_units(path: Path, *, validate_shell: bool = False) -> list[WorkUnit]:
    units, diagnostics = parse_queue(path, validate_shell=validate_shell)
    if diagnostics:
        _print_diagnostics(path, diagnostics)
        raise SystemExit(1)
    return units


def command_validate(path: Path) -> None:
    _validated_units(path, validate_shell=True)


def command_first_pending(path: Path) -> None:
    for unit in _validated_units(path):
        if unit.status == "pending":
            sys.stdout.write(unit.body)
            return


def command_first_pending_title(path: Path) -> None:
    for unit in _validated_units(path):
        if unit.status == "pending":
            sys.stdout.write(unit.title)
            return


def _unit_by_title(path: Path, title: str) -> WorkUnit:
    units = _validated_units(path)
    matches = [unit for unit in units if unit.title == title]
    if len(matches) != 1:
        raise SystemExit(f"unit not found or ambiguous: {title}")
    return matches[0]


def command_unit_verify(path: Path, title: str) -> None:
    sys.stdout.write(_unit_by_title(path, title).verify)


def command_unit_agent(path: Path, title: str) -> None:
    agent = _unit_by_title(path, title).agent
    if agent is not None:
        sys.stdout.write(agent)


def command_set_status(path: Path, title: str, status: str) -> None:
    if status not in VALID_STATUSES:
        raise SystemExit(f"invalid status: {status}")
    unit = _unit_by_title(path, title)
    if unit.status_index < 0:
        raise SystemExit(f"unit has no Status field: {title}")
    lines = path.read_text().splitlines(keepends=True)
    current = lines[unit.status_index]
    newline = (
        "\r\n" if current.endswith("\r\n") else "\n" if current.endswith("\n") else ""
    )
    lines[unit.status_index] = f"Status: {status}{newline}"
    path.write_text("".join(lines))


def command_first_unresolved(path: Path) -> None:
    for unit in _validated_units(path):
        if unit.status != "done":
            print(f"{unit.title} (status: {unit.status})")
            return


def command_first_unresolved_title(path: Path) -> None:
    for unit in _validated_units(path):
        if unit.status != "done":
            sys.stdout.write(unit.title)
            return


def command_first_unresolved_status(path: Path) -> None:
    for unit in _validated_units(path):
        if unit.status != "done":
            sys.stdout.write(unit.status)
            return


def command_json(path: Path) -> None:
    units = _validated_units(path)
    print(
        json.dumps(
            [
                {
                    "ordinal": unit.ordinal,
                    "title": unit.title,
                    "status": unit.status,
                    "start_line": unit.start_line,
                }
                for unit in units
            ]
        )
    )


def usage() -> NoReturn:
    raise SystemExit(
        "usage: queue_parser.py validate|first-pending|first-pending-title|first-unresolved|first-unresolved-title|first-unresolved-status|json QUEUE | "
        "queue_parser.py unit-verify|unit-agent QUEUE TITLE | "
        "queue_parser.py set-status QUEUE TITLE STATUS"
    )


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        usage()
    command = argv[1]
    path = Path(argv[2])
    if command == "validate" and len(argv) == 3:
        command_validate(path)
    elif command == "first-pending" and len(argv) == 3:
        command_first_pending(path)
    elif command == "first-pending-title" and len(argv) == 3:
        command_first_pending_title(path)
    elif command == "first-unresolved" and len(argv) == 3:
        command_first_unresolved(path)
    elif command == "first-unresolved-title" and len(argv) == 3:
        command_first_unresolved_title(path)
    elif command == "first-unresolved-status" and len(argv) == 3:
        command_first_unresolved_status(path)
    elif command == "json" and len(argv) == 3:
        command_json(path)
    elif command == "unit-verify" and len(argv) == 4:
        command_unit_verify(path, argv[3])
    elif command == "unit-agent" and len(argv) == 4:
        command_unit_agent(path, argv[3])
    elif command == "set-status" and len(argv) == 5:
        command_set_status(path, argv[3], argv[4])
    else:
        usage()


if __name__ == "__main__":
    main(sys.argv)
