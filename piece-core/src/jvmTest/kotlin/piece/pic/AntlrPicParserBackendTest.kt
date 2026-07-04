package piece.pic

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AntlrPicParserBackendTest {
    @Test
    fun parsesPicDslIntoPiecePackage() {
        val source = """
            package "//repo/src:Pricing.kt" {
              language kotlin
              source "/repo/src/Pricing.kt"

              target class "User" {}
              target class "Greeting" {}
              target value "prefix" {}
              target function "renderGreeting" {
                deps ":User", ":Greeting", ":prefix"
                action compile {
                  mnemonic "PieceCompile"
                  output "Pricing.kt__function_renderGreeting.compile.json"
                }
              }
            }
        """.trimIndent()

        val result = AntlrPicParserBackend().parse(source)
        val pkg = assertNotNull(result.piecePackage)

        assertEquals(emptyList(), result.diagnostics)
        assertEquals("//repo/src:Pricing.kt", pkg.label)
        assertEquals("kotlin", pkg.language)
        assertEquals(
            listOf("User", "Greeting", "prefix", "renderGreeting"),
            pkg.targets.map { it.name },
        )
        assertEquals(
            "//repo/src:Pricing.kt__function_renderGreeting%compile",
            pkg.actions.single { it.kind.name == "Compile" }.id,
        )
    }

    @Test
    fun reportsSyntaxDiagnostics() {
        val result = AntlrPicParserBackend().parse(
            """
                package "//repo/src:Pricing.kt" {
                  language kotlin
                  source "/repo/src/Pricing.kt"
                  target function "renderGreeting" {
                }
            """.trimIndent(),
        )

        assertTrue(result.diagnostics.any { it.code == "pic-syntax-error" })
    }
}
