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

Current JVM status: `KotlinPsiDeclarationExtractor` uses Kotlin compiler PSI to parse a single Kotlin file and emit the same `PiecePackage` shape as the npm-side adapters. It is still syntax-oriented; Analysis API resolution is the next semantic step for overloads, imported declarations, and cross-file symbols.

Current JS bridge status: `piece-core` exports JSON bridge functions from `jsMain`, and the npm package exposes `createKotlinCoreBridge()` so a JavaScript host can call the Kotlin core and receive normal JavaScript `PiecePackage` and `PieceGraph` objects. The bridge accepts generated target specs; it is not intended as a user-authored DSL.

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
    go/
      declaration-extractor.js
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
- `src/languages/go/declaration-extractor.js` is the first Go single-file adapter; it emits the same manifest and Bazel-like `PiecePackage` shape without making Go a core dependency.
- `src/node-language-compilers.js` owns Node-only language compiler backends. Go compilation shells out to `go build`/`go test`; Kotlin compilation shells out to a generated Kotlin Multiplatform Gradle project.
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

## Language Toolchains

Piece should not reimplement full language compilers. A Bazel-like Piece action is the stable boundary:

```text
PieceTarget
  -> PieceAction(kind = "compile")
  -> language backend
  -> PieceArtifact(kind = "piece-compile")
```

The current Node backend follows that shape:

- `compileGoPieceFile()` creates a temporary Go module, writes the single `.go` file, runs `go build`, and can run `go test`.
- `compileKotlinPieceFile()` creates a temporary Kotlin Multiplatform project, writes the single `.kt` file into the selected source set, and runs Gradle tasks for `jvm`, `js`, `wasmJs`, or `all`.
- `piece-core` DSL has `go()` and `compile()` so language-specific implementations can be represented in the same generated DSL:

```kotlin
pieceFile("/repo/src/Pricing.go") {
  language = go()
  target("RenderGreeting") {
    rule = function()
    action(compile())
  }
}
```

Kotlin can run on the Web in two supported ways: [Kotlin/JS](https://kotlinlang.org/docs/js-overview.html) transpiles Kotlin to JavaScript, while [Kotlin/Wasm](https://kotlinlang.org/docs/wasm-overview.html) compiles Kotlin to WebAssembly for browsers with the required Wasm support. This repository uses both directions: `jsMain` publishes the npm bridge, and `wasmJsMain` builds the browser smoke bundle copied into GitHub Pages.

## Near-Term Boundary

Keep the implementation honest:

- single file only;
- no workspace-wide dependency resolver yet;
- no handwritten BUILD files;
- generated DSL and package targets are metadata first;
- unknown edges force fallback instead of pretending local feedback is safe;
- Kotlin's production extractor belongs in Kotlin MPP, while the npm extractor remains a bridge and test fixture until that core exists.
