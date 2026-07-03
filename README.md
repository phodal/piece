# piece-compiler

`piece-compiler` builds declaration-level previews for React and TSX source files. It extracts top-level declarations, builds a dependency graph, selects previewable components, and can bundle only the closure needed for a target piece.

The package is standalone ESM. It does not require a host-specific compiler runtime.

## Install

```sh
npm install piece-compiler
```

Node.js 20 or newer is required.

## Usage

Analyze a TSX file:

```js
import { createPieceCompiler } from "piece-compiler";

const compiler = createPieceCompiler();
const analysis = await compiler.analyzeFile({
  filePath: "/repo/src/UserCard.tsx",
  source: `
export function UserCard(props) {
  return <section>{props.name}</section>;
}
`
});

console.log(analysis.previewTargets);
```

Build a preview closure:

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

Compile a standalone piece status:

```js
import { compilePieceApp } from "piece-compiler";

const status = await compilePieceApp({
  filePath: "/repo/src/UserCard.tsx",
  source,
  target: "UserCard",
  piece: { id: "UserCard" }
});

console.log(status.compiler);
console.log(status.preview?.target);
```

## API Surface

- `createPieceCompiler(defaultOptions)` returns a compiler object with `normalize`, `compile`, `analyzeFile`, `selectPreviewTarget`, `buildPreview`, `applyEdit`, and `rebuildAffectedPreviews`.
- `analyzePieceFile(options)` extracts a declaration manifest, graph, preview targets, metrics, and a snapshot.
- `buildPiecePreview(options)` creates virtual modules for the selected target and optionally bundles them with an esbuild-compatible build engine.
- `applyPieceEdit(options)` and `rebuildAffectedPiecePreviews(options)` support incremental edit analysis and cache-aware preview rebuilds.
- `reconcilePieceSnapshot(options)` compares declaration snapshots and reports changed, dirty, reused, and invalidated pieces.
- `piece-compiler/node` provides `createNodeEsbuildBuildEngine()` and `createNodeVirtualFileSystem()`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run preview:build
npm run verify
```

Run the local browser preview:

```sh
npm run preview
```

The preview server listens on `http://127.0.0.1:8797` by default.

## Publishing Checklist

Before publishing a release:

1. Run `npm run verify`.
2. Review `npm pack --dry-run` output.
3. Update the version in `package.json`.
4. Create a signed Git tag for the release.

## License

Apache-2.0. See [LICENSE](./LICENSE).
