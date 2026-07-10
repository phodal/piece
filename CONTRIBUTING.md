# Contributing

Thanks for helping improve `piece-compiler`.

## Development Setup

```sh
npm install
npm run verify
```

The verification command runs type checks, unit tests, and an npm package dry run.

## Pull Request Guidelines

- Keep changes focused on one behavior or API surface.
- Add or update tests for parser, graph, preview, incremental rebuild behavior, and any workspace/fallback execution path you change.
- Keep public API changes reflected in `src/index.d.ts` and README examples.
- Run `npm run verify` before opening a pull request. Changes to CLI packaging or workspace execution must also pass `npm run smoke:packed`.

## Commit Style

Use concise Conventional Commit style messages when possible:

```text
feat: add preview target selector option
fix: keep runtime cache on type-only edits
docs: document node build engine
```

## Reporting Issues

Please include:

- Node.js and npm versions.
- A minimal TSX source snippet.
- The command or API call that failed.
- Actual and expected behavior.
