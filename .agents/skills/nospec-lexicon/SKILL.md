---
name: nospec-lexicon
description: Use when a recurring project-specific domain term is ambiguous, overloaded, or inconsistent across code and conversation.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Lexicon

Maintain the project's ubiquitous language: the terms human and code must use consistently.

Create `glossary.md` only when the first project-specific term genuinely needs resolution. Keep it curated, not encyclopedic.

## A term belongs when

- the same word names different concepts;
- competing words name the same concept;
- a recurring concept lacks a stable name;
- the current definition no longer matches usage.

Do not define generic engineering words, one-off phrases, or facts already obvious from code.

## Resolve through scenarios

Test a candidate definition against concrete edge cases: “Is this still a `<term>` when …?” If the answer stays ambiguous, sharpen the boundary or split one overloaded term into two concepts. Search code and records to check whether usage agrees.

## Format

```markdown
## <Term>

<One or two sentences defining what the term means in this project.>
```

Definitions carry domain meaning, not implementation detail. Prefer a flat, scannable glossary.

After changing a term, use `nospec-curator` to find durable views or instructions that still project the old meaning.
