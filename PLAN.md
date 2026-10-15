# Shared Kinex plugin release

Implemented architecture: one host-managed stdio MCP package; thin Pi UI glue;
generated Claude Code/Codex plugin bundles and shared skills. Connecting the host
keeps robotics inactive until explicit Start Kinex. No manually managed daemon.

## Implementation

- [x] Replace the unreleased Codex-specific adapter with `@kinex/mcp`.
- [x] Keep core/setup behind one lazy runtime import boundary.
- [x] Add explicit start/status/end/restart with serialized work, urgent stop,
      cancellation, permission handling and owned-resource cleanup.
- [x] Discover live tools, schemas, skills, workflows and scoped context dynamically.
- [x] Preserve images, custom tools, recording opt-in and trusted user controls.
- [x] Replace Pi's duplicated runtime adapter with native MCP registration and dialogs.
- [x] Generate host manifests, marketplaces and skill copies from canonical sources;
      propagate supporting files and remove retired skills.
- [x] Exclude OpenCode from builds, tests and releases.
- [x] Refresh content-addressed core/setup snapshots with source provenance.
- [x] Add staged `kinex:sync`, catalog compatibility reports, output concurrency
      checks, installation rollback and automatic local installation/build.
- [x] Document installation, development, updates, performance and release artifacts.

## Verification

- [x] Snapshot integrity and TypeScript builds.
- [x] Real Pi loader, Claude plugin loader, Codex MCP and Codex marketplace install.
- [x] Shared lifecycle, approval, cancellation, recording and contribution tests.
- [x] Relocated MCP and Pi tarball installs without a sibling Kinex checkout.
- [x] Claude/Codex manifest validation and validation of all seven canonical skills.
- [x] Successful end-to-end Kinex sync including staged tests and installation.
- [x] Intentionally remove `createKinexRuntime` from a temporary package's public
      types: sync rejects it at typecheck and preserves all working project files.
- [x] Cold import/start/end timing and process-memory measurements on Linux x64.

Release remains local and unpublished. npm package publication and a macOS smoke
run are release steps; no physical robot or paid model API was used for validation.
See `compatibility-report.json` for the last accepted snapshots and host versions.
