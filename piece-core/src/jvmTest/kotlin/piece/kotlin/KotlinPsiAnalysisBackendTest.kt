package piece.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals
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
        val error = semanticManifest.diagnostics.firstOrNull { it.severity == "error" }
        assertTrue(error != null, "Expected Kotlin compiler semantic diagnostics.")
        assertEquals("/repo/src/Broken.kt", error.path)
        assertTrue("String" in error.message || "Int" in error.message, error.message)
    }
}
