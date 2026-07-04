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
- A Go single-file adapter plus `compileGoPieceFile()` using `go build` and `go test`.
- `piece-core` as a Kotlin Multiplatform core with model, builder DSL, graph, and reconcile contracts in `commonMain`.
- Kotlin/JVM PSI extraction, compiler diagnostics, BindingContext-backed symbol refinement, source-set companion files, host-provided classpath entries, Gradle/KMP `projectRoot` analysis input discovery, stable project model hashes in action/cache identities, and a Gradle/KMP compile backend.
- An ANTLR-backed JVM parser for `.pic` files, with AST and model conversion in `commonMain` and a Node smoke entrypoint.
- A Kotlin PSI `.pic` generator that emits deterministic package text and verifies the generated file by parsing it back through the same ANTLR backend.
- Go and TypeScript `.pic` generation through `analyzePieceFile().pieceDsl`, with ANTLR round-trip smoke coverage for package parity.
- Generated `.pic` plus user override `.pic` merging, including selected target labels, visibility, fixture inputs, and explicit action config.
- A Kotlin analysis backend selector exposed through Node and JVM options, with manifest metadata that records requested and actual semantic engines.
- JS and Wasm bridges that expose Kotlin core package and graph objects to npm and browser hosts.

## What Is Still Missing

The important gaps are:

- Kotlin semantic analysis can explicitly request PSI, FE10 `BindingContext`, or Analysis API. Analysis API is guarded by an opt-in Gradle configuration and now covers same-file shadowing, companion source-set external bindings, imported aliases, simple jar-backed classpath classes, Kotlin constructors, Kotlin top-level jar functions, Kotlin extension jar functions, owner-qualified member properties, and callable signatures for overload and generic fixtures, but multi-call overload graph disambiguation still needs expansion.
- Kotlin project discovery has an initial JVM Gradle Tooling API path for analysis and compile inputs. `projectRoot` can discover KMP source roots and compile classpaths, saved-file compile can run an inferred real project variant, and project model hashes now feed action/cache identities, but complete dependency/target modeling still needs expansion.
- Kotlin compile actions are real and owned by the JVM backend, with real-project `projectRoot` compile for saved files and generated temporary MPP projects for unsaved single-file buffers. The final shape should keep making Kotlin/JVM the rule owner and Node only the invoker.
- Go semantics are still mostly JavaScript-side extraction plus official `go build`/`go test` for compile. The long-term Go rule should use `go list`, `go test`, and `go build` as the source of truth, or move the Go-specific backend into Go.
- The root/browser-safe Kotlin extractor remains a lightweight fallback. Production Kotlin semantics should be routed through `piece-compiler/node` or a service/local agent.
- Cache keys, artifact reuse, and fallback policy exist for single-file feedback, but they are not yet a complete multi-language action cache.

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
- Continue `KotlinAnalysisExtractor` toward richer classpath/project models and multi-call overload graph disambiguation.

Definition of done: Kotlin semantic symbols and diagnostics can run through Analysis API when available, and tests prove the FE10 fallback is not silently treated as the final backend.

### Phase 4: Gradle/KMP Project Model

- Done: add a JVM Gradle Tooling API backend that discovers Kotlin source sets and compile classpath configurations from a real Gradle/KMP project.
- Done: expose `projectRoot` / `gradleProjectRoot` through `analyzeKotlinPieceFile()`, `createNodeKotlinPsiDeclarationExtractor()`, and default Node Kotlin analysis.
- Done: merge discovered source roots and classpath entries with manual `sourceFiles`, `sourceRoots`, and `classpath` overrides, then return `manifest.projectModel` metadata.
- Done: add `npm run language:project-model:smoke` with a temporary KMP project that proves discovered `commonMain` source and JVM jar classpath entries become Analysis API graph edges.
- Done: let `compileKotlinPieceFile({ projectRoot })` invoke the real Gradle/KMP project variant for saved files, inferring source sets such as `jvmMain` and tasks such as `compileKotlinJvm`.
- Done: add stable Gradle project model hashes and include them in generated Piece action inputs plus snapshot artifact cache keys.
- Continue from source sets, classpaths, compile variants, and project model hashes toward dependency coordinates and complete target/dependency modeling.
- Keep manual inputs as override hooks for editor buffers and unsaved files.

Definition of done: a Kotlin file inside a real Gradle/KMP project can be analyzed and compiled with the correct source set and classpath without hand-supplied dependency lists.

### Phase 5: Language Rule Ownership

- Move Kotlin rule logic fully behind Kotlin/JVM APIs.
- Keep Node as a host that invokes Kotlin JVM and reads JSON reports.
- Move Go toward official `go list`-grounded extraction or a Go-owned backend.
- Keep JS/TS support first-class, but as one language rule family, not the core architecture.

Definition of done: Piece defines targets/actions/artifacts, while each language backend owns the rule implementation through official tooling.

### Phase 6: Cache, Fallback, and Multi-File Scope

- Stabilize action cache keys across `.pic`, source hashes, dependency hashes, compiler options, and project model hashes.
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

## Next Small Slice

The first Phase 4 project-model slices are now implemented:

1. `KotlinGradleProjectModelBackend` runs on the JVM side and invokes Gradle through Tooling API, with wrapper fallback when the Tooling API distribution is unavailable.
2. `analyzeKotlinPieceFile({ projectRoot })` discovers Kotlin source roots and compile classpaths from a real Gradle/KMP project before invoking PSI, FE10, or Analysis API.
3. Manual `sourceFiles`, `sourceRoots`, and `classpath` remain explicit editor-buffer override hooks.
4. `manifest.projectModel` records discovered source sets, classpath configurations, flattened source roots, flattened classpath entries, and fallback diagnostics.
5. `npm run language:project-model:smoke` verifies a real temporary KMP project where discovered `commonMain` source and `jvmMain` jar dependency become Analysis API external graph edges.
6. `compileKotlinPieceFile({ projectRoot })` treats `filePath` as a saved project file, infers source sets such as `jvmMain`, runs real Gradle/KMP compile tasks such as `compileKotlinJvm`, and reports `projectRoot` plus compiled project outputs.
7. `manifest.projectModel.hashes` records stable source-root, classpath, and full model hashes; generated Piece actions include `project-model:<hash>` inputs, and snapshots include the same hash in artifact cache keys.

The next implementation slice should continue Phase 4:

1. Preserve single-file speed by narrowing project model discovery and compile tasks to the source set required for the edited file.
2. Model dependency coordinates and target variants explicitly instead of only flattening classpath files.
3. Keep FE10 fallback and Analysis API gate diagnostics visible when project discovery cannot prove a safe result.
