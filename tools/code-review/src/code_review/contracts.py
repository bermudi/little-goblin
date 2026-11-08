"""Goblin code review harness — data contracts.

Every shape that crosses a boundary (configuration, model output, tool
arguments, persisted artifacts) is a pydantic v2 model. See
design/code-review.md → Data contracts.
"""

from __future__ import annotations

from enum import Enum
from pathlib import PurePosixPath
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --------------------------------------------------------------------------- requests


class ComparisonMode(str, Enum):
    DIRECT = "direct"
    FORK_POINT = "fork-point"


MODEL_PROVIDERS = (
    "litellm",
    "openai",
    "inference",
    "bedrock",
    "azure",
    "transformers",
    "vllm",
    "mlx",
)


class ModelSpec(BaseModel):
    """One runner/model identity, exactly as handed to smolagents.

    `api_key_env` names the environment variable holding the key; keys
    themselves are never accepted on the command line, in config output, or
    in logs.
    """

    model_config = ConfigDict(extra="forbid")

    provider: Literal[
        "litellm", "openai", "inference", "bedrock", "azure", "transformers", "vllm", "mlx"
    ]
    model_id: str
    api_base: str | None = None
    api_key_env: str | None = None
    extra: dict[str, object] = Field(default_factory=dict)

    def identity(self) -> tuple[str, str, str | None]:
        return (self.provider, self.model_id, self.api_base)


class Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_units: int = Field(default=25, ge=1, le=200)
    max_steps_per_unit: int = Field(default=12, ge=1, le=40)
    max_steps_per_candidate: int = Field(default=8, ge=1, le=30)
    unit_context_bytes: int = Field(default=60_000, ge=2_000)
    policy_bytes: int = Field(default=30_000, ge=1_000)
    read_range_lines: int = Field(default=400, ge=10)
    search_hits: int = Field(default=50, ge=1)
    search_line_chars: int = Field(default=200, ge=40)
    tool_budget_bytes: int = Field(default=120_000, ge=4_000)
    tool_calls_per_unit: int = Field(default=120, ge=1)
    unit_wall_seconds: float = Field(default=300.0, gt=0)
    challenge_wall_seconds: float = Field(default=180.0, gt=0)
    unit_token_ceiling: int | None = Field(default=None, ge=1)
    challenge_token_ceiling: int | None = Field(default=None, ge=1)
    max_reference_sites: int = Field(default=30, ge=1, le=200)


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repository: str
    mode: ComparisonMode
    base_ref: str
    head_ref: str
    scope: list[str] = Field(default_factory=list)
    discovery_model: ModelSpec
    challenge_model: ModelSpec
    limits: Limits = Field(default_factory=Limits)

    @field_validator("scope")
    @classmethod
    def _clean_scope(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for entry in value:
            p = PurePosixPath(entry)
            if entry.startswith("/") or ".." in p.parts:
                raise ValueError(f"scope entry must be repository-relative: {entry!r}")
            cleaned.append(entry.rstrip("/") or ".")
        return cleaned

    @model_validator(mode="after")
    def _distinct_pass_models(self) -> "ReviewRequest":
        if self.discovery_model.identity() == self.challenge_model.identity():
            raise ValueError(
                "discovery and challenge runner/model must be two distinct identities "
                f"(got {self.discovery_model.provider}:{self.discovery_model.model_id} twice)"
            )
        return self


# ------------------------------------------------------------------- snapshot


class SideSnapshot(BaseModel):
    commit: str
    tree: str
    dependency_lock_hash: str | None
    analyzer: dict[str, str]
    file_count: int


class Snapshot(BaseModel):
    base: SideSnapshot
    head: SideSnapshot
    merge_base: str | None
    scope: list[str]
    scope_hash: str
    excluded_paths: list[str]


# ----------------------------------------------------------------- locations


class Endpoint(str, Enum):
    BASE = "base"
    HEAD = "head"


class Location(BaseModel):
    """Bytes from one snapshot. Never the operator's checkout.

    `blob_id` is empty only at the model boundary: models propose
    (endpoint, path, lines) and the host rebinds the blob ID from the
    captured tree before a location can enter findings or artifacts.
    """

    model_config = ConfigDict(frozen=True)

    endpoint: Endpoint
    path: str
    blob_id: str = ""
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)

    @model_validator(mode="after")
    def _ordered(self) -> "Location":
        if self.end_line < self.start_line:
            raise ValueError("end_line before start_line")
        return self


# -------------------------------------------------------------- relationships


class RelationshipKind(str, Enum):
    DECLARES = "declares"
    RE_EXPORTS = "re-exports"
    IMPORTS = "imports"
    IMPORTS_TYPE = "imports-type"
    CALLS = "calls"
    REFERENCES = "references"
    TYPE_USES = "type-uses"
    CONTAINS = "contains"


class Basis(str, Enum):
    COMPILER_RESOLVED = "compiler-resolved"
    DECLARED = "explicitly declared"
    CANDIDATE = "candidate"


class Relationship(BaseModel):
    source: str
    target: str | None
    kind: RelationshipKind
    basis: Basis
    evidence: Location
    note: str | None = None


# ----------------------------------------------------------------- hunks/units


class FileChange(BaseModel):
    path: str
    old_path: str | None = None  # set on rename
    status: Literal["added", "deleted", "modified", "renamed", "typechange", "mode-only"]
    old_mode: str | None = None
    new_mode: str | None = None
    binary: bool = False


class Hunk(BaseModel):
    path: str
    old_start: int
    old_lines: int
    new_start: int
    new_lines: int


class ReadLogEntry(BaseModel):
    endpoint: Endpoint
    tool: str
    path: str
    blob_id: str | None
    start_line: int | None = None
    end_line: int | None = None
    bytes: int = 0


class ReviewUnit(BaseModel):
    unit_id: str
    title: str
    hunks: list[Hunk]
    changed_symbols: list[str]
    relationships: list[Relationship]
    design_clauses: list[str]
    context: str
    context_bytes: int
    omitted: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)


# -------------------------------------------------------------- candidates

Severity = Literal["critical", "high", "medium", "low"]


class Candidate(BaseModel):
    changed_cause: str
    trigger: str
    execution_path: str
    violated_contract: str
    consequence: str
    locations: list[Location]
    proposed_severity: Severity
    severity_rationale: str


# --------------------------------------------------------------- challenge


class ChallengeOutcome(str, Enum):
    SUPPORTED = "supported"
    DISPROVED = "disproved"
    UNRESOLVED = "unresolved"


class ChallengeResult(BaseModel):
    outcome: ChallengeOutcome
    rationale: str
    evidence: list[Location] = Field(default_factory=list)


class Finding(BaseModel):
    changed_cause: str
    trigger: str
    execution_path: str
    violated_contract: str
    consequence: str
    locations: list[Location]
    severity: Severity
    severity_rationale: str
    disproof: ChallengeResult


# ---------------------------------------------------------------- results


class UnitAccounting(BaseModel):
    unit_id: str
    title: str
    status: Literal["assessed", "budget-exhausted", "invalid-output", "failed", "skipped"]
    candidates: int
    tool_calls: int
    bytes_read: int
    wall_seconds: float
    input_tokens: int | None
    output_tokens: int | None
    model_steps: int | None
    gaps: list[str] = Field(default_factory=list)


class Coverage(BaseModel):
    units_total: int = 0
    units_assessed: int = 0
    hunks_in_scope: int = 0
    sources_read: int = 0
    read_log: list[ReadLogEntry] = Field(default_factory=list)
    unresolved_relations: list[str] = Field(default_factory=list)
    omitted: list[str] = Field(default_factory=list)
    unsupported_files: list[str] = Field(default_factory=list)
    budget_exhausted: list[str] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    per_unit: list[UnitAccounting] = Field(default_factory=list)

    def gap_count(self) -> int:
        return (
            len(self.unresolved_relations)
            + len(self.omitted)
            + len(self.unsupported_files)
            + len(self.budget_exhausted)
            + len(self.failures)
            + sum(len(u.gaps) for u in self.per_unit)
            + sum(1 for u in self.per_unit if u.status != "assessed")
        )


class ResultBase(BaseModel):
    request: ReviewRequest
    snapshot: Snapshot
    analyzer: dict[str, str]
    findings: list[Finding] = Field(default_factory=list)
    preexisting_candidates: list[Candidate] = Field(default_factory=list)
    unresolved_candidates: list[dict] = Field(default_factory=list)
    coverage: Coverage
    applicability: str | None = None
    duration_seconds: float


class ReviewComplete(ResultBase):
    status: Literal["complete"] = "complete"

    @model_validator(mode="after")
    def _full_coverage_required(self) -> "ReviewComplete":
        cov = self.coverage
        if cov.units_total == 0 or cov.units_assessed != cov.units_total:
            raise ValueError("a complete result requires every unit to be assessed")
        if cov.gap_count() != 0:
            raise ValueError("a complete result cannot carry gaps; use partial")
        if self.unresolved_candidates:
            raise ValueError("a complete result cannot carry unresolved candidates")
        return self


class ReviewPartial(ResultBase):
    status: Literal["partial"] = "partial"

    @model_validator(mode="after")
    def _gaps_required(self) -> "ReviewPartial":
        if self.coverage.gap_count() == 0 and not self.unresolved_candidates:
            raise ValueError("a partial result must carry explicit gaps")
        return self


class ReviewFailed(BaseModel):
    status: Literal["failed"] = "failed"
    request: ReviewRequest
    failed_stage: str
    cause: str
    duration_seconds: float = 0.0


ReviewResult = Annotated[
    Union[ReviewComplete, ReviewPartial, ReviewFailed], Field(discriminator="status")
]
