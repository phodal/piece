# Piece

[![Deploy GitHub Pages](https://github.com/phodal/piece/actions/workflows/pages.yml/badge.svg)](https://github.com/phodal/piece/actions/workflows/pages.yml)

Piece is a piece-aware build feedback layer for AI-era coding agents.

Files remain the storage boundary. Piece makes functions, classes, types, components, values, and other semantic pieces the feedback boundary. After an agent edit, it asks a more useful set of questions than "which file changed?": which piece changed, whether its public shape changed, what downstream pieces are affected, which artifacts can be reused, and when the system must fall back to a file-level or project-level build.

Try the demo: [phodal.github.io/piece](https://phodal.github.io/piece/)

## Why It Exists

Classic build systems organize work around files, targets, actions, and artifacts. Bazel made that model explicit: graph first, deterministic actions second, cacheable outputs third.

AI coding changes the inner loop. Agents often edit a function, class, component, route handler, interface, or template block inside a much larger file. Piece keeps the useful Bazel shape, but lowers the target boundary from the file to a semantic piece:

```text
file -> target -> action -> artifact
```

becomes:

```text
agent edit -> semantic piece -> impact boundary -> feedback artifact
```

Piece is not a new bundler, compiler, or framework. It is the coordination layer between editors, language services, existing build tools, preview hosts, test runners, and agents.

## Architecture

```mermaid
flowchart TB
  A["Source file<br/>storage boundary"]
  B["Language extractor<br/>TS/JS, Kotlin, Go, future adapters"]
  C["Piece manifest<br/>declarations, ranges, symbols, hashes"]
  D["Single-file package<br/>Bazel-like labels, rules, targets"]
  E["Slice graph<br/>runtime, type, external, unknown edges"]
  F["Snapshot reconciler<br/>changed, dirty, reused, invalidated"]
  G{"Safety boundary"}
  H["Closure builder<br/>smallest safe feedback set"]
  I["Host adapter<br/>preview, compile, test, docs, validation"]
  J["Existing toolchain<br/>esbuild, Vite, Gradle, Go, test runners"]
  K["Artifact cache<br/>last good output and reuse metadata"]
  L["File or project fallback"]

  A --> B --> C --> D
  C --> E --> F --> G
  D --> F
  K --> F
  G -->|local boundary is safe| H --> I --> J --> K
  G -->|cannot prove safety| L --> J --> K
```

The Bazel-like part is the package, target, action, dependency graph, and cacheable artifact. The AI-era part is that a single source file can contain many internal targets, and every edit can return a structured update plan to the agent.

## What Works Today

- TypeScript-family extraction for JavaScript, TypeScript, JSX, and TSX.
- A React preview adapter that builds virtual modules for a selected piece.
- A Bazel-style single-file package model with labels, rules, targets, actions, and artifacts.
- Snapshot reconciliation for changed pieces, dirty propagation, affected targets, reused artifacts, and invalidated artifacts.
- Incremental analysis for single-piece edits when the boundary is safe.
- A Go adapter that emits the same piece package shape and can compile a real single-file Go module with `go build` and `go test`.
- A Kotlin adapter for single-file experiments, plus a Kotlin Multiplatform core under `piece-core/`.
- A Kotlin/JVM analysis backend. The `piece-compiler/node` entrypoint uses PSI by default for `.kt` and `.kts` files; the root and browser-safe paths keep the lightweight npm extractor. Node callers can request `psi`, `fe10-binding-context`, or gated `analysis-api`, and manifests report the requested and actual backend so FE10 fallback is visible. The Analysis API dependency path is opt-in through `pieceAnalysisApiClasspath`; when enabled, the isolated-JVM prototype resolves same-file name references, companion source-set external bindings, imported aliases, simple jar-backed classpath class, constructor, top-level function, extension function, owner-qualified member property symbols, and optional callable signatures for overload/generic fixtures through Kotlin Analysis API instead of FE10. The same JVM backend can opt into Kotlin compiler semantic diagnostics; companion files, collected `sourceRoots`, host-provided `classpath` entries, and Gradle/KMP `projectRoot` discovery flow through the same source-set path. Gradle/KMP discovery reports stable project model hashes, resolved module dependency coordinates, and target variants; Node narrows analysis to the edited source set plus required shared source sets; generated Piece action inputs plus snapshot cache keys use the scoped model hash. The Kotlin PSI package view now declares compile actions from the Kotlin side, while JS/Wasm bridges only expose that action model to npm/web hosts.
- A Kotlin/JVM compile backend that can either compile a saved file through its real Gradle/KMP `projectRoot` variant or generate a temporary Kotlin Multiplatform Gradle project for single-file buffers. The JVM backend drives Gradle through Tooling API, with wrapper fallback when the Tooling API distribution cannot be located. It can resolve a selected `pieceTarget` through Kotlin PSI, infer source sets such as `jvmMain` from project paths, compile companion Kotlin files in temporary-project mode, and return the target/action/artifact identity so npm hosts can bind Kotlin toolchain output back to a Bazel-like action.
- An ANTLR-backed `.pic` DSL parser on the JVM side. The parser returns the same `PiecePackage`, `PieceTarget`, `PieceAction`, and `PieceArtifact` model used by source extraction, while common AST/model conversion stays in Kotlin MPP `commonMain`.
- A Kotlin PSI `.pic` generator. `piece-compiler/node` can ask the Kotlin/JVM backend to emit deterministic `.pic` from source extraction, then parse it back through the same ANTLR path for package and graph parity.
- Go and TypeScript `.pic` generation through the normal `analyzePieceFile()` result. JS/TS and Go source extraction now expose deterministic `pieceDsl` text that can be parsed back through the ANTLR backend for package parity.
- A Kotlin piece benchmark that verifies piece-level analysis is faster than whole-file analysis on a generated single-file fixture.

React is only one feedback adapter. JS/TS, Go, and Kotlin use the same manifest, graph, reconciliation, target, action, and artifact vocabulary.

## Repository Shape

```text
src/
  core/                 language-neutral manifest, graph, closure, reconcile
  languages/            JS/TS, Kotlin, and Go extractors
  adapters/react/       React preview virtual-module adapter
  node-language-compilers.js

piece-core/
  src/commonMain/       Kotlin MPP model, DSL, graph, reconcile contracts
  src/jvmMain/          Kotlin PSI extraction, compiler diagnostics, symbol binding, and compile backend
  src/jsMain/           npm-facing bridge
  src/wasmJsMain/       browser smoke bridge

docs/
  architecture.md       single-file Bazel mapping and DSL direction
  roadmap.md            .pic DSL and language-backend roadmap
  kotlin-piece-benchmark.md
```

The intended direction is conservative: keep the core model language-neutral, keep production language behavior close to real toolchains, and let unknown edges force fallback instead of pretending local feedback is always safe.

## Install

```sh
npm install piece-compiler
```

Node.js 20 or newer is required.

## Local Demo

```sh
npm install
npm run preview
```

Open `http://127.0.0.1:8797`. Use `Sample Edit` to see an incremental piece update, affected-target calculation, and preview rebuild metrics.

## Development

```sh
npm run typecheck
npm test
npm run core:check
npm run core:bridge:smoke
npm run pic:dsl:smoke
npm run pic:kotlin:smoke
npm run pic:source:smoke
npm run language:analysis:smoke
npm run language:analysis-api-gate:smoke
npm run language:analysis-api:smoke
npm run language:project-model:smoke
npm run language:compile:smoke
npm run benchmark:kotlin-piece
npm run pages:build
npm run verify
```

The repository includes a root Gradle wrapper. From the repository root, `./gradlew check wasmJsBrowserDistribution` delegates into the single Gradle project under `piece-core/`.

`npm run pic:dsl:smoke` verifies that the Node entrypoint routes `.pic` DSL parsing through the JVM ANTLR backend and receives a normal `PiecePackage`. `npm run pic:kotlin:smoke` verifies that Kotlin PSI source extraction emits deterministic `.pic`, reports backend metadata, parses it back through `parsePieceDslFile()`, and gets the same package shape. `npm run pic:source:smoke` verifies that Go and TypeScript extraction expose `analysis.pieceDsl`, parse that `.pic` back through ANTLR, and get the same package shape. `npm run language:analysis:smoke` verifies that the Node entrypoint routes Kotlin analysis through the JVM backend, reports backend metadata, exposes explicit FE10 selection, shows Analysis API fallback instead of silently claiming support, and can opt into Kotlin compiler semantic diagnostics plus local, companion-file, and `sourceRoots` symbol refinement. `npm run language:analysis-api-gate:smoke` verifies that the optional Analysis API dependency gate is disabled by default and does not resolve external artifacts unless explicitly enabled. `npm run language:analysis-api:smoke` enables that gate and verifies the isolated Analysis API prototype is the actual symbol backend for a shadowed same-file symbol case, a companion source-set external graph edge, an imported alias that keeps the alias as the local graph symbol, a host-provided jar classpath class, jar-backed Kotlin constructors, jar-backed Kotlin top-level plus extension functions, owner-qualified member properties that become external graph edges, and optional callable signatures for overload/generic fixtures. It also checks that companion source-set declarations and host-provided external jars are visible to compiler diagnostics instead of being treated as unresolved single-file names. `npm run language:project-model:smoke` creates a real temporary Gradle/KMP project and verifies that `projectRoot` discovery feeds scoped Kotlin source roots and a JVM compile classpath into Analysis API without hand-supplied `sourceRoots` or `classpath`, that unrelated source sets are excluded from the analysis scope, that resolved dependency coordinates and target variants are reported, that scoped project model hashes become action/cache-key inputs, then compiles that same saved file through the project's inferred `jvmMain` Gradle variant. `npm run language:compile:smoke` requires a local Go toolchain. It compiles a real Go single-file module, then asks the Kotlin/JVM backend to compile a Kotlin source set with a companion file for JVM, JS, and Wasm.

`npm run benchmark:kotlin-piece` writes `reports/kotlin-piece-benchmark.json` and checks that Kotlin piece analysis beats full-file analysis for the generated fixture. See [docs/kotlin-piece-benchmark.md](./docs/kotlin-piece-benchmark.md).

See [docs/roadmap.md](./docs/roadmap.md) for the remaining Kotlin backend work and the planned ANTLR-based `.pic` DSL.

## License

Apache-2.0. See [LICENSE](./LICENSE).
