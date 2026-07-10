# Changelog

All notable changes to `piece-compiler` will be documented in this file.

## Unreleased

- Add schema v2 explicit workspace project graphs and `piece build` / `piece check` native task execution.
- Harden workspace snapshots, fallback policy validation, and external action boundaries.
- Verify the packed CLI runtime through a declared workspace task fixture.

## 0.1.0 - 2026-07-03

- Import the declaration-level piece compiler as a standalone package.
- Remove host-specific compiler runtime dependencies and legacy aliases.
- Add Node esbuild and virtual file system helpers.
- Add type checking, unit tests, preview build verification, and open-source project docs.
