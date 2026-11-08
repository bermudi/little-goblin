"""Git plumbing for immutable endpoint capture.

Only read-only plumbing is used (`rev-parse`, `ls-tree`, `diff-tree`,
`diff`, `cat-file`, `archive`). Never `checkout`, `switch`, `clean`,
`stash`, or porcelain against the operator's worktree. Environment is
scrubbed: no system/user git config can redirect objects, hooks, or
filters. External diff drivers and text converters are disabled with
`--no-ext-diff --no-textconv`.
"""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


class GitError(RuntimeError):
    pass


def _git_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["LC_ALL"] = "C"
    return env


def run_git(repo: str, args: list[str], *, input_bytes: bytes | None = None) -> bytes:
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_git_env(),
        check=False,
    )
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(shlex.quote(a) for a in args)} failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
    return proc.stdout


def resolve_ref(repo: str, ref: str) -> str:
    out = run_git(repo, ["rev-parse", "--verify", f"{ref}^{{commit}}"]).decode().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", out):
        raise GitError(f"cannot resolve ref to a commit: {ref!r}")
    return out


def tree_of(repo: str, commit: str) -> str:
    return run_git(repo, ["rev-parse", f"{commit}^{{tree}}"]).decode().strip()


def merge_base(repo: str, a: str, b: str) -> str:
    out = run_git(repo, ["merge-base", "--all", a, b]).decode().split()
    if len(out) == 0:
        raise GitError(f"no merge base for {a} and {b}")
    if len(out) > 1:
        raise GitError(f"ambiguous fork point for {a} and {b}: {len(out)} equally good merge bases; refusing to choose silently")
    base = out[0]
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise GitError(f"ambiguous or missing merge base for {a} and {b}")
    return base


def is_shallow(repo: str) -> bool:
    return run_git(repo, ["rev-parse", "--is-shallow-repository"]).decode().strip() == "true"


def repo_toplevel(repo: str) -> str:
    return os.path.realpath(run_git(repo, ["rev-parse", "--show-toplevel"]).decode().strip())


def dirty_entries(repo: str) -> list[str]:
    out = run_git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if not out:
        return []
    entries: list[str] = []
    for chunk in out.split(b"\x00"):
        if chunk:
            entries.append(chunk[3:].decode("utf-8", "replace"))
    return entries


@dataclass
class TreeEntry:
    mode: str
    type: str  # blob | tree | commit (submodule)
    sha: str
    path: str


def list_tree(repo: str, commit: str) -> list[TreeEntry]:
    out = run_git(repo, ["ls-tree", "-r", "-z", commit])
    entries: list[TreeEntry] = []
    for record in out.split(b"\x00"):
        if not record:
            continue
        meta, path = record.split(b"\t", 1)
        mode, typ, sha = meta.decode().split(" ", 2)
        entries.append(TreeEntry(mode=mode, type=typ, sha=sha, path=path.decode("utf-8", "surrogateescape")))
    return entries


class BlobReader:
    """Reuses one `git cat-file --batch` process."""

    def __init__(self, repo: str):
        env = _git_env()
        self._proc = subprocess.Popen(
            ["git", "-C", repo, "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def read(self, oid: str) -> bytes:
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(oid.encode() + b"\n")
        self._proc.stdin.flush()
        header = self._proc.stdout.readline().decode("utf-8", "replace").rstrip("\n")
        parts = header.split(" ")
        if len(parts) == 2 and parts[1] == "missing":
            raise GitError(f"missing blob {oid}")
        _oid, typ, size_s = parts
        size = int(size_s)
        data = self._proc.stdout.read(size)
        trailing = self._proc.stdout.read(1)  # \n after content
        if len(data) != size:
            raise GitError(f"short read for blob {oid}")
        return data

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except BrokenPipeError:
            pass
        self._proc.wait(timeout=10)

    def __enter__(self) -> "BlobReader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def blob_text(repo: str, oid: str) -> str:
    raw = run_git(repo, ["cat-file", "blob", oid])
    return raw.decode("utf-8", "replace")


@dataclass
class RawChange:
    status: str  # A M D R T
    old_path: str | None
    new_path: str | None
    old_sha: str
    new_sha: str
    old_mode: str
    new_mode: str
    score: int | None = None  # rename similarity 0-100


def raw_diff(repo: str, old_commit: str, new_commit: str) -> list[RawChange]:
    """Parse `git diff-tree -z --diff-raw` output.

    Format per entry: `:old_mode new_mode old_sha new_sha STATUS\\0` then the
    path, and for renames/copies a second path. STATUS is a letter plus an
    optional similarity score (e.g. `R100`).
    """
    out = run_git(
        repo,
        ["diff-tree", "-r", "-M", "--no-commit-id", "-z", old_commit, new_commit],
    )
    tokens = out.split(b"\x00")
    changes: list[RawChange] = []
    meta_re = re.compile(r"^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$")
    i = 0
    while i < len(tokens):
        meta = tokens[i]
        i += 1
        if not meta:
            continue
        m = meta_re.match(meta.decode("utf-8", "surrogateescape"))
        if not m:
            raise GitError(f"unparseable diff-raw entry: {meta[:200]!r}")
        old_mode, new_mode, old_sha, new_sha, letter, score_s = m.groups()
        score = int(score_s) if score_s else None

        def next_path() -> str:
            nonlocal i
            if i >= len(tokens):
                raise GitError("diff-raw output truncated: missing path")
            p = tokens[i].decode("utf-8", "surrogateescape")
            i += 1
            return p

        if letter in ("R", "C"):
            old_path, new_path = next_path(), next_path()
            changes.append(
                RawChange(status=letter, old_path=old_path, new_path=new_path,
                          old_sha=old_sha, new_sha=new_sha,
                          old_mode=old_mode, new_mode=new_mode, score=score)
            )
        elif letter in ("A", "C"):
            path = next_path()
            changes.append(
                RawChange(status=letter, old_path=None, new_path=path,
                          old_sha=old_sha, new_sha=new_sha,
                          old_mode=old_mode, new_mode=new_mode, score=score)
            )
        elif letter in ("D",):
            path = next_path()
            changes.append(
                RawChange(status="D", old_path=path, new_path=None,
                          old_sha=old_sha, new_sha=new_sha,
                          old_mode=old_mode, new_mode=new_mode)
            )
        elif letter in ("M", "T"):
            path = next_path()
            mode_only = old_sha == new_sha and old_mode != new_mode
            changes.append(
                RawChange(status="mode-only" if mode_only else letter, old_path=path, new_path=path,
                          old_sha=old_sha, new_sha=new_sha, old_mode=old_mode, new_mode=new_mode)
            )
        else:
            # U (unmerged) and anything unexpected: keep the record, flag loudly.
            path = next_path()
            changes.append(
                RawChange(status=letter, old_path=path, new_path=path,
                          old_sha=old_sha, new_sha=new_sha, old_mode=old_mode, new_mode=new_mode)
            )
    return changes


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


@dataclass
class DiffHunk:
    old_start: int
    old_lines: int
    new_start: int
    new_lines: int


def file_hunks(repo: str, old_commit: str, new_commit: str, path: str) -> list[DiffHunk]:
    out = _diff_file(repo, old_commit, new_commit, path)
    hunks: list[DiffHunk] = []
    for line in out.decode("utf-8", "replace").splitlines():
        m = _HUNK_RE.match(line)
        if m:
            o_start = int(m.group(1))
            o_lines = int(m.group(2) if m.group(2) is not None else "1")
            n_start = int(m.group(3))
            n_lines = int(m.group(4) if m.group(4) is not None else "1")
            hunks.append(DiffHunk(o_start, o_lines, n_start, n_lines))
    return hunks


def _diff_file(repo: str, old_commit: str, new_commit: str, path: str) -> bytes:
    return run_git(
        repo,
        ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U0", old_commit, new_commit, "--", path],
    )


def numstat(repo: str, old_commit: str, new_commit: str) -> dict[str, tuple[int | None, int | None]]:
    """path -> (added, deleted); None means binary.

    With `-z`, rename entries are emitted as `added\\tdeleted\\t\\0` followed by
    the old and new path tokens; normal entries are `added\\tdeleted\\tpath\\0`.
    """
    out = run_git(repo, ["diff", "--no-color", "--no-ext-diff", "--numstat", "-z", "-M", old_commit, new_commit])
    result: dict[str, tuple[int | None, int | None]] = {}
    tokens = out.split(b"\x00")
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if not tok:
            continue
        fields = tok.split(b"\t")
        if len(fields) == 3 and fields[2]:
            added_s, deleted_s = fields[0].decode(), fields[1].decode()
            path = fields[2].decode("utf-8", "surrogateescape")
        elif len(fields) == 3 and fields[2] == b"":
            # rename/copy header: next two tokens are old, new
            added_s, deleted_s = fields[0].decode(), fields[1].decode()
            if i + 1 >= len(tokens):
                break
            old_p = tokens[i].decode("utf-8", "surrogateescape")
            new_p = tokens[i + 1].decode("utf-8", "surrogateescape")
            i += 2
            path = new_p
        else:
            continue
        added = None if added_s == "-" else int(added_s)
        deleted = None if deleted_s == "-" else int(deleted_s)
        result[path] = (added, deleted)
    return result


def lock_hash(entries: list[TreeEntry]) -> str | None:
    """Hash of dependency lockfile contents for each endpoint (if any)."""
    candidates = [e for e in entries if e.path.rsplit("/", 1)[-1] in (
        "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    )]
    if not candidates:
        return None
    h = hashlib.sha256()
    for e in sorted(candidates, key=lambda e: e.path):
        h.update(e.path.encode())
        h.update(e.sha.encode())
    return h.hexdigest()


def archive_paths(repo: str, commit: str, paths: list[str], dest: str) -> None:
    """Materialize the given tracked paths of `commit` into `dest`.

    Writes blobs straight from Git objects (no checkout, no filters, no
    archived pathspec grammar). Files get restrictive permissions;
    directories are 0700. An empty selection writes nothing.
    """
    wanted = set(paths)
    if not wanted:
        return
    entries = list_tree(repo, commit)
    dest_root = Path(dest)
    reader = BlobReader(repo)
    try:
        for entry in entries:
            if entry.path not in wanted or entry.type != "blob":
                continue
            raw = reader.read(entry.sha)
            out_path = dest_root / entry.path
            try:
                out_path.resolve().relative_to(dest_root.resolve())
            except ValueError:
                raise GitError(f"path escapes destination: {entry.path!r}") from None
            out_path.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(out_path.parent, 0o700)
            with open(out_path, "wb") as fh:
                fh.write(raw)
            os.chmod(out_path, 0o700 if entry.mode == "100755" else 0o600)
    finally:
        reader.close()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
