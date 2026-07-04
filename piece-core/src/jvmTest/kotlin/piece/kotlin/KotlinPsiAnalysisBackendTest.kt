package piece.kotlin

import java.nio.file.Files
import java.nio.file.Path
import java.util.jar.JarEntry
import java.util.jar.JarOutputStream
import javax.tools.ToolProvider
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinPsiAnalysisBackendTest {
    @Test
    fun extractsNpmCompatibleManifestFromKotlinPsi() {
        val source = """
            package demo.pricing

            import demo.flags.FeatureFlag

            data class User(val id: String, val name: String)
            data class Greeting(val message: String)

            private val prefix = "Hello"

            fun renderGreeting(user: User): Greeting {
                return Greeting(prefix + ", " + user.name)
            }

            class Greeter {
                fun render(user: User): Greeting = renderGreeting(user)
            }
        """.trimIndent()

        val manifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Pricing.kt",
                source = source,
            ),
        )

        assertEquals("kotlin-psi-declaration-extractor", manifest.parser)
        assertEquals("psi", manifest.analysisBackend.requested)
        assertEquals("psi", manifest.analysisBackend.actual)
        assertEquals("psi", manifest.analysisBackend.symbols)
        assertEquals("none", manifest.analysisBackend.diagnostics)
        assertEquals(
            listOf("User", "Greeting", "prefix", "renderGreeting", "Greeter"),
            manifest.slices.map { it.name },
        )
        assertEquals(
            KotlinPsiImportBinding(
                local = "FeatureFlag",
                imported = "FeatureFlag",
                source = "demo.flags",
                kind = "named",
            ),
            manifest.importBindings.single(),
        )

        val renderGreeting = manifest.slices.first { it.name == "renderGreeting" }
        assertEquals(listOf("Greeting", "User"), renderGreeting.symbols.typeReferences)
        assertTrue("prefix" in renderGreeting.symbols.references)
    }

    @Test
    fun collectsCompilerDiagnosticsWhenSemanticPassIsEnabled() {
        val source = """
            package demo.broken

            fun broken(): String = 42
        """.trimIndent()

        val defaultManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Broken.kt",
                source = source,
            ),
        )
        val semanticManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Broken.kt",
                source = source,
                semanticDiagnostics = true,
            ),
        )

        assertEquals(emptyList(), defaultManifest.diagnostics)
        assertEquals("kotlin-compiler-diagnostics", semanticManifest.analysisBackend.diagnostics)
        val error = semanticManifest.diagnostics.firstOrNull { it.severity == "error" }
        assertTrue(error != null, "Expected Kotlin compiler semantic diagnostics.")
        assertEquals("/repo/src/Broken.kt", error.path)
        assertTrue("String" in error.message || "Int" in error.message, error.message)
    }

    @Test
    fun refinesReferencesWithCompilerBindingSymbols() {
        val source = """
            package demo.symbols

            class User

            fun <User> render(value: User): User = value
        """.trimIndent()

        val psiManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Symbols.kt",
                source = source,
            ),
        )
        val semanticManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Symbols.kt",
                source = source,
                backend = KotlinAnalysisBackendKind.Fe10BindingContext,
            ),
        )

        val psiRender = psiManifest.slices.first { it.name == "render" }
        val semanticRender = semanticManifest.slices.first { it.name == "render" }
        assertEquals("fe10-binding-context", semanticManifest.analysisBackend.requested)
        assertEquals("fe10-binding-context", semanticManifest.analysisBackend.actual)
        assertEquals("fe10-binding-context", semanticManifest.analysisBackend.symbols)
        assertEquals(listOf("User"), psiRender.symbols.references)
        assertEquals(listOf("User"), psiRender.symbols.typeReferences)
        assertEquals(emptyList(), semanticRender.symbols.references)
        assertEquals(emptyList(), semanticRender.symbols.typeReferences)
        assertFalse("User" in semanticRender.symbols.references)
    }

    @Test
    fun reportsAnalysisApiFallbackWithoutSilentlyClaimingSupport() {
        val source = """
            package demo.symbols

            class User

            fun <User> render(value: User): User = value
        """.trimIndent()

        val manifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Symbols.kt",
                source = source,
                backend = KotlinAnalysisBackendKind.AnalysisApi,
            ),
        )

        val render = manifest.slices.first { it.name == "render" }
        assertEquals("analysis-api", manifest.analysisBackend.requested)
        assertEquals("fe10-binding-context", manifest.analysisBackend.actual)
        assertEquals("fallback", manifest.analysisBackend.status)
        assertTrue(manifest.analysisBackend.fallbackReason?.contains("Analysis API") == true)
        assertTrue(manifest.diagnostics.any { it.code == "kotlin-analysis-backend-fallback" && it.severity == "warning" })
        assertEquals(emptyList(), render.symbols.references)
        assertEquals(emptyList(), render.symbols.typeReferences)
    }

    @Test
    fun resolvesCompanionFileSymbolsAsExternalBindings() {
        val source = """
            package demo.symbols

            fun render(user: User): String = user.name
        """.trimIndent()

        val semanticManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Render.kt",
                source = source,
                semanticSymbols = true,
                companionFiles = listOf(
                    KotlinPsiAnalysisSourceFile(
                        filePath = "/repo/src/Models.kt",
                        source = """
                            package demo.symbols

                            data class User(val name: String)
                        """.trimIndent(),
                    ),
                ),
            ),
        )

        val render = semanticManifest.slices.first { it.name == "render" }
        assertEquals(listOf("User"), render.symbols.typeReferences)
        assertEquals(
            KotlinPsiImportBinding(
                local = "User",
                imported = "User",
                source = "/repo/src/Models.kt",
                kind = "named",
            ),
            semanticManifest.importBindings.single(),
        )
    }

    @Test
    fun checksSemanticDiagnosticsAgainstCompanionFiles() {
        val source = """
            package demo.symbols

            fun render(user: User): String = user.name
        """.trimIndent()

        val semanticManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Render.kt",
                source = source,
                semanticDiagnostics = true,
                companionFiles = listOf(
                    KotlinPsiAnalysisSourceFile(
                        filePath = "/repo/src/Models.kt",
                        source = """
                            package demo.symbols

                            data class User(val name: String)
                        """.trimIndent(),
                    ),
                ),
            ),
        )

        assertFalse(
            semanticManifest.diagnostics.any { diagnostic ->
                diagnostic.severity == "error" && diagnostic.message.contains("User")
            },
            "Companion source-set declarations should be visible to Kotlin compiler diagnostics: ${semanticManifest.diagnostics}",
        )
    }

    @Test
    fun mapsCompanionSemanticDiagnosticPathsBackToVirtualSourcePaths() {
        val source = """
            package demo.symbols

            fun render(user: User): String = user.name
        """.trimIndent()

        val semanticManifest = KotlinPsiAnalysisBackend().analyze(
            KotlinPsiAnalysisRequest(
                filePath = "/repo/src/Render.kt",
                source = source,
                semanticDiagnostics = true,
                companionFiles = listOf(
                    KotlinPsiAnalysisSourceFile(
                        filePath = "/repo/src/Models.kt",
                        source = """
                            package demo.symbols

                            data class User(val name: MissingType)
                        """.trimIndent(),
                    ),
                ),
            ),
        )

        val error = semanticManifest.diagnostics.firstOrNull { diagnostic ->
            diagnostic.severity == "error" && diagnostic.message.contains("MissingType")
        }
        assertTrue(error != null, "Expected compiler diagnostics from the companion source file.")
        assertEquals("/repo/src/Models.kt", error.path)
    }

    @Test
    fun usesHostProvidedClasspathForSemanticDiagnostics() {
        val workspace = Files.createTempDirectory("piece-kotlin-external-classpath-")
        try {
            val externalJar = createExternalUserJar(workspace)
            val source = """
                package demo.externaluse

                import demo.external.ExternalUser

                fun render(user: ExternalUser): String = user.name
            """.trimIndent()

            val withoutClasspath = KotlinPsiAnalysisBackend().analyze(
                KotlinPsiAnalysisRequest(
                    filePath = "/repo/src/Render.kt",
                    source = source,
                    semanticDiagnostics = true,
                ),
            )
            val withClasspath = KotlinPsiAnalysisBackend().analyze(
                KotlinPsiAnalysisRequest(
                    filePath = "/repo/src/Render.kt",
                    source = source,
                    semanticDiagnostics = true,
                    classpath = defaultKotlinSemanticClasspath() + externalJar.toString(),
                ),
            )

            assertTrue(
                withoutClasspath.diagnostics.any { it.severity == "error" },
                "Expected unresolved external class without host classpath.",
            )
            assertFalse(
                withClasspath.diagnostics.any { it.severity == "error" },
                "Host classpath should make external Java classes visible to Kotlin diagnostics: ${withClasspath.diagnostics}",
            )
        } finally {
            workspace.toFile().deleteRecursively()
        }
    }
}

private fun createExternalUserJar(workspace: Path): Path {
    val sourceDir = workspace.resolve("src/demo/external")
    val classesDir = workspace.resolve("classes")
    sourceDir.createDirectories()
    classesDir.createDirectories()
    val sourceFile = sourceDir.resolve("ExternalUser.java")
    sourceFile.writeText(
        """
            package demo.external;

            public class ExternalUser {
                public String getName() {
                    return "Ada";
                }
            }
        """.trimIndent(),
    )

    val compiler = ToolProvider.getSystemJavaCompiler()
        ?: error("A JDK compiler is required for the Kotlin classpath fixture.")
    val exitCode = compiler.run(null, null, null, "-d", classesDir.toString(), sourceFile.toString())
    check(exitCode == 0) { "Failed to compile external Java fixture." }

    val jarPath = workspace.resolve("external-user.jar")
    JarOutputStream(Files.newOutputStream(jarPath)).use { jar ->
        jar.putNextEntry(JarEntry("demo/external/ExternalUser.class"))
        Files.copy(classesDir.resolve("demo/external/ExternalUser.class"), jar)
        jar.closeEntry()
    }
    return jarPath
}
