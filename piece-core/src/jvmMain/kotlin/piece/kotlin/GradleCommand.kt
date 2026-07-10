package piece.kotlin

internal fun isWindowsOs(osName: String = System.getProperty("os.name")): Boolean {
    return osName.startsWith("Windows", ignoreCase = true)
}

internal fun defaultGradleWrapperName(osName: String = System.getProperty("os.name")): String {
    return if (isWindowsOs(osName)) "gradlew.bat" else "gradlew"
}

internal fun defaultGradleCommand(osName: String = System.getProperty("os.name")): String {
    return if (isWindowsOs(osName)) ".\\gradlew.bat" else "./gradlew"
}

internal fun gradleProcessCommand(
    command: String,
    args: List<String>,
    osName: String = System.getProperty("os.name"),
    comSpec: String = System.getenv("ComSpec") ?: System.getenv("COMSPEC") ?: "cmd.exe",
): List<String> {
    val isBatchCommand = command.endsWith(".bat", ignoreCase = true) || command.endsWith(".cmd", ignoreCase = true)
    if (!isWindowsOs(osName) || !isBatchCommand) return listOf(command) + args

    // ProcessBuilder does not execute batch files directly. Keep this shell
    // boundary narrow: only an explicit .bat/.cmd Gradle wrapper is routed
    // through cmd.exe, while all other tool commands remain direct execs.
    return listOf(comSpec, "/d", "/s", "/c", "call", command) + args
}

internal fun gradleFallbackArgs(args: List<String>): List<String> {
    return if ("--no-daemon" in args) args else listOf("--no-daemon") + args
}
