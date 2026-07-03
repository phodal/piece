# Piece

[![Deploy GitHub Pages](https://github.com/phodal/piece/actions/workflows/pages.yml/badge.svg)](https://github.com/phodal/piece/actions/workflows/pages.yml)

Compile the React component you are editing without rebuilding the whole app.

Piece is a declaration-level preview compiler for React and TSX. It slices a source file into imports, types, values, functions, and components; builds the dependency graph around a selected component; then bundles the smallest safe preview closure it can. The result is a fast inner loop for code editors, design tools, AI coding surfaces, and component workbenches.

Try the demo: [phodal.github.io/piece](https://phodal.github.io/piece/)

## Why Piece

Modern React files often hold far more than one component. A full preview rebuild pays for every declaration, even when the user changed one label or one prop mapping. Piece focuses on the declaration you are looking at:

- extracts previewable React components from TSX;
- follows runtime, type, and external dependency edges;
- emits virtual modules for the selected component closure;
- detects changed, dirty, reused, and invalidated pieces after edits;
- reuses the previous runtime bundle when a type-only edit leaves runtime code unchanged.

Piece is standalone ESM. It does not depend on a host-specific editor or preview runtime.

## Install

```sh
npm install piece-compiler
```

Node.js 20 or newer is required.

## Quick Start

Analyze a TSX file:

```js
import { createPieceCompiler } from "piece-compiler";

const compiler = createPieceCompiler();

const analysis = await compiler.analyzeFile({
  filePath: "/repo/src/UserCard.tsx",
  source: `
interface UserCardProps {
  name: string;
}

export function UserCard(props: UserCardProps) {
  return <section>{props.name}</section>;
}
`
});

console.log(analysis.previewTargets);
```

Build and bundle the selected component preview:

```js
import { createPieceCompiler } from "piece-compiler";
import { createNodeEsbuildBuildEngine } from "piece-compiler/node";

const compiler = createPieceCompiler();

const preview = await compiler.buildPreview({
  filePath: "/repo/src/UserCard.tsx",
  source,
  target: "UserCard",
  buildEngine: createNodeEsbuildBuildEngine()
});

console.log(preview.bundle?.code);
```

Track an edit and rebuild only affected previews:

```js
const edit = await compiler.applyEdit({
  filePath: "/repo/src/UserCard.tsx",
  source: nextSource,
  previousAnalysis,
  changedRanges
});

const update = await compiler.rebuildAffectedPreviews({
  filePath: "/repo/src/UserCard.tsx",
  source: nextSource,
  editResult: edit,
  previousPreviews,
  buildEngine: createNodeEsbuildBuildEngine()
});

console.log(update.metrics);
```

## API

- `createPieceCompiler(defaultOptions)` creates a compiler with `normalize`, `compile`, `analyzeFile`, `selectPreviewTarget`, `buildPreview`, `applyEdit`, and `rebuildAffectedPreviews`.
- `analyzePieceFile(options)` returns a declaration manifest, graph, preview targets, metrics, and snapshot.
- `buildPiecePreview(options)` creates virtual modules for a target and optionally bundles them with an esbuild-compatible build engine.
- `applyPieceEdit(options)` performs incremental analysis when an edit stays inside one declaration.
- `rebuildAffectedPiecePreviews(options)` rebuilds affected targets and keeps the last good preview on errors.
- `reconcilePieceSnapshot(options)` reports changed, dirty, reused, and invalidated declarations.
- `piece-compiler/node` provides `createNodeEsbuildBuildEngine()` and `createNodeVirtualFileSystem()`.

## Local Demo

```sh
npm install
npm run preview
```

Open `http://127.0.0.1:8797`. Click `Sample Edit` to see the component preview and metrics update from an incremental rebuild.

## Development

```sh
npm run typecheck
npm test
npm run pages:build
npm run verify
```

`npm run verify` runs type checks, unit tests, and an npm package dry run.

## License

Apache-2.0. See [LICENSE](./LICENSE).
