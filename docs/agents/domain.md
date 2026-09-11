# Domain Docs

Indexary uses a single-context domain documentation layout.

## Before exploring

Read:

- `CONTEXT.md` at the repository root;
- relevant decisions under `docs/adr/`.

If either location is absent, proceed silently. Domain documentation is created
or extended only when a term or decision is actually resolved.

## Vocabulary

Use domain concepts exactly as defined in `CONTEXT.md`, including in issue
titles, specifications, tests, hypotheses, and refactoring proposals.

Do not use synonyms that the glossary explicitly marks as terms to avoid. If a
required concept is missing, reconsider whether new vocabulary is necessary or
record the gap for `/domain-modeling`.

## Architecture decisions

If proposed work contradicts an existing ADR, identify the conflict explicitly.
Do not silently replace an accepted decision.
