# notion-caldav-sync

This repository is an independently deployable, single-user TypeScript service.
Support both Cloudflare Workers with D1 and Node.js with PostgreSQL.

- Sync policy belongs in `src/core/`; provider HTTP/schema translation belongs in
  `src/providers.ts`; runtime bindings belong in the corresponding entry point.
  Keep the core usable independent of its runtime or database adapter.
- Write a failing test through the real entry point before changing behavior.
  `pnpm test` saves its command, TAP and protocol traces under `artifacts/e2e/`.
  Specify failures in `tests/e2e/FAILURE_MODES.md` before isolated implementation.
- Treat incomplete listings as errors. Verify ownership and observed versions
  before effects; retain the merge base until all effects succeed.
- For migration changes read `docs/migration-0.9.0.md`. Retain legacy hrefs and UIDs;
  preserve unknown events and report unresolved duplicates.
- Preserve MIT attribution in extracted modules and `THIRD_PARTY_NOTICES.md`.
- Release gates: fixture E2E, types, runtime bundle, and a bounded live test on
  disposable resources. Store the report before publishing.
