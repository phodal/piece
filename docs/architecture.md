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
      KotlinPsiAnalysisBackend.kt
      KotlinPsiAnalysisBackendCli.kt
      KotlinCompileBackend.kt
      KotlinCompileBackendCli.kt
    jsMain/kotlin/piece/bridge/
      NpmBridge.kt
    commonTest/kotlin/piece/dsl/
      PieceDslTest.kt
```

The common source set owns the DSL, graph model, and snapshot/reconcile primitives. JVM owns the real Kotlin parser and semantic extraction, using Kotlin compiler PSI or Analysis API when the toolchain is available. JS owns the npm bridge and browser/editor protocol.

This follows Kotlin Multiplatform's expect/actual shape: common code exposes the stable API; platform source sets provide platform-specific implementations.

Current JVM status: `KotlinPsiDeclarationExtractor` uses Kotlin compiler PSI to parse a single Kotlin file and emit the same `PiecePackage` shape as the npm-side adapters. `KotlinPsiAnalysisBackend` exposes that PSI path as a Node-callable manifest backend through `runKotlinPsiAnalysisBackend`; the `piece-compiler/node` entrypoint uses it by default for `.kt` and `.kts` files without making the root or browser bundle depend on Gradle. The same backend can optionally run `K2JVMCompiler` as a compiler diagnostic pass, so Node callers can get real Kotlin semantic/type diagnostics without reimplementing Kotlin in JavaScript. It can also opt into a compiler BindingContext symbol pass for local single-file symbol refinement, which prevents PSI name matching from treating shadowed type parameters as dependencies on same-named top-level declarations. `KotlinCompileBackend` is also JVM-side Kotlin code: the npm API invokes it through the `runKotlinCompileBackend` Gradle task, and it owns generated MPP Gradle projects, compile tasks, output discovery, and compile reports. It drives those generated projects through Gradle Tooling API when the wrapper distribution is available, with wrapper execution as a fallback. Analysis API symbol resolution remains the next semantic step for overloads, imported declarations, and cross-file symbols.

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
- `src/node-language-compilers.js` owns Node host language-tool entrypoints. Go compilation is still a Node backend that shells out to `go build`/`go test`; Kotlin compilation delegates to the `piece-core` Kotlin/JVM backend. Node hosts can also call `analyzeKotlinPieceFile()` or `createNodeKotlinPsiDeclarationExtractor()` to run Kotlin PSI analysis on the JVM, opt into Kotlin compiler semantic diagnostics or local symbol refinement, and `piece-compiler/node` wires that extractor as the default Kotlin resolver.
- React preview entry generation lives in `src/core/virtual-modules.js`.
- `src/adapters/react/virtual-modules.js` exposes the React virtual-module adapter through the adapter directory.
- Kotlin extraction in `src/languages/kotlin/declaration-extractor.js` remains a runnable npm-side adapter for single-file experiments and browser-safe fallback. Node-side Kotlin PSI analysis lives in `piece-core` and is exposed through `piece-compiler/node`.
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

The current host backends follow that shape:

- `compileGoPieceFile()` creates a temporary Go module, writes the single `.go` file, runs `go build`, and can run `go test`.
- `analyzeKotlinPieceFile()` is the npm entrypoint for Node-side Kotlin PSI analysis. It writes the source to a temporary host file, invokes `piece-core`'s JVM backend, and returns a normal `PieceFileManifest`. By default this preserves the fast PSI declaration path; `semanticDiagnostics: true` additionally runs the official Kotlin compiler diagnostic pass on the JVM, and `semanticSymbols: true` refines same-file symbols through compiler BindingContext.
- `compileKotlinPieceFile()` is the npm entrypoint, but the compile implementation lives in Kotlin/JVM under `piece-core`. It creates a temporary Kotlin Multiplatform project, writes the single `.kt` file into the selected source set, and runs Gradle tasks for `jvm`, `js`, `wasmJs`, or `all`.
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
- Kotlin's production extractor and compile backend belong in Kotlin MPP, while the npm Kotlin extractor remains a bridge and test fixture until that core is complete.
