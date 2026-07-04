package piece.kotlin

import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtImportDirective
import piece.extract.SourceFile
import piece.model.PieceSourceRange
import piece.model.PieceTargetKind

private const val DEFAULT_KOTLIN_PSI_PARSER_NAME = "kotlin-psi-declaration-extractor"

data class KotlinPsiAnalysisRequest(
    val filePath: String,
    val source: String,
    val parserName: String = DEFAULT_KOTLIN_PSI_PARSER_NAME,
)

data class KotlinPsiImportBinding(
    val local: String,
    val imported: String,
    val source: String,
    val kind: String,
    val isTypeOnly: Boolean = false,
)

data class KotlinPsiDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
)

data class KotlinPsiManifestSymbol(
    val defines: List<String>,
    val references: List<String>,
    val typeReferences: List<String>,
    val jsxReferences: List<String> = emptyList(),
)

data class KotlinPsiManifestPreview(
    val previewable: Boolean,
    val reason: String? = null,
)

data class KotlinPsiManifestHashes(
    val bodyHash: String,
    val signatureHash: String,
    val typeHash: String? = null,
)

data class KotlinPsiManifestSafety(
    val hasTopLevelSideEffect: Boolean,
    val hasDynamicImport: Boolean,
    val hasUnknownGlobal: Boolean,
    val fallbackRequired: Boolean,
)

data class KotlinPsiManifestSlice(
    val id: String,
    val filePath: String,
    val kind: String,
    val name: String,
    val exportName: String,
    val isDefaultExport: Boolean,
    val range: PieceSourceRange,
    val source: String,
    val symbols: KotlinPsiManifestSymbol,
    val preview: KotlinPsiManifestPreview,
    val hashes: KotlinPsiManifestHashes,
    val safety: KotlinPsiManifestSafety,
)

data class KotlinPsiManifestHeader(
    val id: String,
    val filePath: String,
    val kind: String = "header",
    val range: PieceSourceRange,
    val source: String,
    val importBindings: List<KotlinPsiImportBinding> = emptyList(),
)

data class KotlinPsiManifestEffect(
    val id: String,
    val filePath: String,
    val kind: String = "effect",
    val range: PieceSourceRange,
    val source: String,
    val hashes: KotlinPsiManifestHashes,
    val safety: KotlinPsiManifestSafety,
)

data class KotlinPsiManifest(
    val version: Int = 1,
    val filePath: String,
    val source: String,
    val parser: String,
    val slices: List<KotlinPsiManifestSlice>,
    val headers: List<KotlinPsiManifestHeader>,
    val effects: List<KotlinPsiManifestEffect>,
    val importBindings: List<KotlinPsiImportBinding>,
    val hasTopLevelEffect: Boolean,
    val diagnostics: List<KotlinPsiDiagnostic>,
) {
    fun toJson(): String = buildKotlinPsiJsonObject {
        field("version", version)
        field("filePath", filePath)
        field("source", source)
        field("parser", parser)
        field("slices", slices) { it.toJson() }
        field("headers", headers) { it.toJson() }
        field("effects", effects) { it.toJson() }
        field("importBindings", importBindings) { it.toJson() }
        field("hasTopLevelEffect", hasTopLevelEffect)
        field("diagnostics", diagnostics) { it.toJson() }
    }
}

class KotlinPsiAnalysisBackend {
    fun analyze(request: KotlinPsiAnalysisRequest): KotlinPsiManifest {
        val file = SourceFile(request.filePath, request.source)
        return withKtFile(file) { ktFile ->
            val declarations = ktFile.declarations.mapNotNull { declaration ->
                declaration.toPieceDeclaration(file)
            }
            val slices = declarations.map { declaration ->
                declaration.toManifestSlice(file)
            }
            val headers = ktFile.toHeaders(file)
            val effects = ktFile.toEffects(file, declarations, headers)

            KotlinPsiManifest(
                filePath = request.filePath,
                source = request.source,
                parser = request.parserName.ifBlank { DEFAULT_KOTLIN_PSI_PARSER_NAME },
                slices = slices,
                headers = headers,
                effects = effects,
                importBindings = headers.flatMap { it.importBindings },
                hasTopLevelEffect = effects.isNotEmpty(),
                diagnostics = emptyList(),
            )
        }
    }
}

fun errorKotlinPsiManifest(request: KotlinPsiAnalysisRequest, error: Throwable): KotlinPsiManifest {
    return KotlinPsiManifest(
        filePath = request.filePath,
        source = request.source,
        parser = request.parserName.ifBlank { DEFAULT_KOTLIN_PSI_PARSER_NAME },
        slices = emptyList(),
        headers = emptyList(),
        effects = listOf(
            KotlinPsiManifestEffect(
                id = "${request.filePath}#effect:analysis-error",
                filePath = request.filePath,
                range = sourceRange(request.source, 0, request.source.length),
                source = request.source,
                hashes = KotlinPsiManifestHashes(bodyHash = stableTextHash(request.source), signatureHash = stableTextHash(request.source)),
                safety = KotlinPsiManifestSafety(
                    hasTopLevelSideEffect = true,
                    hasDynamicImport = false,
                    hasUnknownGlobal = true,
                    fallbackRequired = true,
                ),
            ),
        ),
        importBindings = emptyList(),
        hasTopLevelEffect = true,
        diagnostics = listOf(
            KotlinPsiDiagnostic(
                code = "kotlin-psi-analysis-error",
                severity = "error",
                message = error.message ?: error::class.java.name,
            ),
        ),
    )
}

private fun KotlinPieceDeclaration.toManifestSlice(file: SourceFile): KotlinPsiManifestSlice {
    val kindName = kind.name.lowercase()
    val sliceSource = file.source.substring(range.startByte, range.endByte)
    val typeReferenceSet = typeReferences.toSet()
    val references = (runtimeReferences + typeReferences).distinct().sorted()
    val signature = declarationSignature(sliceSource)

    return KotlinPsiManifestSlice(
        id = "${file.filePath}#$kindName:$name",
        filePath = file.filePath,
        kind = kindName,
        name = name,
        exportName = name,
        isDefaultExport = false,
        range = range,
        source = sliceSource,
        symbols = KotlinPsiManifestSymbol(
            defines = listOf(name),
            references = references,
            typeReferences = references.filter { it in typeReferenceSet },
        ),
        preview = KotlinPsiManifestPreview(
            previewable = kind == PieceTargetKind.Class || kind == PieceTargetKind.Function,
            reason = if (kind == PieceTargetKind.Class || kind == PieceTargetKind.Function) null else "not a runnable feedback target",
        ),
        hashes = KotlinPsiManifestHashes(
            bodyHash = stableTextHash(sliceSource),
            signatureHash = stableTextHash(signature),
            typeHash = if (kind == PieceTargetKind.Type) stableTextHash(sliceSource) else null,
        ),
        safety = KotlinPsiManifestSafety(
            hasTopLevelSideEffect = false,
            hasDynamicImport = false,
            hasUnknownGlobal = false,
            fallbackRequired = false,
        ),
    )
}

private fun KtFile.toHeaders(file: SourceFile): List<KotlinPsiManifestHeader> {
    val packageHeader = packageDirective?.let { directive ->
        HeaderRange(
            range = sourceRange(file.source, directive.textRange.startOffset, directive.textRange.endOffset),
            importBindings = emptyList(),
        )
    }
    val importHeaders = importDirectives.map { directive ->
        HeaderRange(
            range = sourceRange(file.source, directive.textRange.startOffset, directive.textRange.endOffset),
            importBindings = directive.toImportBinding()?.let(::listOf).orEmpty(),
        )
    }
    return (listOfNotNull(packageHeader) + importHeaders)
        .sortedBy { it.range.startByte }
        .mapIndexed { index, header ->
            KotlinPsiManifestHeader(
                id = "${file.filePath}#header:header-$index",
                filePath = file.filePath,
                range = header.range,
                source = file.source.substring(header.range.startByte, header.range.endByte),
                importBindings = header.importBindings,
            )
        }
}

private fun KtImportDirective.toImportBinding(): KotlinPsiImportBinding? {
    val importedPath = importPath?.pathStr ?: return null
    val parts = importedPath.split('.')
    val imported = parts.lastOrNull()?.takeIf { it.isNotBlank() } ?: return null
    val isWildcard = imported == "*"
    return KotlinPsiImportBinding(
        local = aliasName ?: imported,
        imported = imported,
        source = parts.dropLast(1).joinToString("."),
        kind = if (isWildcard) "namespace" else "named",
        isTypeOnly = false,
    )
}

private fun KtFile.toEffects(
    file: SourceFile,
    declarations: List<KotlinPieceDeclaration>,
    headers: List<KotlinPsiManifestHeader>,
): List<KotlinPsiManifestEffect> {
    val coveredRanges = (
        declarations.map { it.range.startByte to it.range.endByte } +
            headers.map { it.range.startByte to it.range.endByte }
        )
        .sortedWith(compareBy({ it.first }, { it.second }))
    val effects = mutableListOf<KotlinPsiManifestEffect>()
    var cursor = 0
    var index = 0

    for ((start, end) in coveredRanges) {
        if (cursor < start) {
            file.toEffect(cursor, start, index)?.let {
                effects += it
                index += 1
            }
        }
        cursor = maxOf(cursor, end)
    }
    if (cursor < file.source.length) {
        file.toEffect(cursor, file.source.length, index)?.let { effects += it }
    }
    return effects
}

private fun SourceFile.toEffect(startByte: Int, endByte: Int, index: Int): KotlinPsiManifestEffect? {
    val effectSource = source.substring(startByte, endByte)
    if (effectSource.isBlank()) return null
    return KotlinPsiManifestEffect(
        id = "$filePath#effect:top-level-$index",
        filePath = filePath,
        range = sourceRange(source, startByte, endByte),
        source = effectSource,
        hashes = KotlinPsiManifestHashes(
            bodyHash = stableTextHash(effectSource),
            signatureHash = stableTextHash(effectSource),
        ),
        safety = KotlinPsiManifestSafety(
            hasTopLevelSideEffect = true,
            hasDynamicImport = false,
            hasUnknownGlobal = true,
            fallbackRequired = true,
        ),
    )
}

private data class HeaderRange(
    val range: PieceSourceRange,
    val importBindings: List<KotlinPsiImportBinding>,
)

private fun declarationSignature(source: String): String {
    val bodyStart = listOf(source.indexOf('{'), source.indexOf('='))
        .filter { it >= 0 }
        .minOrNull()
    return if (bodyStart == null) source else source.substring(0, bodyStart)
}

private fun stableTextHash(value: String): String {
    var hash = 0x811c9dc5L
    for (char in value) {
        hash = (hash xor char.code.toLong()) and 0xffffffffL
        hash = (hash * 0x01000193L) and 0xffffffffL
    }
    return java.lang.Long.toString(hash, 36)
}

private fun KotlinPsiManifestSlice.toJson(): String = buildKotlinPsiJsonObject {
    field("id", id)
    field("filePath", filePath)
    field("kind", kind)
    field("name", name)
    field("exportName", exportName)
    field("isDefaultExport", isDefaultExport)
    rawField("range", range.toJson())
    field("source", source)
    rawField("symbols", symbols.toJson())
    rawField("preview", preview.toJson())
    rawField("hashes", hashes.toJson())
    rawField("safety", safety.toJson())
}

private fun KotlinPsiManifestHeader.toJson(): String = buildKotlinPsiJsonObject {
    field("id", id)
    field("filePath", filePath)
    field("kind", kind)
    rawField("range", range.toJson())
    field("source", source)
    field("importBindings", importBindings) { it.toJson() }
}

private fun KotlinPsiManifestEffect.toJson(): String = buildKotlinPsiJsonObject {
    field("id", id)
    field("filePath", filePath)
    field("kind", kind)
    rawField("range", range.toJson())
    field("source", source)
    rawField("hashes", hashes.toJson())
    rawField("safety", safety.toJson())
}

private fun KotlinPsiImportBinding.toJson(): String = buildKotlinPsiJsonObject {
    field("local", local)
    field("imported", imported)
    field("source", source)
    field("kind", kind)
    field("isTypeOnly", isTypeOnly)
}

private fun KotlinPsiDiagnostic.toJson(): String = buildKotlinPsiJsonObject {
    field("code", code)
    field("severity", severity)
    field("message", message)
}

private fun KotlinPsiManifestSymbol.toJson(): String = buildKotlinPsiJsonObject {
    field("defines", defines)
    field("references", references)
    field("typeReferences", typeReferences)
    field("jsxReferences", jsxReferences)
}

private fun KotlinPsiManifestPreview.toJson(): String = buildKotlinPsiJsonObject {
    field("previewable", previewable)
    reason?.let { field("reason", it) }
}

private fun KotlinPsiManifestHashes.toJson(): String = buildKotlinPsiJsonObject {
    field("bodyHash", bodyHash)
    field("signatureHash", signatureHash)
    typeHash?.let { field("typeHash", it) }
}

private fun KotlinPsiManifestSafety.toJson(): String = buildKotlinPsiJsonObject {
    field("hasTopLevelSideEffect", hasTopLevelSideEffect)
    field("hasDynamicImport", hasDynamicImport)
    field("hasUnknownGlobal", hasUnknownGlobal)
    field("fallbackRequired", fallbackRequired)
}

private fun PieceSourceRange.toJson(): String = buildKotlinPsiJsonObject {
    field("startByte", startByte)
    field("endByte", endByte)
    field("startLine", startLine)
    field("endLine", endLine)
}

private class KotlinPsiJsonObjectBuilder {
    private val fields = mutableListOf<String>()

    fun field(name: String, value: String) {
        fields += "${name.kotlinPsiJsonString()}:${value.kotlinPsiJsonString()}"
    }

    fun field(name: String, value: Number) {
        fields += "${name.kotlinPsiJsonString()}:$value"
    }

    fun field(name: String, value: Boolean) {
        fields += "${name.kotlinPsiJsonString()}:$value"
    }

    fun rawField(name: String, jsonObject: String) {
        fields += "${name.kotlinPsiJsonString()}:$jsonObject"
    }

    fun field(name: String, values: List<String>) {
        fields += "${name.kotlinPsiJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { it.kotlinPsiJsonString() }}"
    }

    fun <T> field(name: String, values: List<T>, encode: (T) -> String) {
        fields += "${name.kotlinPsiJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { encode(it) }}"
    }

    fun build(): String = fields.joinToString(prefix = "{", postfix = "}")
}

private fun buildKotlinPsiJsonObject(init: KotlinPsiJsonObjectBuilder.() -> Unit): String {
    return KotlinPsiJsonObjectBuilder().apply(init).build()
}

private fun String.kotlinPsiJsonString(): String {
    val builder = StringBuilder(length + 2)
    builder.append('"')
    for (char in this) {
        when (char) {
            '\\' -> builder.append("\\\\")
            '"' -> builder.append("\\\"")
            '\b' -> builder.append("\\b")
            '\u000C' -> builder.append("\\f")
            '\n' -> builder.append("\\n")
            '\r' -> builder.append("\\r")
            '\t' -> builder.append("\\t")
            else -> {
                if (char.code < 0x20) {
                    builder.append("\\u")
                    builder.append(char.code.toString(16).padStart(4, '0'))
                } else {
                    builder.append(char)
                }
            }
        }
    }
    builder.append('"')
    return builder.toString()
}
