package piece.model

fun piecePackageName(filePath: String): String {
    val normalized = filePath.replace('\\', '/').trimStart('/')
    val index = normalized.lastIndexOf('/')
    return if (index <= 0) "." else normalized.substring(0, index)
}

fun pieceBasename(filePath: String): String {
    return filePath.replace('\\', '/').substringAfterLast('/')
}

fun pieceSourceLabel(filePath: String): String {
    return "//${piecePackageName(filePath)}:${pieceBasename(filePath)}"
}

fun pieceTargetName(filePath: String, kind: PieceTargetKind, name: String): String {
    return "${pieceSanitize(pieceBasename(filePath))}__${kind.name.lowercase()}_${pieceSanitize(name)}"
}

fun pieceTargetLabel(filePath: String, kind: PieceTargetKind, name: String): String {
    return "//${piecePackageName(filePath)}:${pieceTargetName(filePath, kind, name)}"
}

fun pieceNormalizeDep(packageName: String, label: String, targetLabelsByName: Map<String, String>): String {
    if (label.startsWith("//")) return label
    val name = label.trimStart(':')
    return targetLabelsByName[name] ?: "//$packageName:$name"
}

fun pieceSanitize(value: String): String {
    return value.replace(Regex("[^A-Za-z0-9_.-]+"), "-").trim('-').ifEmpty { "piece" }
}
