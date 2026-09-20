# Contributing

Thank you for helping improve Notion CalDAV Sync.

## Development setup

1. Install [uv](https://docs.astral.sh/uv/) and either Node.js with `npx` or [mise](https://mise.jdx.dev/). `uv` manages the compatible Python runtime; mise is only needed when you want the repository-pinned Node.js runtime.
2. Run `uv sync --group dev`.
3. Run the offline checks:

   ```bash
   uv run ruff check src tests
   uv run pytest -m "not integration"
   ```

Live Notion, Apple Calendar, and Cloudflare tests require credentials and should not run in pull requests from forks.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for behavioral changes.
- Preserve one-way synchronization: Notion is the source of truth.
- Never commit tokens, app passwords, OAuth secrets, webhook secrets, or `.env` files.
- Do not change event deletion or legacy `Notion` calendar compatibility behavior without an explicit migration and regression tests.

Open an issue first for changes that affect stored data, authentication, multi-tenant isolation, or calendar ownership semantics.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
