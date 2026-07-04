# Piece Core

This is the Kotlin Multiplatform core for Piece.

The first npm package remains the runnable host for editors and React preview. This module owns the language-neutral model, generated DSL, graph utilities, and reconciliation primitives that should eventually be shared by Kotlin/JVM and JavaScript adapters.

Current scope:

- `commonMain`: model, internal builder DSL, `.pic` AST/model conversion and writer, graph, snapshot/reconcile contracts.
- `jvmMain`: Kotlin compiler PSI extractor that maps a single `.kt` file into a `PiecePackage` with feedback and compile actions, the Node-callable Kotlin analysis backend with explicit `psi`, `fe10-binding-context`, and gated `analysis-api` selection metadata, an isolated-JVM Analysis API symbol prototype for same-file, source-set, imported-alias, simple jar-backed classpath class, constructor, top-level function, extension function, owner-qualified member property, and callable-signature bindings, optional Kotlin compiler semantic diagnostics and same-source-set symbol binding, a Gradle/KMP project-model discovery backend for source roots and compile classpaths, the JVM ANTLR `.pic` parser backend, the Kotlin PSI `.pic` generator backend, and the Kotlin/JVM compile backend used by the npm host for real project variants plus generated single-file projects.
- `jsMain`: bridge boundary for npm-facing integration, including generated target/action specs but not a browser Kotlin compiler.

Use the checked-in Gradle wrapper for local validation:

```sh
./gradlew check wasmJsBrowserDistribution
```

From the repository root, the same Gradle project is available through the
delegating `./gradlew` script.

The current JVM extractor is declaration-oriented. The analysis backend already returns an npm-compatible `PieceFileManifest` with `analysisBackend` metadata. PSI is the default, FE10 BindingContext is an explicit symbol-refinement backend, and Analysis API is behind the opt-in `pieceAnalysisApiClasspath` Gradle configuration. Until the runtime and gate are both present, Analysis API requests report a visible fallback to FE10. When enabled, the Analysis API path runs in an isolated JVM with the unshaded Kotlin compiler and currently covers same-file symbol shadowing, companion source-set external bindings, imported aliases, simple jar-backed classpath classes, Kotlin constructors, Kotlin top-level jar functions, Kotlin extension jar functions, owner-qualified member properties, and optional callable signatures for overload/generic fixtures. The backend can opt into a `K2JVMCompiler` diagnostic pass for real Kotlin type/semantic errors, can refine same-file and source-set symbols through compiler BindingContext, and the compile backend runs on the JVM side using Gradle/Kotlin MPP as the actual toolchain. Node callers may still provide companion files, `sourceRoots`, and `classpath` manually, but can pass `projectRoot` so the JVM Gradle project-model backend discovers KMP source sets and compile classpaths through Gradle Tooling API. The compile backend also accepts `projectRoot` for saved files and runs the inferred real project variant, while unsaved single-file buffers can still use the generated temporary MPP project path. Later semantic slices should expand this toward project model hashing, complete dependency modeling, and multi-call overload graph disambiguation.

The first DSL slice is an ANTLR-backed `.pic` file format. The ANTLR parser implementation stays in `jvmMain`, while common AST, diagnostics, validation, model conversion, and deterministic `.pic` writing stay in `commonMain`. Kotlin PSI can already emit `.pic` through a JVM backend and parse it back for package and graph parity.
