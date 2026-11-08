import pytest

from code_review.gitio import (
    BlobReader,
    GitError,
    archive_paths,
    blob_text,
    dirty_entries,
    file_hunks,
    list_tree,
    merge_base,
    numstat,
    raw_diff,
    resolve_ref,
)


def test_resolve_ref_and_list_tree(repo_path):
    base = resolve_ref(str(repo_path), "main")
    head = resolve_ref(str(repo_path), "feature")
    assert base != head
    entries = list_tree(str(repo_path), head)
    paths = {e.path for e in entries}
    assert {"package.json", "tsconfig.json", "src/util.ts", "src/calc.ts", "src/report.ts"} <= paths
    assert all(e.type == "blob" for e in entries)


def test_dirty_checkout_detected(repo_path):
    assert dirty_entries(str(repo_path)) == []
    marker = repo_path / "untracked.tmp"
    marker.write_text("x")
    try:
        assert any("untracked.tmp" in entry for entry in dirty_entries(str(repo_path)))
    finally:
        marker.unlink()


def test_raw_diff_classifies_changes(repo_path):
    base = resolve_ref(str(repo_path), "main")
    head = resolve_ref(str(repo_path), "feature")
    changes = {c.new_path or c.old_path: c for c in raw_diff(str(repo_path), base, head)}
    assert changes["src/util.ts"].status == "M"
    assert changes["src/report.ts"].status == "A"
    assert changes["src/report.ts"].old_path is None


def test_hunks_and_numstat(repo_path):
    base = resolve_ref(str(repo_path), "main")
    head = resolve_ref(str(repo_path), "feature")
    hunks = file_hunks(str(repo_path), base, head, "src/util.ts")
    assert hunks and hunks[0].new_lines >= 1
    stats = numstat(str(repo_path), base, head)
    assert stats["src/util.ts"] == (1, 0)
    assert stats["src/report.ts"] == (4, 0)


def test_merge_base_direct_and_fork_point(repo_path):
    base = resolve_ref(str(repo_path), "main")
    head = resolve_ref(str(repo_path), "feature")
    assert merge_base(str(repo_path), base, head) == base


def test_blob_reader_roundtrip(repo_path):
    head = resolve_ref(str(repo_path), "feature")
    entries = {e.path: e for e in list_tree(str(repo_path), head)}
    reader = BlobReader(str(repo_path))
    content = reader.read(entries["src/util.ts"].sha).decode()
    reader.close()
    assert "Number.isNaN" in content
    assert blob_text(str(repo_path), entries["src/util.ts"].sha) == content


def test_archive_paths_subset_and_modes(repo_path, tmp_path):
    head = resolve_ref(str(repo_path), "feature")
    dest = tmp_path / "tree"
    dest.mkdir()
    archive_paths(str(repo_path), head, ["src/util.ts", "package.json"], str(dest))
    assert (dest / "src" / "util.ts").is_file()
    assert (dest / "package.json").is_file()
    assert not (dest / "src" / "calc.ts").exists()
    assert oct((dest / "src" / "util.ts").stat().st_mode & 0o777) == "0o600"


def test_archive_paths_empty_selection_is_noop(repo_path, tmp_path):
    head = resolve_ref(str(repo_path), "feature")
    dest = tmp_path / "tree"
    dest.mkdir()
    archive_paths(str(repo_path), head, [], str(dest))
    assert list(dest.rglob("*")) == []


def test_merge_base_ambiguous(monkeypatch):
    from code_review import gitio

    monkeypatch.setattr(
        gitio,
        "run_git",
        lambda repo, args, **kw: b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    )
    with pytest.raises(GitError, match="ambiguous"):
        merge_base("/tmp/whatever", "a", "b")


def test_merge_base_missing(monkeypatch):
    from code_review import gitio

    def fail(repo, args, **kw):
        raise GitError("git merge-base failed")

    monkeypatch.setattr(gitio, "run_git", fail)
    with pytest.raises(GitError):
        merge_base("/tmp/whatever", "a", "b")


def test_raw_diff_rejects_garbage_output(monkeypatch):
    from code_review import gitio

    monkeypatch.setattr(gitio, "run_git", lambda *a, **kw: b":garbage entry with no structure\0x\0")
    with pytest.raises(GitError):
        raw_diff("/tmp/whatever", "aaaaaaa", "bbbbbbb")
