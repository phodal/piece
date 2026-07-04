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
- Kotlin/JVM PSI extraction, compiler diagnostics, BindingContext-backed symbol refinement, source-set companion files, host-provided classpath entries, and a Gradle/KMP compile backend.
- An ANTLR-backed JVM parser for `.pic` files, with AST and model conversion in `commonMain` and a Node smoke entrypoint.
- A Kotlin PSI `.pic` generator that emits deterministic package text and verifies the generated file by parsing it back through the same ANTLR backend.
- JS and Wasm bridges that expose Kotlin core package and graph objects to npm and browser hosts.

## What Is Still Missing

The important gaps are:

- The first `.pic` parser slice exists and Kotlin PSI can emit `.pic`, but Go and TypeScript extractors do not yet emit `.pic`, and override merging is not implemented.
- Kotlin semantic analysis still uses FE10 `BindingContext` as the symbol-resolution fallback. It needs a real Kotlin Analysis API backend when the standalone artifacts are stable enough for this package.
- Kotlin project discovery is still host-provided. Source roots, companion files, and classpath can be passed in, but the backend does not yet discover full Gradle/KMP source sets, dependencies, and variants on its own.
- Kotlin compile actions are real but still mediated by the npm function that creates a temporary Gradle project. The final shape should make Kotlin/JVM the rule owner and Node only the invoker.
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
- Make Go and TypeScript extractors emit the same `.pic` shape.
- Support generated `.pic` plus user override `.pic` merging.
- Keep `.pic` generated by default; handwritten `.pic` is for overrides, fixtures, visibility, and explicit action configuration.

Definition of done: source extraction can produce a deterministic `.pic`, parse it back, and produce an equivalent graph.

### Phase 3: Kotlin Analysis API Backend

- Add an explicit backend selector: `psi`, `fe10-binding-context`, `analysis-api`.
- Keep FE10 as a documented fallback only.
- Add Analysis API dependencies behind a clear Gradle configuration once the standalone artifacts are available for the pinned Kotlin version.
- Implement `KotlinAnalysisExtractor` for overloads, imports, aliases, extension functions, generics, and richer classpath/project models.
- Return backend metadata in manifests so hosts know which semantic engine produced diagnostics and edges.

Definition of done: Kotlin semantic symbols and diagnostics can run through Analysis API when available, and tests prove the FE10 fallback is not silently treated as the final backend.

### Phase 4: Gradle/KMP Project Model

- Use Gradle Tooling API to discover source sets, dependencies, classpaths, and target variants.
- Replace manual `sourceRoots`, companion files, and `classpath` wiring with project-model discovery where possible.
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

## Near-Term Slice

The next small implementation slice should continue Phase 2:

1. Make Go and TypeScript extractors emit deterministic `.pic` package text with the same target/action/dependency shape.
2. Parse those generated `.pic` files back through `parsePieceDslFile()`.
3. Compare parsed packages with source-extracted packages for target/action/dependency parity.
4. Add generated `.pic` plus user override `.pic` merging for visibility, fixture inputs, and explicit action configuration.

This finishes moving `.pic` from handwritten fixtures into the generated package contract without weakening the language-backend ownership boundary.
