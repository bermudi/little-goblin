"""Exclusion rules for tracked paths.

Applied before reading diff bodies, before indexing, and before any byte is
sent to a model. Excluded sensitive changes are reported by path only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ExcludeRule:
    pattern: re.Pattern[str]
    reason: str

    @staticmethod
    def make(expr: str, reason: str) -> "ExcludeRule":
        return ExcludeRule(re.compile(expr), reason)


DEFAULT_RULES: list[ExcludeRule] = [
    ExcludeRule.make(r"(^|/)node_modules/", "vendored dependency tree"),
    ExcludeRule.make(r"(^|/)vendor/", "vendored tree"),
    ExcludeRule.make(r"(^|/)(dist|out|build|coverage|\.next|\.nuxt|\.parcel-cache|\.turbo|target)/", "generated output"),
    ExcludeRule.make(r"(^|/)app/dist(/|$)", "app build output"),
    ExcludeRule.make(r"\.min\.(js|css)$", "minified asset"),
    ExcludeRule.make(r"\.(map|tsbuildinfo)$", "generated asset"),
    ExcludeRule.make(r"\.(png|jpe?g|gif|webp|ico|bmp|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|mp[34]|mov|webm)$", "binary asset"),
    ExcludeRule.make(r"(^|/)\.env($|\.)", "environment file"),
    ExcludeRule.make(r"\.(pem|key|p12|pfx|cer|crt|der|jks|keystore)$", "key material"),
    ExcludeRule.make(r"(^|/)(id_rsa|id_ed25519|credentials|secrets?\.ya?ml|\.netrc|\.npmrc|\.pypirc)$", "auth material"),
    ExcludeRule.make(r"(^|/)goblin\.json5$", "live operator configuration"),
    ExcludeRule.make(r"(^|/)bun\.lockb$", "binary lockfile (hashed, not indexed)"),
]


def is_excluded(path: str) -> str | None:
    """Return the exclusion reason, or None if the path is in bounds."""
    for rule in DEFAULT_RULES:
        if rule.pattern.search(path):
            return rule.reason
    return None


TS_SOURCE_RE = re.compile(r"\.(ts|tsx|mts|cts)$")
CONFIG_RE = re.compile(r"(tsconfig[^/]*\.json|\.json5|\.json|\.ya?ml|\.toml|\.ini|\.cfg)$")


def classify_path(path: str) -> str:
    if TS_SOURCE_RE.search(path):
        return "ts"
    if CONFIG_RE.search(path):
        return "config"
    if re.search(r"\.(md|txt)$", path):
        return "docs"
    return "text"


def looks_binary(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    sample = data[:4096]
    if not sample:
        return False
    nontext = sum(1 for b in sample if b < 9 or (13 < b < 32))
    return nontext / len(sample) > 0.10
