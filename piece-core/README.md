# Piece Core

This is the Kotlin Multiplatform core for Piece.

The first npm package remains the runnable host for editors and React preview. This module owns the language-neutral model, generated DSL, graph utilities, and reconciliation primitives that should eventually be shared by Kotlin/JVM and JavaScript adapters.

Current scope:

- `commonMain`: model, internal builder DSL, future `.pic` AST/model conversion, graph, snapshot/reconcile contracts.
- `jvmMain`: Kotlin compiler PSI extractor that maps a single `.kt` file into a `PiecePackage` with feedback and compile actions, the Node-callable PSI analysis backend with optional Kotlin compiler semantic diagnostics and same-source-set symbol binding, and the Kotlin/JVM compile backend used by the npm host for primary plus companion source-set files.
- `jsMain`: bridge boundary for npm-facing integration, including generated target/action specs but not a browser Kotlin compiler.

Use the checked-in Gradle wrapper for local validation:

```sh
./gradlew check wasmJsBrowserDistribution
```

From the repository root, the same Gradle project is available through the
delegating `./gradlew` script.

The current JVM extractor is declaration-oriented. The PSI analysis backend already returns an npm-compatible `PieceFileManifest`, can opt into a `K2JVMCompiler` diagnostic pass for real Kotlin type/semantic errors, can refine same-file and host-provided source-set symbols through compiler BindingContext, and the compile backend runs on the JVM side using Gradle/Kotlin MPP as the actual toolchain. The diagnostic and symbol passes both receive the host-provided source-set companion files and classpath entries, so source-set or external classpath types are not treated as unresolved single-file names. A later semantic slice should add Kotlin Analysis API symbol resolution for overloads, imports, and richer project models.

The next DSL slice is an ANTLR-backed `.pic` file format. Keep the ANTLR parser implementation in `jvmMain` first, and keep common AST, diagnostics, validation, and model conversion in `commonMain`.
