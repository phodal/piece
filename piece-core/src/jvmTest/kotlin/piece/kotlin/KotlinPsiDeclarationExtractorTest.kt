package piece.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import piece.extract.SourceFile
import piece.model.PieceActionKind

class KotlinPsiDeclarationExtractorTest {
    @Test
    fun extractsSingleFilePackageFromKotlinPsi() {
        val source = """
            package demo.pricing

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

        val pkg = KotlinPsiDeclarationExtractor().extract(
            SourceFile(
                filePath = "/repo/src/Pricing.kt",
                source = source,
            ),
        )

        assertEquals("//repo/src:Pricing.kt", pkg.label)
        assertEquals(
            listOf(
                "User" to "//repo/src:Pricing.kt__class_User",
                "Greeting" to "//repo/src:Pricing.kt__class_Greeting",
                "prefix" to "//repo/src:Pricing.kt__value_prefix",
                "renderGreeting" to "//repo/src:Pricing.kt__function_renderGreeting",
                "Greeter" to "//repo/src:Pricing.kt__class_Greeter",
            ),
            pkg.targets.map { it.name to it.label },
        )

        val renderGreeting = pkg.targets.first { it.name == "renderGreeting" }
        assertEquals(PieceActionKind.Compile, pkg.rules.first { it.name == "kotlin_piece_function" }.actionKind)
        assertEquals("kotlin.function.compile", pkg.rules.first { it.name == "kotlin_piece_function" }.implementation)
        assertEquals(
            listOf(
                "//repo/src:Pricing.kt__function_renderGreeting%feedback",
                "//repo/src:Pricing.kt__function_renderGreeting%compile",
            ),
            renderGreeting.actions,
        )
        assertEquals(
            listOf(
                "//repo/src:Pricing.kt__function_renderGreeting.piece.json",
                "//repo/src:Pricing.kt__function_renderGreeting.compile.json",
            ),
            renderGreeting.artifacts,
        )
        assertTrue(
            pkg.actions.any {
                it.id == "//repo/src:Pricing.kt__function_renderGreeting%compile" &&
                    it.kind == PieceActionKind.Compile &&
                    it.outputs == listOf("//repo/src:Pricing.kt__function_renderGreeting.compile.json")
            },
        )
        assertTrue(
            pkg.artifacts.any {
                it.id == "//repo/src:Pricing.kt__function_renderGreeting.compile.json" &&
                    it.kind == "piece-compile"
            },
        )
        assertEquals(
            listOf(
                "//repo/src:Pricing.kt__class_Greeting",
                "//repo/src:Pricing.kt__class_User",
                "//repo/src:Pricing.kt__value_prefix",
            ),
            renderGreeting.deps,
        )
        assertEquals(listOf("//repo/src:Pricing.kt__value_prefix"), renderGreeting.runtimeDeps)
        assertEquals(
            listOf("//repo/src:Pricing.kt__class_Greeting", "//repo/src:Pricing.kt__class_User"),
            renderGreeting.typeDeps,
        )

        val greeter = pkg.targets.first { it.name == "Greeter" }
        assertEquals(listOf("//repo/src:Pricing.kt__function_renderGreeting"), greeter.runtimeDeps)
        assertEquals(
            listOf("//repo/src:Pricing.kt__class_Greeting", "//repo/src:Pricing.kt__class_User"),
            greeter.typeDeps,
        )
    }
}
