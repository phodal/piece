package piece.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

class KotlinCompileBackendTest {
    @Test
    fun resolvesCompileActionFromKotlinPsiPackage() {
        val source = """
            package demo.pricing

            data class User(val name: String)

            fun renderGreeting(user: User): String = "Hello, " + user.name
        """.trimIndent()

        val action = KotlinCompileRequest(
            filePath = "/repo/src/Pricing.kt",
            source = source,
            gradleCommand = "./gradlew",
            pieceTarget = "renderGreeting",
        ).resolvePieceAction()

        assertEquals(
            KotlinCompilePieceAction(
                targetLabel = "//repo/src:Pricing.kt__function_renderGreeting",
                actionId = "//repo/src:Pricing.kt__function_renderGreeting%compile",
                artifactId = "//repo/src:Pricing.kt__function_renderGreeting.compile.json",
                kind = "compile",
            ),
            action,
        )
    }

    @Test
    fun explicitCompileActionOverridesPsiResolution() {
        val explicit = KotlinCompilePieceAction(
            targetLabel = "//repo/src:Pricing.kt__function_Custom",
            actionId = "//repo/src:Pricing.kt__function_Custom%compile",
            artifactId = "//repo/src:Pricing.kt__function_Custom.compile.json",
        )

        val action = KotlinCompileRequest(
            filePath = "/repo/src/Pricing.kt",
            source = "fun renderGreeting(): String = \"Hello\"",
            gradleCommand = "./gradlew",
            pieceTarget = "renderGreeting",
            pieceAction = explicit,
        ).resolvePieceAction()

        assertEquals(explicit, action)
    }
}
