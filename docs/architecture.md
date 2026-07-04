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

The durable model should be language-neutral. The current Kotlin builder DSL is an internal construction API:

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

The external DSL should be a `.pic` file parsed with ANTLR. It should usually be generated from source, not handwritten. A host may still write or patch it when it wants to override target names, fixture inputs, visibility, or feedback actions:

```pic
package "//repo/src:Pricing.kt" {
  language kotlin
  source "/repo/src/Pricing.kt"

  target function "renderGreeting" {
    deps ":User", ":Greeting", ":prefix"
    action compile {
      mnemonic "PieceCompile"
      output "Pricing.kt__function_renderGreeting.compile.json"
    }
  }
}
```

ANTLR parser code should live on the JVM side first, while the AST, diagnostics, and model conversion stay in `commonMain`. See [roadmap.md](./roadmap.md) for the `.pic` implementation sequence.

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

Current JVM status: `KotlinPsiDeclarationExtractor` uses Kotlin compiler PSI to parse a single Kotlin file and emit the same `PiecePackage` shape as the npm-side adapters, including Kotlin feedback and compile actions for each extracted target. `KotlinPsiAnalysisBackend` exposes that PSI path as a Node-callable manifest backend through `runKotlinPsiAnalysisBackend`; the `piece-compiler/node` entrypoint uses it by default for `.kt` and `.kts` files without making the root or browser bundle depend on Gradle. Node callers can explicitly select `psi`, `fe10-binding-context`, or `analysis-api`; every manifest records `analysisBackend.requested`, `analysisBackend.actual`, and the symbol/diagnostic engines that were used. `analysis-api` is behind the opt-in `pieceAnalysisApiClasspath` Gradle configuration. When the gate is disabled or the runtime is absent, it remains a visible FE10 fallback. When the gate is enabled, the backend launches an isolated JVM with the unshaded Kotlin compiler and Analysis API runtime, then resolves same-file symbols, companion source-set external bindings, imported aliases, simple jar-backed classpath classes, Kotlin constructors, Kotlin top-level jar functions, Kotlin extension jar functions, owner-qualified member properties, and callable signatures through Analysis API so the main process can keep using `kotlin-compiler-embeddable`. The alias path preserves the reference name as the graph-local symbol while binding it to the resolved declaration identity, jar-backed classpath classes/functions retain a `classpath:<jar>!<package>` source identity, member references such as `user.name` are represented as owner-qualified external bindings, and overloaded functions retain optional `signature` metadata without changing the stable import `kind`. Slice-local import bindings let one declaration keep multiple same-name callable bindings, so graph edges and generated package external deps can distinguish calls such as `parse("x")` and `parse(1)` by signature. The same backend can optionally run `K2JVMCompiler` as a compiler diagnostic pass, so Node callers can get real Kotlin semantic/type diagnostics without reimplementing Kotlin in JavaScript; that diagnostic pass receives the same companion source-set files and classpath entries as the rest of Kotlin analysis. The FE10 BindingContext path refines same-file and source-set symbols, which prevents PSI name matching from treating shadowed type parameters as dependencies on same-named top-level declarations and maps companion declarations to external graph edges. Node hosts can provide those companion files inline, as explicit Kotlin file paths, or through `sourceRoots`, can pass external jars or class directories through `classpath`, or can pass `projectRoot` to let the JVM Gradle project-model backend discover KMP source roots and compile classpaths through Gradle Tooling API before invoking the analysis backend. The project model report now includes stable source-root, classpath, and full model hashes, resolved module dependency coordinates, resolved Gradle project dependencies, target variants with source set, target, compile task, and classpath configuration metadata, plus `analysisScope.fallbackReason` and scope diagnostics when the edited file cannot be mapped safely. Node derives an `analysisScope` for the edited source set and reachable project dependency closure, includes required shared source sets such as `commonMain`, and uses the scoped hash in generated Piece action inputs plus snapshot artifact cache keys; when the edited file is outside discovered source sets or the selected source set has no matching compile classpath, Node reports fallback instead of reusing full-project inputs. `KotlinCompileBackend` is also JVM-side Kotlin code: the npm API invokes it through the `runKotlinCompileBackend` Gradle task, and it can either run a real saved-file project variant such as `compileKotlinJvm` when `projectRoot` is provided or keep using generated MPP projects for single-file buffers. It drives Gradle through Tooling API when the wrapper distribution is available, with wrapper execution as a fallback, and reports outputs from root and subproject build directories.

Current JS bridge status: `piece-core` exports JSON bridge functions from `jsMain`, and the npm package exposes `createKotlinCoreBridge()` so a JavaScript host can call the Kotlin core and receive normal JavaScript `PiecePackage` and `PieceGraph` objects. The bridge accepts generated target specs, including action kind, so npm and web hosts can represent compile actions without running the Kotlin compiler in JavaScript. It is not intended as a user-authored DSL.

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
- `src/languages/go/declaration-extractor.js` remains the browser-safe Go single-file fallback; it emits the same manifest and Bazel-like `PiecePackage` shape without making the root or browser bundle depend on Go.
- `src/node-language-compilers.js` owns Node host language-tool entrypoints. Node-side Go analysis defaults to a Go-owned `go/parser` / `go/ast` analyzer under `go-backend/analyzer`, then shells out to official `go list -json ./...` metadata before generated package actions. Go `sourceFiles` and `sourceRoots` companion files are written into the temporary module so package files and package source hashes can enter action identity, and companion declarations are exposed as package-local external bindings so the current file's graph can resolve same-package references without turning companion files into current-file targets. The Go `packageScope.targetPolicy` records that this is still a current-file fast path, and `analysis.packageScope` can expose a candidate package-scope target model that maps those external companion declarations to package-owned targets without applying them to the default single-file package. Passing `packageScopeSelection: "safe"` runs a selection gate and, when feedback scope and edge mapping are safe, exposes a selected `packageScope.packageView` where companion deps are remapped to package-owned targets and generated `.pic` output can use that package view as its primary source. `mergePieceDslFiles()` can use that selected package view directly as its generated merge base, and `piece-compiler/node` `analyzePieceFile({ overrideSource })` can return merged primary `.pic` output plus merge diagnostics without moving ANTLR into the root or browser API. That merged package is metadata-only by default; hosts must pass `pieceDslOverrideMode: "action-snapshot"` before it is exposed as `analysis.actionPackage` and retained on `snapshot.actionPackage`. Node `buildPiecePreview()` and `compilePieceApp()` reuse Node analysis when override/action-snapshot options are present, so helper results retain explicit action package metadata while preview target selection still comes from the normal graph. Direct Go and Kotlin compile helpers can resolve `pieceAction` from an explicit `actionPackage` plus `pieceTarget` / `pieceActionName`; without that package, they keep the current-file defaults. `compilePieceAction()` can take an analyzed package, pick the current action package view, and dispatch the selected compile action to the matching language helper. `compilePieceApp({ compileAction: true })` is opt-in and attaches that language compile report to the app status. Go compilation runs `go list`, `go build`, and optional `go test`. Kotlin compilation delegates to the `piece-core` Kotlin/JVM backend. Node hosts can also call `analyzeKotlinPieceFile()` or `createNodeKotlinPsiDeclarationExtractor()` to run Kotlin PSI analysis on the JVM, opt into Kotlin compiler semantic diagnostics or symbol refinement with optional `sourceFiles`, `sourceRoots`, `classpath`, or Gradle/KMP `projectRoot` discovery, and `piece-compiler/node` wires that extractor as the default Kotlin resolver.
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

- `createNodeGoDeclarationExtractor()` invokes the Go-owned AST analyzer for single-file declaration manifests and falls back to the browser-safe JavaScript extractor if the Go toolchain is unavailable. `compileGoPieceFile()` creates a temporary Go module, writes the single `.go` file, runs `go list -json ./...` for package/module/import metadata and a stable package hash, then runs `go build` and can run `go test`. When callers pass an explicit `actionPackage`, `pieceTarget`, and optional `pieceActionName`, the report includes the selected compile action identity without changing the Go build boundary.
- `analyzeKotlinPieceFile()` is the npm entrypoint for Node-side Kotlin analysis. It writes the source to a temporary host file, invokes `piece-core`'s JVM backend, and returns a normal `PieceFileManifest`. By default this preserves the fast PSI declaration path; `backend: "fe10-binding-context"` explicitly enables FE10 symbol refinement, and `backend: "analysis-api"` reports a fallback unless `analysisApiEnabled: true` and the gated runtime are available. With the gate enabled, the current Analysis API prototype resolves same-file name references, companion source-set declarations, imported aliases, simple jar-backed classpath classes, Kotlin constructors, Kotlin top-level jar functions, Kotlin extension jar functions, owner-qualified member properties, and optional callable signatures in an isolated JVM, reports `analysisBackend.actual: "analysis-api"`, and returns external bindings that the normal graph builder turns into cross-file or classpath edges with alias-local symbols. `semanticDiagnostics: true` additionally runs the official Kotlin compiler diagnostic pass on the JVM. Companion source-set inputs can be inline objects, explicit Kotlin file paths, Kotlin files collected from `sourceRoots`, or Gradle/KMP source roots discovered from `projectRoot`; Node hosts can also pass external jars or class directories through `classpath` or let the Gradle project-model backend discover compile classpaths. When a Gradle project model is present, its `analysisScope` records the selected Gradle project path, reachable project paths, required source sets, scoped classpath, module dependency coordinates, project dependencies, target variants, scoped diagnostics, and scoped hash that is carried into generated Piece action inputs and snapshot cache keys.
- `compileKotlinPieceFile()` is the npm entrypoint, but the compile implementation lives in Kotlin/JVM under `piece-core`. With `projectRoot`, it treats `filePath` as a saved project file, infers source sets such as `jvmMain`, and runs the matching real Gradle/KMP compile task such as `compileKotlinJvm`; without `projectRoot`, it creates a temporary Kotlin Multiplatform project, writes the primary `.kt` file and provided companion Kotlin files into the selected source set, and runs Gradle tasks for `jvm`, `js`, `wasmJs`, or `all`. Node can pass the selected `PieceAction` identity as `pieceAction`, resolve it from an explicit `actionPackage` plus `pieceTarget`, or pass only `pieceTarget` and let the JVM backend resolve the compile action from the Kotlin PSI package. The compile report returns the target/action/artifact identity with the project or generated compiler artifacts so cache and orchestration layers can bind the toolchain result back to the Bazel-like action.
- `compilePieceAction()` is the Node action runner for analyzed packages. It accepts an explicit `actionPackage`, `analysis.actionPackage`, `analysis.snapshot.actionPackage`, or the current-file `analysis.piecePackage`, resolves source and language from that analysis, and dispatches to `compileGoPieceFile()` or `compileKotlinPieceFile()` with the selected action identity.
- `compilePieceApp({ compileAction: true })` keeps the normal app status and preview behavior, then attaches the selected language compile report as `status.compileAction`. The option is off by default, so preview-only hosts do not invoke language toolchains accidentally.
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

- declaration graphs and default packages are still single-file first, while selected toolchain scopes can include same-package companion files and expose candidate or safely selected package-scope targets;
- no workspace-wide dependency resolver yet;
- no handwritten BUILD files;
- generated `.pic` files and package targets are metadata first, with target-level `source` only emitted when a target belongs to a different source label than the package default, selected package-view `.pic` output only after the safe package-scope gate passes, override merging applied against the selected package view only when the Node host passes it explicitly, and merged override packages feeding action/snapshot package views only through an explicit mode;
- unknown edges force fallback instead of pretending local feedback is safe;
- `feedbackScope` records whether the current graph is safe at piece, file, source-set, or project level, with reason codes for unknown edges, top-level effects, slice safety fallback, and Gradle project-model scope fallback;
- selected Kotlin Gradle/KMP source-set scopes carry their scoped source roots, classpath, dependency coordinates, project dependencies, target variants, and `source-set:<scopeHash>` action input without widening to unrelated projects;
- generated Piece action inputs now include target source, dependency, fallback-scope, source-set, Go toolchain and package-source scope, compiler-options, and dependency-artifact hashes; snapshot artifact cache keys include the action-cache identity, and preview runtime cache keys include the fallback-scope identity;
- Kotlin's production extractor and compile backend belong in Kotlin MPP, while the npm Kotlin extractor remains a bridge and test fixture until that core is complete.
