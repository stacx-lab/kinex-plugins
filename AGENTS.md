# Kinex plugins

Read README.md for architecture, development, updates and release procedures.
This project ships one shared MCP adapter, Pi UI glue and Claude/Codex plugin
bundles. OpenCode is excluded from the active workspaces and release graph.

- Device operation belongs to `@kinex/core`; onboarding/calibration belongs to
  `@kinex/setup`. Consume checked-in snapshots under `vendor/`. Never copy core
  implementation, import sibling source or modify the standalone Kinex project.
- `packages/mcp/src/kinex.ts` is the runtime-value import boundary to core/setup.
  Keep runtime construction lazy, Python lazy and capability discovery dynamic.
- Host adapters own only host transport/UI/lifecycle integration. Use published
  host APIs; do not duplicate agent loops, coding tools or robotics state.
- Preserve permission-checked model tools, trusted direct user commands,
  cancellation, recording ownership and disposal. Never terminate borrowed
  services. Host connection must not activate robotics.
- Stable skills/instructions must stay small. Load current schemas/workflows and
  restore dynamic context after resume/compaction through shared discovery.
- Edit canonical skills in `assets/skills` and release metadata in `release.json`;
  regenerate copies and manifests with `npm run generate`.
- Use `npm run kinex:sync -- PATH` for validated snapshot migrations. The low-level
  `core:refresh` command intentionally updates in place and is not transactional.
- Use TypeScript ESM, named imports, small functions and typed errors. Imported
  prose belongs in sibling `.txt` files. No compatibility aliases for retired APIs.

Run `npm run core:check`, `npm run typecheck`, then `npm test` sequentially.
Never rebuild while consumer tests run. Use Node from `.nvmrc` and Python 3 for
POSIX PTY tests. Pack outside this repository with `npm run pack -- DIRECTORY`.
Do not publish or commit without a user request. Preserve credentials, workspace
data and recordings. Tests must isolate host configs and use local fake providers.
