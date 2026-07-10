package piece.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

class GradleCommandTest {
    @Test
    fun choosesPlatformAppropriateDefaultWrapperNames() {
        assertEquals("gradlew", defaultGradleWrapperName("Mac OS X"))
        assertEquals("gradlew", defaultGradleWrapperName("Linux"))
        assertEquals("gradlew.bat", defaultGradleWrapperName("Windows 11"))
        assertEquals("./gradlew", defaultGradleCommand("Linux"))
        assertEquals(".\\gradlew.bat", defaultGradleCommand("Windows Server 2025"))
    }

    @Test
    fun invokesWindowsBatchWrappersThroughControlledCmd() {
        assertEquals(
            listOf(
                "C:\\Windows\\System32\\cmd.exe",
                "/d",
                "/s",
                "/c",
                "call",
                "C:\\Program Files\\Piece\\gradlew.bat",
                "-p",
                "C:\\workspace with spaces",
                "check",
            ),
            gradleProcessCommand(
                command = "C:\\Program Files\\Piece\\gradlew.bat",
                args = listOf("-p", "C:\\workspace with spaces", "check"),
                osName = "Windows 11",
                comSpec = "C:\\Windows\\System32\\cmd.exe",
            ),
        )
    }

    @Test
    fun keepsBareAndPosixCommandsAsDirectExecutables() {
        assertEquals(
            listOf("gradle", "check"),
            gradleProcessCommand("gradle", listOf("check"), osName = "Windows 11"),
        )
        assertEquals(
            listOf("/repo/gradlew", "check"),
            gradleProcessCommand("/repo/gradlew", listOf("check"), osName = "Mac OS X"),
        )
        assertEquals(
            listOf("C:\\repo\\gradlew.cmd", "check"),
            gradleProcessCommand("C:\\repo\\gradlew.cmd", listOf("check"), osName = "Linux"),
        )
    }

    @Test
    fun disablesTheGradleDaemonForWrapperFallbacks() {
        assertEquals(
            listOf("--no-daemon", "-p", "/repo/generated", "compileKotlinJvm"),
            gradleFallbackArgs(listOf("-p", "/repo/generated", "compileKotlinJvm")),
        )
        assertEquals(
            listOf("--no-daemon", "check"),
            gradleFallbackArgs(listOf("--no-daemon", "check")),
        )
    }
}
