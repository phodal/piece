# Piece

[![Deploy GitHub Pages](https://github.com/phodal/piece/actions/workflows/pages.yml/badge.svg)](https://github.com/phodal/piece/actions/workflows/pages.yml)

Piece is a piece-aware build feedback system for AI-era coding agents.

It treats a file as the storage boundary, not necessarily the smallest build or feedback boundary. Instead of asking only "which file changed?", Piece asks which semantic piece changed, whether its public shape changed, which downstream pieces are affected, and which artifacts can be reused.

Try the demo: [phodal.github.io/piece](https://phodal.github.io/piece/)

## Why Piece

Classic build systems are organized around files, targets, actions, and artifacts. Bazel made that model explicit and scalable: build graph first, deterministic actions second, cacheable outputs third. That model still matters, but AI coding changes the inner loop.

Coding agents usually edit a function, class, interface, component, template block, route handler, notebook cell, or configuration section inside a larger file. Piece moves build feedback closer to that unit:

- extract semantic pieces from source files;
- build a graph of runtime, type, and external dependency edges;
- compare snapshots to find changed, dirty, reused, and invalidated pieces;
- build the smallest safe closure for a selected feedback target;
- reuse artifacts when a change does not affect the target runtime closure;
- fall back to file-level or project-level feedback when local safety cannot be proven.

Piece is not a replacement for TypeScript, Vite, esbuild, Webpack, Bazel, Gradle, or other build engines. It is a coordination layer between editors, language services, build tools, preview surfaces, tests, and AI agents.

## Core Idea

Traditional build systems model:

```text
file -> target -> action -> artifact
```

Piece adds an agent-friendly feedback graph:

```text
agent edit -> semantic piece -> impact boundary -> preview/test/artifact feedback
```

The important shift is not "React component preview". That is only one adapter. The durable abstraction is:

- **Piece Manifest**: declarations, imports, effects, ranges, symbols, hashes, and safety flags.
- **Slice Graph**: runtime, type, external, and unknown edges between pieces.
- **Snapshot Reconciler**: changed pieces, public shape changes, dirty propagation, reused artifacts, and invalidated artifacts.
- **Safety Boundary**: local closure when safe; file-level or project-level fallback when not safe.
- **Feedback Target**: preview, typecheck, test, visual diff, documentation render, agent validation gate, or any host-defined artifact.

## Scope

Piece is not limited to TSX or React.

The current package ships a TypeScript-family extractor for JavaScript, TypeScript, JSX, and TSX files. The same model can be extended through custom extractors for Vue, Svelte, MDX, Python notebooks, JVM languages, configuration files, or any source format that can expose stable semantic pieces.

The browser demo uses a React preview adapter because it is a useful first feedback surface. The core APIs are designed around manifests, graphs, closures, edits, updates, and host-provided build engines rather than a single framework.

## Install

```sh
npm install piece-compiler
```

Node.js 20 or newer is required.

## Quick Start

Analyze a source file into semantic pieces:

```js
import { createPieceCompiler } from "piece-compiler";

const compiler = createPieceCompiler();

const source = `
export interface Plan {
  name: string;
  price: number;
}

const taxRate = 0.08;

export function formatPrice(plan: Plan) {
  return plan.price * (1 + taxRate);
}

export class InvoicePresenter {
  total(plan: Plan) {
    return formatPrice(plan);
  }
}
`;

const analysis = await compiler.analyzeFile({
  filePath: "/repo/src/pricing.ts",
  source
});

console.log(analysis.manifest.slices.map((piece) => [piece.kind, piece.name]));
console.log(analysis.graph.edges);
```

Track an edit and ask which pieces are affected:

```js
const nextSource = source.replace("0.08", "0.09");
const changedStart = source.indexOf("0.08");

const edit = await compiler.applyEdit({
  filePath: "/repo/src/pricing.ts",
  source: nextSource,
  previousAnalysis: analysis,
  changedRanges: [
    {
      startByte: changedStart,
      endByte: changedStart + "0.08".length,
      startLine: 7,
      endLine: 7
    }
  ]
});

console.log(edit.edit.changedSlices);
console.log(edit.affectedTargets);
console.log(edit.reconciliation.reusedArtifactIds);
console.log(edit.reconciliation.invalidatedArtifactIds);
```

Build feedback through a host-provided engine or adapter:

```js
import { createNodeEsbuildBuildEngine } from "piece-compiler/node";

// A preview host, test runner, or documentation renderer can keep its own
// previous artifacts and pass the edit result into the next feedback step.
const update = await compiler.rebuildAffectedPreviews({
  filePath: "/repo/src/App.tsx",
  source: nextAppSource,
  editResult: appEditResult,
  previousPreviews: appPreviousPreviews,
  buildEngine: createNodeEsbuildBuildEngine()
});

console.log(update.metrics);
```

Preview building is one feedback target. A host can map the same affected-piece result to tests, visual checks, documentation rendering, or a full project build fallback.

## API

- `createPieceCompiler(defaultOptions)` creates a compiler with `normalize`, `compile`, `analyzeFile`, `selectPreviewTarget`, `buildPreview`, `applyEdit`, and `rebuildAffectedPreviews`.
- `analyzePieceFile(options)` returns a declaration manifest, graph, preview targets, metrics, and snapshot.
- `buildPiecePreview(options)` creates virtual modules for a selected target and optionally bundles them with an esbuild-compatible build engine.
- `applyPieceEdit(options)` performs incremental analysis when an edit stays inside one declaration.
- `rebuildAffectedPiecePreviews(options)` rebuilds affected feedback targets and keeps the last good artifact on errors.
- `reconcilePieceSnapshot(options)` reports changed, dirty, reused, and invalidated declarations.
- `createKotlinCoreBridge(kotlinCoreModule)` adapts the Kotlin/JS core bridge into plain JavaScript `PiecePackage` and `PieceGraph` objects.
- `piece-compiler/node` provides `createNodeEsbuildBuildEngine()` and `createNodeVirtualFileSystem()`.

## Architecture

```text
Source files
  -> Extractor
  -> Piece Manifest
  -> Slice Graph
  -> Snapshot Reconciler
  -> Safety Boundary
  -> Closure Builder
  -> Build / Preview / Test / Validation Adapter
  -> Artifact Cache
```

The Bazel-like part is the graph, the deterministic closure, and the cacheable artifact. The AI-era part is that the graph starts below the file boundary and returns structured feedback to the agent after every edit.

See [docs/architecture.md](./docs/architecture.md) for the single-file Bazel mapping, the generated Piece DSL shape, the Kotlin MPP direction, and the planned directory layout for Kotlin, JS/TS, and React adapters.

## Local Demo

```sh
npm install
npm run preview
```

Open `http://127.0.0.1:8797`. Click `Sample Edit` to see the preview and metrics update from an incremental rebuild.

## Development

```sh
npm run typecheck
npm test
npm run core:check
npm run core:bridge:smoke
npm run pages:build
npm run verify
```

`npm run verify` runs type checks, unit tests, and an npm package dry run.
`npm run core:check` uses the checked-in `piece-core/gradlew` wrapper, so local
Kotlin Multiplatform development does not require a global Gradle installation.
It also builds the Kotlin/JS bridge and runs the npm-side bridge smoke test.
Gradle outputs stay local under ignored directories such as `piece-core/build`,
`piece-core/.gradle`, and `piece-core/kotlin-js-store`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
