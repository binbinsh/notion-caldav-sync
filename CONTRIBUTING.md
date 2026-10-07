# Contributing

Use the Node and pnpm versions pinned in this repository. Run
`pnpm install --frozen-lockfile`, `pnpm check` and `pnpm build`.

Add a failing E2E before changing behavior. Keep protocol fixtures external to
sync logic. The test runner saves the exact command and results. See `AGENTS.md`
for module boundaries. Public scope is one independently deployed account;
private tenancy, hosting and AgentMQ orchestration stay outside this repository.
