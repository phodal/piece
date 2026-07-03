# Piece Architecture

Piece is scoped to a single source file first.

The goal is not to recreate Bazel's repository-scale build system. The useful Bazel idea here is the organization model:

- package: a boundary that owns sources and targets;
- rule: a typed declaration that knows how to turn inputs into outputs;
- target: a named graph node;
- dependency graph: direct and transitive edges between targets;
- action: a deterministic unit of feedback that can reuse cached artifacts.

For Piece, those concepts collapse into a single-file package:

```text
//repo/src:Pricing.kt
  -> //repo/src:Pricing.kt__class_User
  -> //repo/src:Pricing.kt__value_prefix
  -> //repo/src:Pricing.kt__function_renderGreeting
```

The file is still the storage boundary. The targets below it are the feedback boundary.

## Core Model

```text
SourceFile
  -> PiecePackage
  -> PieceRule
  -> PieceTarget
  -> PieceAction
  -> PieceArtifact
```

The durable model should be language-neutral:

```kotlin
pieceFile("Pricing.kt") {
  language = kotlin()

  target("renderGreeting") {
    rule = function()
    deps(":User", ":Greeting", ":prefix")
    action = feedback("analysis")
  }
}
```

This DSL should usually be generated from source, not handwritten. A host may still write or patch it when it wants to override target names, fixture inputs, visibility, or feedback actions.

## Kotlin MPP Direction

Kotlin should be implemented in Kotlin, not as a long-term JavaScript parser. The Kotlin Multiplatform core is scaffolded under `piece-core/`:

```text
piece-core/
  settings.gradle.kts
  build.gradle.kts
  src/
    commonMain/kotlin/piece/model/
      PieceModel.kt
    commonMain/kotlin/piece/dsl/
      PieceDsl.kt
    commonMain/kotlin/piece/extract/
      DeclarationExtractor.kt
    commonMain/kotlin/piece/graph/
      PieceGraph.kt
    commonMain/kotlin/piece/reconcile/
      PieceReconciler.kt
    jvmMain/kotlin/piece/kotlin/
      KotlinPsiDeclarationExtractor.kt
    jsMain/kotlin/piece/bridge/
      NpmBridge.kt
    commonTest/kotlin/piece/dsl/
      PieceDslTest.kt
```

The common source set owns the DSL, graph model, and snapshot/reconcile primitives. JVM owns the real Kotlin parser and semantic extraction, using Kotlin compiler PSI or Analysis API when the toolchain is available. JS owns the npm bridge and browser/editor protocol.

This follows Kotlin Multiplatform's expect/actual shape: common code exposes the stable API; platform source sets provide platform-specific implementations.

## JS/TS Support

JS/TS support should remain in the npm package as a first-class host adapter:

```text
src/
  core/
    piece-package.js
    piece-pipeline.js
    reconciler.js
    slice-graph.js
  languages/
    kotlin/
      declaration-extractor.js
    typescript/
      declaration-extractor.js
  adapters/
    react/
      virtual-modules.js
      preview-entry.js
```

The current repository has not fully moved to this layout yet. Today:

- TypeScript-family extraction lives in `src/core/typescript-declaration-extractor.js`.
- `src/languages/typescript/declaration-extractor.js` exposes the TypeScript extractor through the language directory.
- React preview entry generation lives in `src/core/virtual-modules.js`.
- `src/adapters/react/virtual-modules.js` exposes the React virtual-module adapter through the adapter directory.
- Kotlin extraction in `src/languages/kotlin/declaration-extractor.js` is a runnable npm-side adapter for single-file experiments.
- `src/core/piece-package.js` exposes the Bazel-like single-file package view.
- `piece-core/` contains the Kotlin MPP model/DSL/graph/reconcile scaffold for the second phase.

The intended next refactor is to move TypeScript and React into `languages/typescript` and `adapters/react` without changing the public API.

## Why Keep React Working

React is a feedback adapter, not the core abstraction.

```text
PieceTarget
  -> React preview adapter
  -> virtual TSX closure
  -> esbuild/Vite/Webpack
  -> iframe artifact
```

Kotlin can use the same package/target/graph model with different actions:

```text
PieceTarget
  -> Kotlin analysis adapter
  -> PSI/Analysis API closure
  -> diagnostics/test/doc artifact
```

Both paths share target identity, dependency edges, snapshot reconciliation, dirty propagation, and artifact reuse.

## Near-Term Boundary

Keep the implementation honest:

- single file only;
- no workspace-wide dependency resolver yet;
- no handwritten BUILD files;
- generated DSL and package targets are metadata first;
- unknown edges force fallback instead of pretending local feedback is safe;
- Kotlin's production extractor belongs in Kotlin MPP, while the npm extractor remains a bridge and test fixture until that core exists.
