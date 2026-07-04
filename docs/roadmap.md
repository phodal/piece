# Piece Roadmap

Piece is moving toward a Bazel-like build system for AI-era coding, where the target boundary is a semantic piece instead of a whole file.

The durable direction is:

- Piece owns package, target, action, artifact, graph, cache, and fallback contracts.
- Language backends own language semantics by calling official toolchains.
- Node/npm hosts orchestrate tools and return results; they do not implement Kotlin or Go semantics.
- Browser and Wasm paths run model, graph, reconcile, preview, and protocol code; they do not embed full language compilers.

## Current Baseline

The repository already has:

- A language-neutral manifest, graph, closure, package, and reconcile pipeline in `src/core/`.
- TypeScript-family extraction and React preview as one feedback adapter, not the core abstraction.
- A Go single-file adapter plus a Node-hosted Go AST analyzer, package-local companion graph edges, explicit current-file companion target policy, candidate package-scope target models with a safe opt-in selection gate, package-scoped Go action metadata, and `compileGoPieceFile()` using `go list -json`, `go build`, and `go test` with supplied same-package companion sources.
- `piece-core` as a Kotlin Multiplatform core with model, builder DSL, graph, and reconcile contracts in `commonMain`.
- Kotlin/JVM PSI extraction, compiler diagnostics, BindingContext-backed symbol refinement, source-set companion files, host-provided classpath entries, Gradle/KMP `projectRoot` analysis input discovery, dependency coordinates, project dependencies, target variants, source-set-scoped project model inputs, stable project model hashes in action/cache identities, and a Gradle/KMP compile backend.
- An ANTLR-backed JVM parser for `.pic` files, with AST and model conversion in `commonMain`, target-level source preservation, and a Node smoke entrypoint.
- A Kotlin PSI `.pic` generator that emits deterministic package text and verifies the generated file by parsing it back through the same ANTLR backend.
- Go and TypeScript `.pic` generation through `analyzePieceFile().pieceDsl`, with ANTLR round-trip smoke coverage for package parity.
- Safe selected Go package-scope package views can become the primary generated `.pic` output and app-level compile action package while default analysis keeps the current-file `.pic` output.
- User override `.pic` merging can use a selected package-scope package view as its generated merge base.
- `piece-compiler/node` analysis can accept override `.pic` input and return merged primary `.pic` output plus merge diagnostics.
- Merged override packages are metadata-only by default and can feed action/snapshot package views through explicit `pieceDslOverrideMode: "action-snapshot"`.
- Node compile/build helpers retain explicit `actionPackage` metadata when override or action-snapshot options require Node analysis.
- Go and Kotlin language compile helpers can resolve `pieceAction` from an explicit `actionPackage` target/action selection.
- `compilePieceAction()` can dispatch an analyzed package compile action to the matching Go or Kotlin language helper.
- `compilePieceApp({ compileAction: true })` can attach an opt-in language compile report to app status.
- App-level compile action dispatch failures return structured diagnostics without discarding app status.
- App-level compile action status exposes action package source, feedback-scope blockers, package-scope selection state, and source-set scope metadata.
- Generated `.pic` plus user override `.pic` merging, including selected target labels, per-target source labels, visibility, fixture inputs, and explicit action config.
- A Kotlin analysis backend selector exposed through Node and JVM options, with manifest metadata that records requested and actual semantic engines.
- A language-neutral `feedbackScope` explanation that reports piece, file, source-set, or project handling level, carries selected Kotlin Gradle/KMP source-set scope inputs, records Go package-scope fast-path policy, and feeds fallback-scope plus structured fallback-reason identity into generated actions, snapshots, and preview runtime cache hashes.
- JS and Wasm bridges that expose Kotlin core package and graph objects to npm and browser hosts.

## What Is Still Missing

The important gaps are:

- Kotlin semantic analysis can explicitly request PSI, FE10 `BindingContext`, or Analysis API. Analysis API is guarded by an opt-in Gradle configuration and now covers same-file shadowing, companion source-set external bindings, imported aliases, simple jar-backed classpath classes, Kotlin constructors, Kotlin top-level jar functions, Kotlin extension jar functions, owner-qualified member properties, callable signatures for overload and generic fixtures, and signature-qualified graph edges when one declaration calls multiple overloads of the same imported function.
- Kotlin project discovery has a JVM Gradle Tooling API path for analysis and compile inputs. `projectRoot` can discover KMP source roots, compile classpaths, dependency coordinates, project dependencies, and target variants; saved-file compile can run an inferred real project variant; source-set-scoped project model hashes now feed action/cache identities; and unsafe or incomplete project discovery produces explicit scope fallback diagnostics.
- Kotlin compile actions are real and owned by the JVM backend, with real-project `projectRoot` compile for saved files and generated temporary MPP projects for unsaved single-file buffers. The final shape should keep making Kotlin/JVM the rule owner and Node only the invoker.
- Go extraction now has a Node-hosted Go AST analyzer with a JavaScript fallback for root/browser use. Go action identity can include same-package companion files through `go list` metadata and package source hashes, current-file graphs can resolve companion declarations as package-local external edges, `packageScope.targetPolicy` makes the current external-binding decision explicit, and `analysis.packageScope` can expose candidate package-owned companion targets without applying them to the default single-file package. When callers pass `packageScopeSelection: "safe"`, Piece can expose a selected `packageScope.packageView` after checking feedback fallback state, source-target mapping, and label conflicts. The long-term Go rule should expand toward full package/source-set targets using `go list`, `go test`, and `go build` as source-of-truth boundaries.
- The root/browser-safe Kotlin extractor remains a lightweight fallback. Production Kotlin semantics should be routed through `piece-compiler/node` or a service/local agent.
- Cache keys, artifact reuse, and fallback policy now include source, dependency, project-model, fallback-scope, source-set, Go toolchain/package-source scope, compiler-options, and dependency-artifact identity for single-file feedback, but they are not yet a complete multi-language action cache.

## `.pic` DSL Direction

Piece should introduce a first-class DSL with the `.pic` suffix. This is the external DSL for generated package manifests, user overrides, fixtures, and future repository-level package descriptions.

The Kotlin builder DSL remains an internal construction API:

```kotlin
pieceFile("/repo/src/Pricing.kt") {
  language = kotlin()
  target("renderGreeting") {
    rule = function()
    deps(":User", ":Greeting", ":prefix")
    action(compile())
  }
}
```

The external `.pic` DSL should be parsed with ANTLR:

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

Recommended structure:

```text
grammar/
  Piece.g4

piece-core/
  src/commonMain/kotlin/piece/pic/
    PicAst.kt
    PicToModel.kt
    PicFromModel.kt
    PicDiagnostics.kt
  src/jvmMain/java/piece/pic/
    AntlrPicParserBackend.java
  src/jvmMain/kotlin/piece/kotlin/
    KotlinPicGeneratorBackendCli.kt
```

ANTLR's Java runtime should stay in `jvmMain` first. `commonMain` should own only the AST, diagnostics, model conversion, and validation rules. If browser parsing becomes necessary, generate a TypeScript parser from the same grammar or use a service/local agent; do not block the core model on browser-side ANTLR support.

## Roadmap

### Phase 1: Formalize `.pic`

- Done: add `grammar/Piece.g4`.
- Done: add generated-parser Gradle wiring for JVM.
- Done: add `PicAst`, diagnostics, and `PicToModel` in `commonMain`.
- Done: add `AntlrPicParserBackend` in `jvmMain`.
- Done: add tests that parse `.pic` into the existing `PiecePackage`, `PieceTarget`, `PieceAction`, and `PieceArtifact` model.
- Done: add a Node API entrypoint, `parsePieceDslFile()`, plus `npm run pic:dsl:smoke`.

Definition of done: a `.pic` file can round-trip into the same package/action graph that source extraction currently generates.

### Phase 2: Generate `.pic` From Source

- Done: make Kotlin PSI extraction emit `.pic` package text as an optional artifact through the Kotlin/JVM backend.
- Done: parse generated Kotlin `.pic` back through `parsePieceDslFile()` and compare the parsed package with the source-extracted package.
- Done: make Go and TypeScript extractors emit the same `.pic` shape through `analyzePieceFile().pieceDsl`.
- Done: parse generated Go and TypeScript `.pic` back through `parsePieceDslFile()` and compare parsed packages with source-extracted packages.
- Done: support generated `.pic` plus user override `.pic` merging through `mergePieceDslFiles()`.
- Done: let overrides patch target `label`, `visibility`, action `inputs`, `mnemonic`, `output`, and `path` without allowing unknown override targets to add source-owned declarations silently.
- Keep `.pic` generated by default; handwritten `.pic` is for overrides, fixtures, visibility, and explicit action configuration.

Definition of done: source extraction can produce a deterministic `.pic`, parse it back, merge user overrides, parse the merged `.pic`, and produce a predictable package/action graph.

### Phase 3: Kotlin Analysis API Backend

- Done: add an explicit backend selector: `psi`, `fe10-binding-context`, `analysis-api`.
- Done: keep FE10 as a documented fallback only by reporting `analysisBackend.requested`, `analysisBackend.actual`, `status`, and fallback diagnostics in manifests.
- Done: return backend metadata in Kotlin manifests and `.pic` generation reports.
- Done: add Analysis API dependencies behind the opt-in `pieceAnalysisApiClasspath` Gradle configuration and `-PpieceAnalysisApi.enabled=true` gate, without making it the default backend.
- Done: prototype an `analysis-api` symbol backend behind the gate for one same-file shadowed-symbol case.
- Done: return Analysis API companion source-set external bindings so the normal graph builder can produce external edges.
- Done: preserve imported alias locals while binding them to Analysis API-resolved source-set declarations.
- Done: resolve simple jar-backed classpath class, constructor, top-level function, extension function, and owner-qualified member property symbols into external edges.
- Done: retain optional callable `signature` metadata for overloaded and generic Analysis API bindings without widening the stable `PieceImportBinding.kind` contract.
- Done: preserve declaration-local Analysis API import bindings so graph edges and generated package external deps can distinguish multiple same-name overload calls in one declaration.

Definition of done: Kotlin semantic symbols and diagnostics can run through Analysis API when available, and tests prove the FE10 fallback is not silently treated as the final backend.

### Phase 4: Gradle/KMP Project Model

- Done: add a JVM Gradle Tooling API backend that discovers Kotlin source sets and compile classpath configurations from a real Gradle/KMP project.
- Done: expose `projectRoot` / `gradleProjectRoot` through `analyzeKotlinPieceFile()`, `createNodeKotlinPsiDeclarationExtractor()`, and default Node Kotlin analysis.
- Done: merge discovered source roots and classpath entries with manual `sourceFiles`, `sourceRoots`, and `classpath` overrides, then return `manifest.projectModel` metadata.
- Done: add `npm run language:project-model:smoke` with a temporary KMP project that proves discovered `commonMain` source and JVM jar classpath entries become Analysis API graph edges.
- Done: let `compileKotlinPieceFile({ projectRoot })` invoke the real Gradle/KMP project variant for saved files, inferring source sets such as `jvmMain` and tasks such as `compileKotlinJvm`.
- Done: add stable Gradle project model hashes and include them in generated Piece action inputs plus snapshot artifact cache keys.
- Done: infer the edited file's source set before Gradle project-model discovery, resolve only the matching target compile classpath, and expose `manifest.projectModel.analysisScope` with required source sets, scoped classpath, and a scoped cache hash.
- Done: expose resolved Gradle module dependency coordinates and target variants, including compile task and classpath configuration metadata, in `manifest.projectModel` and the scoped analysis model.
- Done: expose resolved Gradle project dependencies and derive the edited file's scoped source roots, classpaths, dependency coordinates, target variants, and hashes across the reachable Gradle project dependency closure.
- Done: expose `analysisScope.fallbackReason` and scope diagnostics when project discovery cannot map the edited file to a source set or cannot find a matching target compile classpath, without reusing unsafe full-project inputs.
- Keep manual inputs as override hooks for editor buffers and unsaved files.

Definition of done: a Kotlin file inside a real Gradle/KMP project can be analyzed and compiled with the correct source set and classpath without hand-supplied dependency lists.

### Phase 5: Language Rule Ownership

- Move Kotlin rule logic fully behind Kotlin/JVM APIs.
- Keep Node as a host that invokes Kotlin JVM and reads JSON reports.
- Move Go toward official `go list`-grounded extraction or a Go-owned backend.
- Done: make `compileGoPieceFile()` run `go list -json ./...` before build/test and return package/module/import metadata plus a stable package hash.
- Done: make Node Go analysis attach `go list -json ./...` metadata to the manifest and generated Piece action-cache inputs.
- Done: add a Go-owned AST analyzer behind the Node host contract, with JavaScript fallback for browser-safe extraction.
- Done: let Node Go analysis include companion `sourceFiles` / `sourceRoots` in `go list` package metadata and `go-package-scope:<hash>` action-cache inputs.
- Done: resolve Go companion declarations into package-local external graph edges without turning companion files into current-file targets.
- Done: make Go companion target policy explicit as a current-file external-binding fast path until Piece has a multi-file package model.
- Done: add a candidate package-scope target model that can promote Go companion external bindings into package-owned targets without changing the default single-file package.
- Done: add a safe opt-in package-scope selection gate that can expose a selected package view without changing the default current-file package.
- Keep JS/TS support first-class, but as one language rule family, not the core architecture.

Definition of done: Piece defines targets/actions/artifacts, while each language backend owns the rule implementation through official tooling.

### Phase 6: Cache, Fallback, and Multi-File Scope

- Done: introduce `feedbackScope` so Piece reports whether feedback is handled at piece, file, source-set, or project level, with reason codes for unknown edges, top-level effects, slice safety fallback, and Gradle project-model fallback.
- Done: include target source hashes, dependency-edge hashes, and fallback-scope hashes in generated Piece action inputs, `.pic` round-trips, snapshots, and preview runtime cache identity.
- Done: extend `feedbackScope.sourceSet` for selected Kotlin Gradle/KMP scopes with scoped source roots, classpath, dependency coordinates, project dependencies, target variants, and `source-set:<scopeHash>` action inputs.
- Done: stabilize action cache metadata across `.pic`, source hashes, dependency hashes, toolchain inputs, compiler options, dependency artifact hashes, project model hashes, source-set hashes, and fallback-scope hashes.
- Done: expose selected Go package scopes as current-file fast-path feedback reasons while keeping companion declarations external until multi-file package targets exist.
- Make unknown edges force documented fallback.
- Expand from single-file package feedback to safe multi-file source-set feedback.
- Preserve single-file speed as the default inner loop.

Definition of done: Piece can explain whether an edit is handled at piece, file, source-set, or project level, and why.

## Completed Phase 2 Slice

The Phase 2 merge slice is now implemented:

1. `mergePieceDslFiles()` parses generated and override `.pic` files through the ANTLR backend.
2. `mergePiecePackages()` patches existing generated targets by source identity or target kind/name.
3. Overrides can change selected target labels, visibility, fixture inputs, action mnemonic/output/path, and keep generated deps/external inputs intact.
4. Unknown override targets produce `pic-merge-unknown-target` warnings instead of mutating the generated source graph.
5. `npm run pic:override:smoke` verifies merged `.pic` output can be parsed back through `parsePieceDslFile()`.

This finishes moving `.pic` from handwritten fixtures into the generated package contract without weakening the language-backend ownership boundary.

## Completed Phase 3 Selector Slice

The first Phase 3 slice is now implemented:

1. `analyzeKotlinPieceFile({ backend })` and JVM `KotlinPsiAnalysisRequest.backend` accept `psi`, `fe10-binding-context`, and `analysis-api`.
2. `analyzePieceFile({ kotlinAnalysisBackend })` forwards the selector to the default Node Kotlin extractor.
3. Kotlin manifests expose `analysisBackend` metadata so hosts can distinguish requested and actual semantic engines.
4. Requesting `analysis-api` returns a visible fallback to `fe10-binding-context` instead of silently claiming Analysis API support.
5. Kotlin `.pic` generation reports include the backend metadata used for source package extraction.

## Completed Phase 3 Analysis API Gate Slice

The second Phase 3 slice is now implemented:

1. `piece-core` has a dedicated `pieceAnalysisApiClasspath` configuration for optional Analysis API runtime artifacts.
2. The dependency and JetBrains package repository are added only when `-PpieceAnalysisApi.enabled=true` is passed.
3. `checkKotlinAnalysisApiGate` verifies the gate without resolving external artifacts by default.
4. JVM and Node analysis reports expose `analysisApiEnabled`, `analysisApiAvailable`, and `analysisApiVersion` metadata for `backend: "analysis-api"` requests.
5. Gate-off Analysis API requests return an explicit fallback diagnostic instead of silently falling through.

## Completed Phase 3 Analysis API Prototype Slice

The third Phase 3 slice is now implemented:

1. The gated Analysis API runtime resolves as an explicit optional artifact set, including the unshaded Kotlin compiler and standalone Analysis API jars required by the isolated backend.
2. `KotlinAnalysisApiSymbolRunner` runs in a separate JVM so the main process can keep using `kotlin-compiler-embeddable` without classpath conflicts.
3. `backend: "analysis-api"` now reports `analysisBackend.actual: "analysis-api"` and `symbols: "analysis-api"` when `analysisApiEnabled: true` and runtime classes are present.
4. The prototype resolves same-file name references through Analysis API for the shadowed-symbol case that previously required FE10 refinement.
5. `npm run language:analysis-api:smoke` proves the gate-on path uses Analysis API and the gate-off path remains an explicit fallback.

## Completed Phase 3 Analysis API External Binding Slice

The fourth Phase 3 slice is now implemented:

1. The isolated Analysis API runner accepts physical and virtual source paths, so reports can map temporary backend files back to host source-set paths.
2. Analysis API symbol resolution now distinguishes primary-file declarations from companion source-set declarations.
3. Companion source-set declarations are emitted as `KotlinPsiImportBinding` records instead of being treated as local same-file targets.
4. The normal graph builder can turn those bindings into external edges such as `/repo/src/Models.kt#User`.
5. `npm run language:analysis-api:smoke` verifies both the same-file shadowing case and the companion source-set external edge case.

## Completed Phase 3 Analysis API Imported Alias Slice

The fifth Phase 3 slice is now implemented:

1. Analysis API external bindings now keep the source reference name as `local` and the resolved declaration name as `imported`.
2. Imported aliases such as `DomainUser` can override the PSI header-only package binding with a source-set binding to `/repo/src/Models.kt#User`.
3. Member references such as `user.name` are no longer promoted to the enclosing top-level class as false external bindings.
4. The graph builder now emits an external edge with alias symbols while keeping the resolved source-set declaration identity.
5. `npm run language:analysis-api:smoke` verifies the alias case and rejects fallback to the package-only `demo.symbols#User` edge.

## Completed Phase 3 Analysis API Classpath Slice

The sixth Phase 3 slice is now implemented:

1. The isolated Analysis API runner accepts host-provided jar or directory classpath entries.
2. Classpath roots are wired into the standalone compiler configuration before building the Analysis API session.
3. Simple jar-backed class symbols now produce semantic import bindings with `classpath:<jar>!<package>` source identities.
4. Implicit runtime symbols such as `kotlin.String` are filtered so classpath binding does not pollute normal piece graphs.
5. `npm run language:analysis-api:smoke` verifies a generated Java jar fixture and the resulting `classpath:<jar>!demo/external#ExternalUser` graph edge.

## Completed Phase 3 Analysis API Top-Level Function Slice

The seventh Phase 3 slice is now implemented:

1. The Analysis API runner distinguishes resolution classpath roots from host-provided identity classpath roots.
2. Compiled Kotlin top-level functions that do not expose PSI paths can still be mapped back to the explicit host jar by package.
3. Top-level jar functions now produce classpath external edges such as `classpath:<jar>!demo/external#formatName`.
4. The smoke fixture generates the Kotlin function jar through the existing Kotlin/JVM compile backend instead of relying on a global `kotlinc`.
5. `npm run language:analysis-api:smoke` verifies both the manifest import binding and graph edge for the jar-backed top-level function.

## Completed Phase 3 Analysis API Extension Function Slice

The eighth Phase 3 slice is now implemented:

1. Analysis API import bindings now feed resolved external locals back into semantic references before graph construction.
2. Jar-backed Kotlin extension function imports such as `demo.external.decorate` keep the callable local name even when the PSI extractor does not surface the selector call as a normal name reference.
3. Extension functions now produce classpath external edges such as `classpath:<jar>!demo/external#decorate`.
4. The smoke fixture compiles the extension function jar through the existing Kotlin/JVM compile backend.
5. `npm run language:analysis-api:smoke` verifies both the manifest import binding and graph edge for the jar-backed extension function.

## Completed Phase 3 Analysis API Constructor And Member Slice

The ninth Phase 3 slice is now implemented:

1. The isolated Analysis API runner recognizes `KaConstructorSymbol` and maps constructor calls back to the containing class identity.
2. Constructor calls such as `ExternalUser(name)` now override package-only import headers with jar-backed class edges such as `classpath:<jar>!demo/external#ExternalUser`.
3. Member property references now keep owner-qualified source identities such as `classpath:<jar>!demo/external/ExternalUser#displayName` or `/repo/src/Models.kt/User#name`.
4. The stable `PieceImportBinding.kind` contract stays `named`; the richer owner information lives in the `source` identity.
5. `npm run language:analysis-api:smoke` verifies constructor, source-set member property, and jar-backed member property graph edges.

## Completed Phase 3 Analysis API Callable Signature Slice

The tenth Phase 3 slice is now implemented:

1. `PieceImportBinding` now supports an optional `signature` field while keeping the existing `kind` values stable.
2. The isolated Analysis API runner extracts `KaFunctionSymbol.valueParameters` and renders compact callable signatures such as `(String)`, `(Int)`, and `(T)`.
3. Header, PSI, FE10, JS/TS, and Go import bindings can continue omitting `signature`; Analysis API adds it only when a callable symbol proves it.
4. Runtime closure and header-change hashes include `signature`, so changing a resolved overload can invalidate the right cached artifacts.
5. `npm run language:analysis-api:smoke` verifies selected overload and generic callable signatures for jar-backed Kotlin functions.

## Completed Phase 3 Multi-Call Overload Graph Slice

The eleventh Phase 3 slice is now implemented:

1. Kotlin Analysis API manifest slices now carry declaration-local import bindings in addition to the whole-file import binding list.
2. The npm symbol table keeps same-name imports as a one-to-many map instead of reducing every local symbol to one binding.
3. The slice graph prefers declaration-local import bindings, so one function body can emit separate external edges for calls such as `parse("x")` and `parse(1)`.
4. Signature-aware graph edge identity and package external deps keep overload identities such as `#parse(String)` and `#parse(Int)` distinct.
5. `npm run language:analysis-api:smoke` verifies both overload graph edges and signature-qualified package deps for a single declaration that calls multiple overloads.

## Completed Phase 6 Feedback Scope Slice

The first Phase 6 slice is now implemented:

1. `explainPieceFeedbackScope()` returns a language-neutral `feedbackScope` with `level`, `fallbackRequired`, reason records, and source/dependency/project/fallback-scope hashes.
2. `analyzePieceFile()`, incremental analysis, `buildPieceClosure()`, and `createPieceSnapshot()` carry the same scope explanation through public results.
3. Unknown graph edges, top-level effects, unsafe slice flags, and Gradle project-model fallback produce documented file or project fallback reasons instead of implicit cache changes.
4. Generated Piece actions include stable `source-hash`, `deps-hash`, and `feedback-scope` inputs; `.pic` source and override round trips preserve those inputs.
5. Snapshot artifact keys and preview runtime closure hashes include `fallbackScopeHash`, so cached artifacts are not reused across unsafe boundary changes.

## Completed Phase 6 Source-Set Feedback Slice

The second Phase 6 slice is now implemented:

1. Selected Kotlin Gradle/KMP analysis scopes now appear as `feedbackScope.sourceSet`.
2. The source-set scope records project root, project path, reachable project paths, required source sets, source roots, classpath, classpath configurations, dependency coordinates, project dependencies, target variants, and hashes.
3. Generated Piece action inputs include `source-set:<scopeHash>` alongside `project-model:<scopeHash>` and `feedback-scope:<fallbackScopeHash>`.
4. Snapshot feedback scope metadata retains the same source-set scope hash used by generated actions.
5. `npm run language:project-model:smoke` verifies the selected `:app` `jvmMain` source-set boundary includes `:domain` but excludes the unrelated `:unused` project.

## Completed Phase 6 Action Cache Metadata Slice

The third Phase 6 slice is now implemented:

1. `createPieceActionCacheMetadata()` normalizes host-provided `compilerOptions`, `compilerOptionsHash`, and `dependencyArtifacts`.
2. `analyzePieceFile()` and incremental analysis carry `analysis.actionCache` through generated Piece packages and snapshots.
3. Generated Piece action inputs include `compiler-options:<hash>` and `dependency-artifacts:<hash>` when hosts provide those cache dimensions.
4. Snapshot artifact cache keys include both compiler options and dependency artifact hashes.
5. `npm run pic:source:smoke` verifies compiler/dependency cache inputs round-trip through generated `.pic` text and the ANTLR parser.

## Next Small Slice

The next implementation slice should keep moving through Phase 5 and Phase 6:

1. Promote safe source-set companion declarations into an explicit source-set package view without changing the default current-file inner loop.

## Completed Phase 5/6 App-Level Source-Set Proof Metadata Slice

The app-level source-set proof metadata slice is now implemented:

1. `compilePieceApp({ compileAction: true })` exposes selected Gradle/KMP source-set proof metadata through `compileActionSelection.sourceSet`.
2. The metadata includes project path, reachable project paths, required source sets, scoped hash, source-root count, classpath count, dependency coordinate count, project dependency count, and target variant count.
3. Source-set fallback metadata still reports fallback status and reason when Gradle project-model discovery cannot prove a safe boundary.
4. The normal app status and preview path remain unchanged; source-set metadata is exposed as selection diagnostics, not as an automatic package widening.
5. `npm run language:project-model:smoke` verifies the selected `:app` `jvmMain` source-set proof appears on app-level compile action selection metadata.

## Completed Phase 5/6 Safe Fast-Path Fallback Gate Slice

The safe fast-path fallback gate slice is now implemented:

1. Safe package-scope selection keeps the generated `.pic` output on the current-file package when `feedbackScope.fallbackRequired` is true.
2. The package-scope promotion blocker now records the fallback level and non-info fallback reason codes such as `unknown-edge-fallback`.
3. Unknown graph edges therefore force a documented fallback before Piece can widen to a selected package view.
4. Candidate package-scope target metadata remains available for diagnostics, but `packageView` is not produced unless the safe gate passes.
5. `npm run pic:source:smoke` verifies a Go companion package with an unresolved reference stays on the current-file fast path even when `packageScopeSelection: "safe"` is requested.

## Completed Phase 5/6 Selected Package-View Status Snapshot Slice

The selected package-view status snapshot slice is now implemented:

1. `compilePieceApp({ compileAction: true, packageScopeSelection: "safe" })` can return an app-level status whose `analysis.snapshot.actionPackage` carries the selected package-view action package.
2. Analysis-level metadata-only behavior remains unchanged: selected package-view analysis still leaves `analysis.actionPackage` and `snapshot.actionPackage` empty until app-level compile-action dispatch asks for the selected action package.
3. Candidate/default package-scope compile action status still avoids writing an action package snapshot.
4. The returned `compileActionSelection.actionPackageSource` continues to report `selected-package-view` for the selected package-view dispatch path.
5. `npm run language:compile:smoke` verifies the selected Go companion target action package snapshot and the candidate package-scope non-snapshot path.

## Completed Phase 5/6 Selected Package-View Compile Action Slice

The selected package-view compile action slice is now implemented:

1. `compilePieceAction()` can use `analysis.packageScope.packageView` as its action package when package-scope status is `selected`.
2. Explicit `actionPackage`, `analysis.actionPackage`, and `snapshot.actionPackage` still take precedence over selected package views.
3. `compilePieceApp({ compileAction: true, packageScopeSelection: "safe" })` reports `compileActionSelection.actionPackageSource: "selected-package-view"` when safe Go package-scope selection passes.
4. The selected package view can dispatch a promoted same-package companion target action such as `//repo/src:Discount.go__type_Discount`.
5. `npm run language:compile:smoke` verifies selected package-view Go action metadata and companion compile success.

## Completed Phase 5/6 Go Companion Compile Slice

The Go companion compile slice is now implemented:

1. `compileGoPieceFile()` collects supplied Go `sourceFiles` and `sourceRoots`.
2. It writes only same-package companion sources into the temporary Go module with the primary source file.
3. `go list -json ./...`, `go build`, and optional `go test` now see those safe companions.
4. App-level Go compile action dispatch can compile a current-file target whose type graph references a same-package companion declaration while still reporting package-scope selection metadata.
5. `npm run language:compile:smoke` verifies the companion source is included in Go list metadata and the package compile succeeds.

## Completed Phase 5/6 App-Level Selection Metadata Slice

The app-level selection metadata slice is now implemented:

1. `compilePieceApp({ compileAction: true })` returns `compileActionSelection` on successful and diagnostic app-level compile action paths.
2. Selection metadata records whether the action package came from an explicit package, `analysis.actionPackage`, `snapshot.actionPackage`, or `analysis.piecePackage`.
3. It exposes feedback-scope fallback blockers without requiring callers to inspect the full analysis object.
4. It exposes package-scope candidate/selected status, requested selection mode, package-view application state, reason text, and non-info blockers.
5. `npm run language:compile:smoke` verifies explicit action-package metadata, invalid-target diagnostic metadata, and Go package-scope candidate metadata on app-level compile status.

## Completed Phase 6 Fallback Reason Action Metadata Slice

The fallback reason action metadata slice is now implemented:

1. `pieceFeedbackFallbackInputs()` converts non-info fallback reasons into stable `fallback-reason:<code>:<hash>` action inputs.
2. Generated Piece actions include those fallback reason inputs when `feedbackScope.fallbackRequired` is true.
3. Unknown-edge fallback therefore becomes visible directly in generated feedback and compile action/cache metadata, not only through the aggregate `feedback-scope:<hash>`.
4. Clean piece-level feedback keeps the existing fast-path action input shape without adding fallback-reason inputs.
5. `npm test` and `npm run pic:source:smoke` verify unknown-edge fallback metadata and `.pic` action input round trips.

## Completed Phase 5/6 App-Level Compile Action Diagnostics Slice

The app-level compile action diagnostics slice is now implemented:

1. `compilePieceApp({ compileAction: true })` catches compile-action dispatch and selection failures at the app-status boundary.
2. Failed dispatch returns `compileActionDiagnostics` with code `piece-compile-action-dispatch-failed`.
3. The normal app status, analysis, and preview metadata remain available when compile-action dispatch fails.
4. The status diagnostic count includes the compile-action dispatch diagnostic.
5. `npm run language:compile:smoke` verifies an invalid app-level Go `pieceTarget` returns a structured diagnostic instead of throwing away the app status.

## Completed Phase 5/6 App-Level Compile Action Slice

The app-level compile action slice is now implemented:

1. `piece-compiler/node` `compilePieceApp()` accepts `compileAction: true`.
2. The option keeps the normal app status and preview behavior, then invokes `compilePieceAction()` from the selected analysis package.
3. Preview `target` can select the same package target for compile action dispatch, while `pieceTarget` can override it explicitly.
4. Kotlin platform dispatch can be provided through `languageTarget` or `kotlinTarget` without reusing preview `target`.
5. `npm run language:compile:smoke` verifies app-level Go compile action output retains the selected package action identity.

## Completed Phase 5/6 Compile Action Runner Slice

The compile action runner slice is now implemented:

1. `piece-compiler/node` exports `compilePieceAction()`.
2. The runner accepts an explicit `actionPackage`, `analysis.actionPackage`, `analysis.snapshot.actionPackage`, or the current-file `analysis.piecePackage`.
3. It derives file path, source, and language from the analyzed package when callers do not pass them directly.
4. It dispatches selected Go actions to `compileGoPieceFile()` and selected Kotlin actions to `compileKotlinPieceFile()`.
5. `npm run language:compile:smoke` verifies a Kotlin `action-snapshot` analysis can feed `compilePieceAction()` and retain the override action identity in the compile report.

## Completed Phase 5/6 Language Compile Action Selection Slice

The language compile action selection slice is now implemented:

1. `compileGoPieceFile()` and `compileKotlinPieceFile()` accept an explicit `actionPackage`.
2. `pieceAction` remains the strongest caller override; `actionPackage` selection is used only when no direct `pieceAction` is supplied.
3. Callers can select a package target by label, id, or name through `pieceTarget`, and can select the compile action through `pieceActionName`.
4. Kotlin still delegates compilation to the JVM backend, but Node can pass the selected action identity from the external package graph.
5. `npm run language:compile:smoke` verifies Go and Kotlin compile reports retain action identity resolved from the explicit action package.

## Completed Phase 2/6 Action Package Helper Propagation Slice

The action package helper propagation slice is now implemented:

1. Core `compilePieceApp()` can reuse an already computed analysis result.
2. `piece-compiler/node` `compilePieceApp()` and `buildPiecePreview()` precompute Node analysis only when override or action-snapshot options require it.
3. Explicit `actionPackage` metadata flows into compile status analysis and preview analysis in helper results.
4. Preview target selection still uses the normal source graph, so override labels do not silently change preview graph behavior.
5. `npm run pic:override:smoke` verifies helper-level action package propagation for analysis, build preview, and compile status.

## Completed Phase 2/6 Explicit Override Action Package Slice

The explicit override action package slice is now implemented:

1. Override merges remain metadata-only by default.
2. `piece-compiler/node` accepts `pieceDslOverrideMode: "action-snapshot"` for callers that want merged override packages to feed action/snapshot package views.
3. In that explicit mode, successful override merges expose `analysis.actionPackage`.
4. `createPieceSnapshot()` preserves an explicit `analysis.actionPackage` as `snapshot.actionPackage`, while default snapshots remain unchanged.
5. `npm run pic:override:smoke` verifies metadata-only defaults and action/snapshot mode for current-file and selected package-view overrides.

## Completed Phase 2/6 Analysis-Level Override Slice

The analysis-level override slice is now implemented:

1. `piece-compiler/node` `analyzePieceFile()` accepts `overrideSource` and `overrideFilePath`.
2. The Node wrapper uses the current primary `.pic` base: current-file package by default or selected package view when `packageScopeSelection: "safe"` passes.
3. Successful merges replace `analysis.pieceDsl`, attach `analysis.pieceDslMerge`, and mark `pieceDslSource` as `current-file-override` or `selected-package-view-override`.
4. Failed override parses or merges keep the generated `.pic` output and expose diagnostics through `analysis.pieceDslMerge`.
5. `npm run pic:override:smoke` verifies both current-file and selected package-view analysis-level overrides.

## Completed Phase 2/6 Package View Override Merge Slice

The package-view override merge slice is now implemented:

1. `mergePieceDslFiles()` accepts an optional `generatedPackage` merge base in addition to generated `.pic` text.
2. Callers can pass `analysis.packageScope.packageView` as that generated base after `packageScopeSelection: "safe"` selects a package view.
3. Override `.pic` targets can patch promoted package-scope targets while preserving target-level `source` labels.
4. Generated package-scope action inputs such as `go-package-scope:<hash>` are retained when an override adds fixture inputs or action config.
5. `npm run pic:override:smoke` verifies both the original current-file merge path and the selected package-view merge path round-trip through the ANTLR parser.

## Completed Phase 5/6 Primary Package View `.pic` Slice

The seventh Phase 6 scope slice is now implemented:

1. `analyzePieceFile()` keeps current-file `.pic` output by default.
2. When `packageScopeSelection: "safe"` passes the selection gate, `analysis.pieceDsl` is generated from the selected `packageScope.packageView`.
3. `analysis.pieceDslSource` records whether primary `.pic` output came from `current-file` or `selected-package-view`.
4. The default `analysis.piecePackage` remains the current-file package so preview and snapshot inner loops do not silently widen.
5. `npm run pic:source:smoke` verifies default `.pic` output remains current-file and safe Go package-scope selection emits a round-trippable selected package view.

## Completed Phase 2/6 Target Source Round-Trip Slice

The target-source `.pic` slice is now implemented:

1. `.pic` target declarations can carry an optional `source` member.
2. The JVM ANTLR parser, `PicAst`, `PicToModel`, and `PicFromModel` preserve target-level source labels while keeping package-level source as the default.
3. The JS `.pic` writer emits target-level `source` only when a target source differs from the package source label.
4. Selected package-scope package views can round-trip through `.pic` without losing promoted companion target source labels.
5. `npm run pic:source:smoke` and `./gradlew jvmTest` verify source-label preservation through the JS writer and JVM parser.

## Completed Phase 5/6 Package Scope Selection Gate Slice

The eighth Phase 5 Go ownership slice and sixth Phase 6 scope slice are now implemented:

1. `createPackageScopeTargetModel()` accepts an explicit `selection: "safe"` gate.
2. The gate checks that feedback scope does not already require fallback, package scope is selected, promoted edges map back to current-file targets, and promoted labels do not conflict.
3. Safe selection keeps `promotion.appliedToDefaultPackage` false, but exposes `promotion.appliedToPackageView` and a selected `packageView`.
4. The selected package view replaces companion external deps with promoted package target deps and generates feedback/compile actions for promoted targets.
5. `npm test` and `npm run pic:source:smoke` verify default candidate behavior and opt-in safe package view selection.

## Completed Phase 5/6 Package Scope Target Model Slice

The seventh Phase 5 Go ownership slice and fifth Phase 6 scope slice are now implemented:

1. Go companion AST analysis now retains package-scope declaration metadata in `manifest.toolchain.packageScope.declarations`.
2. `createPackageScopeTargetModel()` builds a candidate `package-scope-target-model` from the existing manifest, graph, and single-file package.
3. Candidate promoted targets such as `//repo/src:Discount.go__type_Discount` map companion external identities back to package-owned labels.
4. Candidate promoted edges remap current-file external graph edges onto those package-owned labels while `promotion.appliedToDefaultPackage` remains `false`.
5. `analysis.packageScope`, `npm test`, and `npm run pic:source:smoke` verify the candidate model without changing generated `.pic` package round-trips.

## Completed Phase 5/6 Go Package Fast Path Policy Slice

The sixth Phase 5 Go ownership slice and fourth Phase 6 scope slice are now implemented:

1. Go `packageScope` metadata includes a `targetPolicy` that declares the current `current-file-external-bindings` strategy.
2. Companion `.go` declarations still resolve through package-local external graph edges and do not create current-file package targets.
3. `feedbackScope` now emits a `go-package-scope-fast-path` reason that records the selected package scope hash and target policy.
4. Feedback scope dependency and fallback hashes include the selected Go package scope policy, so changing the package-scope identity changes cache boundaries.
5. `npm run pic:source:smoke` and `npm test` verify the policy metadata, current-file feedback level, absence of companion targets, and hash behavior.

## Completed Phase 5 Go Package Graph Edge Slice

The fifth Phase 5 Go ownership slice is now implemented:

1. Companion `.go` files are parsed through the same Go-owned AST analyzer as the primary file.
2. Companion top-level declarations become package-local `PieceImportBinding` records on the current manifest.
3. The existing slice graph builder turns current-file references to companion declarations into external graph edges such as `/repo/src/Discount.go#Discount`.
4. Generated `.pic` package text carries those companion declarations as external deps, without minting current-file targets for companion files.
5. `npm run pic:source:smoke` verifies the companion binding, external graph edge, generated `.pic` external dep, `go list` metadata, package scope action input, and ANTLR round trip.

## Completed Phase 5 Go Package Scope Action Slice

The fourth Phase 5 Go ownership slice is now implemented:

1. `createNodeGoDeclarationExtractor()` accepts Go companion files through `sourceFiles` and `sourceRoots`.
2. Companion `.go` files are written into the same temporary Go module before `go list -json ./...` runs.
3. Go manifests retain current-file AST declarations but their toolchain metadata includes `go list` package files and a `packageScope` source-hash report.
4. Generated Piece action inputs carry both `go-list:<hash>` and `go-package-scope:<hash>` when package companions are present.
5. `npm run pic:source:smoke` verifies package companion files appear in `go list`, package scope metadata, generated action-cache inputs, and `.pic` round trips.

## Completed Phase 5 Go AST Analyzer Slice

The third Phase 5 Go ownership slice is now implemented:

1. `go-backend/analyzer/main.go` uses Go standard-library `go/parser` and `go/ast` to emit the existing `PieceFileManifest` JSON shape.
2. `createNodeGoDeclarationExtractor()` defaults to that Go-owned analyzer and reports `analysisBackend.actual = "go-ast"`.
3. The Node host keeps orchestration ownership only: it invokes the Go analyzer, falls back to the JavaScript extractor when unavailable, and then attaches `go list` toolchain metadata.
4. The root/browser Go extractor remains JavaScript-side so browser-safe paths do not embed Go tooling.
5. `npm run pic:source:smoke` verifies Go AST analysis, `go list` metadata, generated actions, and `.pic` round-trip behavior through the Node entrypoint.

## Completed Phase 5 Go List Action Cache Slice

The second Phase 5 Go ownership slice is now implemented:

1. `piece-compiler/node` uses a Node Go declaration extractor that runs official `go list -json ./...` for `.go` analysis.
2. Go manifests carry `toolchain.kind = "go-list"`, normalized package metadata, and a stable package hash.
3. `createPieceActionCacheMetadata()` accepts toolchain inputs and carries `go-list:<hash>` through generated Piece package actions and `.pic` round trips.
4. Snapshot artifact cache keys include the toolchain input hash, so Go package metadata changes can invalidate cached artifacts.
5. `npm run pic:source:smoke` verifies the Go manifest metadata, action cache input, compile action input, snapshot cache metadata, and ANTLR `.pic` round trip.

## Completed Phase 5 Go List Compile Metadata Slice

The first Phase 5 Go ownership slice is now implemented:

1. `compileGoPieceFile()` runs official `go list -json ./...` before `go build` and optional `go test`.
2. The compile report returns normalized package, module, file, import, dependency, and test metadata.
3. A stable Go package hash summarizes the `go list` package graph for future action cache inputs.
4. The Node host still owns orchestration only; Go toolchain metadata is now the source of truth for compile-scope package facts.
5. `npm run language:compile:smoke` verifies the Go list command, module path, imports, package hash, and built artifact.
