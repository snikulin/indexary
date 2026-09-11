# Enforce v1 read-only behavior in the application

Indexary v1 enforces read-only Knowledge Base access through its application interfaces and regression tests, not through a separate Unix user or systemd filesystem sandbox. Tests verify that indexing and serving a fixture leave its tree unchanged, and all Indexary-owned data lives outside the Knowledge Base. No speculative write interface is included in v1; adding editing later requires an explicit replacement decision, permission model, and API design rather than an incidental expansion of the read-only boundary.
