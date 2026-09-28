# Kinex plugins

Native Pi, OpenCode and Codex integrations, maintained independently of the
Kinex standalone application. Node >=22.19 and Python 3 are required for the
build and POSIX PTY checks. Use the Node version in `.nvmrc`.

## Install and develop

```sh
npm ci
npm run core:check
npm run typecheck
npm test
```

`typecheck` builds all three adapters; do not rebuild while consumer tests run.
The host versions are Pi 0.86.1, OpenCode 1.18.31 and Codex 0.155.1. Tests use
mock devices and a local fake model provider, not paid APIs or physical robots.
Individual suites are `test:pi`, `test:opencode` and `test:codex`.

- [Pi](packages/pi/README.md)
- [OpenCode](packages/opencode/README.md)
- [Codex](packages/codex/README.md)

## Shared core

All adapters import `@kinex/core` and its exported subpaths, such as
`@kinex/core/integration`. Robotics source is maintained only in the Kinex
repository. This project contains a built, content-addressed snapshot under
`vendor/`, installed as an ordinary npm package rather than a source link.
The tarball is checked into this repository so CI and fresh clones need no
sibling checkout or registry publication. `vendor/core.json` records its
version, SHA-256 and source revision, including whether the source was dirty.

To deliberately update the snapshot from a Kinex checkout:

```sh
npm run core:refresh -- ../kinex
npm run core:check
npm run typecheck
npm test
```

The source checkout must have its npm dependencies installed. Refresh builds
core, packs its assets, updates each adapter's exact core dependency, and
refreshes this project's lockfile and installed snapshot. A content hash in the
filename ensures changes at the same unreleased version are not lost to npm
caching. Review and commit the snapshot, provenance, manifests and lockfile
together. Builds and installs never refresh core implicitly.

Standalone and the native Pi plugin own independent host integration code.
Their SDK versions can advance separately; shared robotics behavior belongs in
core, not in either adapter.

## Package and release

```sh
npm run build
npm run pack -- /tmp/kinex-plugins-release
```

The output includes three plugin tarballs, the matching core snapshot,
`core.json`, and `SHA256SUMS`. Until registry publication, install the core
snapshot alongside the desired plugin:

```sh
npm install --prefix /path/to/plugin-install \
  /tmp/kinex-plugins-release/kinex-core-*.tgz \
  /tmp/kinex-plugins-release/kinex-codex-0.8.1.tgz
```

The three plugin versions and root version identify a plugin release; they do
not have to match the core version. A `v*` tag must match the plugin release.
CI tests adapters and relocated tarballs. Release CI attaches packages and
provenance to a GitHub release; it does not publish to npm. No remote is required
for local development, and routine builds and tests publish nothing.
