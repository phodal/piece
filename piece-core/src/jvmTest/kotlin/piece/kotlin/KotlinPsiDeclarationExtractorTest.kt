package piece.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals
import piece.extract.SourceFile

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
