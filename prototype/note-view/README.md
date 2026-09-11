# Atlas note-view prototype

> **Throwaway design evidence.** This prototype preserves the selected Atlas
> Variant B interaction model. It is not maintained application code and must
> not be merged into the production implementation branch.

The prototype reads a Knowledge Base and serves the interface on localhost. It
does not write to the Knowledge Base.

Run it with an explicitly selected directory:

```sh
INDEXARY_KNOWLEDGE_BASE=/path/to/knowledge-base ./serve.sh
```

Then open <http://127.0.0.1:4173/?variant=B>.

Python bytecode, generated caches, personal Knowledge Base content, captured
diagnostics, and machine-specific paths do not belong on this branch.
