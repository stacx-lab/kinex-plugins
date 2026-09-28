# Kinex plugins

Read README.md for development, dependency refreshes and releases, and PLAN.md
for current progress. This project owns native Pi, OpenCode and Codex adapters.

- Robotics belongs to `@kinex/core`, consumed from the checked-in snapshot under
  `vendor/`. Never copy or edit core implementation here or import sibling source
  files. Refresh the snapshot explicitly with `npm run core:refresh -- PATH`.
- Each host adapter owns host permissions, session/context projection, lifecycle
  binding and presentation. Use published host SDKs; do not reimplement providers,
  coding tools, agent loops or TUI frameworks.
- Standalone Kinex owns separate Pi integration code. Do not constrain its SDK
  versions or change the sibling project unless the user requests that work.
- Preserve permission-checked model tools, direct user commands, cancellation,
  recording ownership and disposal. Never terminate borrowed services. Core
  discovery remains inert and Python initialization remains lazy.
- Keep stable instructions separate from dynamic context. Refresh tools within
  tasks and restore context after compaction without bypassing host permissions.
- Use TypeScript ESM, named imports, small functions and typed errors. Imported
  prose belongs in sibling `.txt` files. Do not introduce compatibility shims
  without a supported host version that needs them.

Run `npm run core:check`, `npm run typecheck`, then `npm test` sequentially.
Build output is replaced; never rebuild while consumer tests run. Use Node from
`.nvmrc` and Python 3 for POSIX PTY tests. Run `npm run build` and
`npm run pack -- OUTPUT_DIRECTORY` for packaging. Do not publish or commit
without a user request. Preserve credentials, workspace data and recordings.
