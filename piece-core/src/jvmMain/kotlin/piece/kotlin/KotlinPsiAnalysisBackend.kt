package piece.kotlin

import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtImportDirective
import piece.extract.SourceFile
import piece.model.PieceSourceRange
import piece.model.PieceTargetKind

private const val DEFAULT_KOTLIN_PSI_PARSER_NAME = "kotlin-psi-declaration-extractor"

enum class KotlinAnalysisBackendKind(val wireName: String) {
    Psi("psi"),
    Fe10BindingContext("fe10-binding-context"),
    AnalysisApi("analysis-api");

    companion object {
        fun fromWireName(value: String): KotlinAnalysisBackendKind {
            return entries.firstOrNull { it.wireName == value }
                ?: throw IllegalArgumentException("Unsupported Kotlin analysis backend: $value")
        }
    }
}

data class KotlinAnalysisBackendMetadata(
    val requested: String,
    val actual: String,
    val declarations: String,
    val symbols: String,
    val diagnostics: String,
    val status: String,
    val fallbackReason: String? = null,
    val analysisApiEnabled: Boolean? = null,
    val analysisApiAvailable: Boolean? = null,
    val analysisApiVersion: String? = null,
)

data class KotlinPsiAnalysisRequest(
    val filePath: String,
    val source: String,
    val parserName: String = DEFAULT_KOTLIN_PSI_PARSER_NAME,
    val backend: KotlinAnalysisBackendKind? = null,
    val analysisApiEnabled: Boolean = false,
    val analysisApiVersion: String? = null,
    val semanticDiagnostics: Boolean = false,
    val semanticSymbols: Boolean = false,
    val companionFiles: List<KotlinPsiAnalysisSourceFile> = emptyList(),
    val classpath: List<String> = defaultKotlinSemanticClasspath(),
)

data class KotlinPsiAnalysisSourceFile(
    val filePath: String,
    val source: String,
)

data class KotlinPsiImportBinding(
    val local: String,
    val imported: String,
    val source: String,
    val kind: String,
    val isTypeOnly: Boolean = false,
    val signature: String? = null,
)

data class KotlinPsiDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
    val path: String? = null,
    val line: Int? = null,
    val column: Int? = null,
    val lineEnd: Int? = null,
    val columnEnd: Int? = null,
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
    val analysisBackend: KotlinAnalysisBackendMetadata,
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
        rawField("analysisBackend", analysisBackend.toJson())
    }
}

class KotlinPsiAnalysisBackend {
    fun analyze(request: KotlinPsiAnalysisRequest): KotlinPsiManifest {
        var backend = request.resolveBackend()
        val file = SourceFile(request.filePath, request.source)
        return withKtFile(file) { ktFile ->
            val declarations = ktFile.declarations.mapNotNull { declaration ->
                declaration.toPieceDeclaration(file)
            }
            val headers = ktFile.toHeaders(file)
            val localTargetNames = declarations.map { declaration -> declaration.name }.toSet()
            val semanticRequest = KotlinBindingSymbolRequest(
                filePath = request.filePath,
                source = request.source,
                companionFiles = request.companionFiles.map { companion ->
                    KotlinBindingSourceFile(
                        filePath = companion.filePath,
                        source = companion.source,
                    )
                },
                classpath = request.classpath,
            )
            val semanticResult = when (backend.symbols) {
                KotlinAnalysisBackendKind.Psi -> KotlinBindingSymbolResult(emptyMap())
                KotlinAnalysisBackendKind.Fe10BindingContext -> KotlinBindingSymbolBackend().symbols(semanticRequest)
                KotlinAnalysisBackendKind.AnalysisApi -> {
                    val analysisApiResult = KotlinAnalysisApiSymbolBackend().symbols(semanticRequest)
                    val failed = analysisApiResult.diagnostics.any { diagnostic ->
                        diagnostic.code == "kotlin-analysis-api-symbol-analysis-error"
                    }
                    if (failed) {
                        backend = backend.copy(
                            actual = KotlinAnalysisBackendKind.Fe10BindingContext,
                            symbols = KotlinAnalysisBackendKind.Fe10BindingContext,
                            fallbackReason = "Kotlin Analysis API runner did not return a usable report; using explicit FE10 BindingContext fallback.",
                        )
                        val fe10Result = KotlinBindingSymbolBackend().symbols(semanticRequest)
                        KotlinBindingSymbolResult(
                            symbolsByDeclaration = fe10Result.symbolsByDeclaration,
                            importBindings = fe10Result.importBindings,
                            diagnostics = analysisApiResult.diagnostics + fe10Result.diagnostics,
                        )
                    } else {
                        analysisApiResult
                    }
                }
            }
            val importBindings = headers.flatMap { it.importBindings } + semanticResult.importBindings
            val importLocals = importBindings.map { binding -> binding.local }.toSet()
            val slices = declarations.map { declaration ->
                declaration.toManifestSlice(
                    file = file,
                    semanticSymbols = semanticResult.symbolsByDeclaration[declaration.name],
                    localTargetNames = localTargetNames,
                    importLocals = importLocals,
                )
            }
            val effects = ktFile.toEffects(file, declarations, headers)
            val diagnostics = backend.diagnostics + semanticResult.diagnostics +
                if (request.semanticDiagnostics) {
                    KotlinCompilerDiagnosticBackend().diagnostics(
                        KotlinCompilerDiagnosticRequest(
                            filePath = request.filePath,
                            source = request.source,
                            companionFiles = request.companionFiles.map { companion ->
                                KotlinCompilerDiagnosticSourceFile(
                                    filePath = companion.filePath,
                                    source = companion.source,
                                )
                            },
                            classpath = request.classpath,
                        ),
                    )
                } else {
                    emptyList()
                }

            KotlinPsiManifest(
                filePath = request.filePath,
                source = request.source,
                parser = request.parserName.ifBlank { DEFAULT_KOTLIN_PSI_PARSER_NAME },
                slices = slices,
                headers = headers,
                effects = effects,
                importBindings = importBindings,
                hasTopLevelEffect = effects.isNotEmpty(),
                diagnostics = diagnostics,
                analysisBackend = backend.metadata(request.semanticDiagnostics),
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
        analysisBackend = request.resolveBackend().metadata(request.semanticDiagnostics),
    )
}

fun kotlinPsiGenerationBackendMetadata(
    requestedBackend: KotlinAnalysisBackendKind = KotlinAnalysisBackendKind.Psi,
    analysisApiEnabled: Boolean = false,
    analysisApiVersion: String? = null,
): KotlinAnalysisBackendMetadata {
    return if (requestedBackend == KotlinAnalysisBackendKind.Psi) {
        KotlinAnalysisBackendMetadata(
            requested = KotlinAnalysisBackendKind.Psi.wireName,
            actual = KotlinAnalysisBackendKind.Psi.wireName,
            declarations = KotlinAnalysisBackendKind.Psi.wireName,
            symbols = KotlinAnalysisBackendKind.Psi.wireName,
            diagnostics = "none",
            status = "ready",
            analysisApiEnabled = analysisApiEnabled.takeIf { requestedBackend == KotlinAnalysisBackendKind.AnalysisApi },
            analysisApiAvailable = null,
            analysisApiVersion = analysisApiVersion.takeIf { requestedBackend == KotlinAnalysisBackendKind.AnalysisApi },
        )
    } else {
        KotlinAnalysisBackendMetadata(
            requested = requestedBackend.wireName,
            actual = KotlinAnalysisBackendKind.Psi.wireName,
            declarations = KotlinAnalysisBackendKind.Psi.wireName,
            symbols = KotlinAnalysisBackendKind.Psi.wireName,
            diagnostics = "none",
            status = "fallback",
            fallbackReason = "Kotlin .pic generation currently uses PSI declaration extraction only.",
            analysisApiEnabled = analysisApiEnabled.takeIf { requestedBackend == KotlinAnalysisBackendKind.AnalysisApi },
            analysisApiAvailable = isKotlinAnalysisApiRuntimeAvailable().takeIf { requestedBackend == KotlinAnalysisBackendKind.AnalysisApi && analysisApiEnabled },
            analysisApiVersion = analysisApiVersion.takeIf { requestedBackend == KotlinAnalysisBackendKind.AnalysisApi },
        )
    }
}

private data class KotlinAnalysisBackendResolution(
    val requested: KotlinAnalysisBackendKind,
    val actual: KotlinAnalysisBackendKind,
    val symbols: KotlinAnalysisBackendKind,
    val fallbackReason: String? = null,
    val analysisApiEnabled: Boolean? = null,
    val analysisApiAvailable: Boolean? = null,
    val analysisApiVersion: String? = null,
) {
    val diagnostics: List<KotlinPsiDiagnostic>
        get() = fallbackReason?.let { reason ->
            listOf(
                KotlinPsiDiagnostic(
                    code = "kotlin-analysis-backend-fallback",
                    severity = "warning",
                    message = reason,
                ),
            )
        }.orEmpty()

    fun metadata(semanticDiagnostics: Boolean): KotlinAnalysisBackendMetadata {
        return KotlinAnalysisBackendMetadata(
            requested = requested.wireName,
            actual = actual.wireName,
            declarations = KotlinAnalysisBackendKind.Psi.wireName,
            symbols = symbols.wireName,
            diagnostics = if (semanticDiagnostics) "kotlin-compiler-diagnostics" else "none",
            status = if (fallbackReason == null) "ready" else "fallback",
            fallbackReason = fallbackReason,
            analysisApiEnabled = analysisApiEnabled,
            analysisApiAvailable = analysisApiAvailable,
            analysisApiVersion = analysisApiVersion,
        )
    }
}

private fun KotlinPsiAnalysisRequest.resolveBackend(): KotlinAnalysisBackendResolution {
    val requested = backend ?: if (semanticSymbols) {
        KotlinAnalysisBackendKind.Fe10BindingContext
    } else {
        KotlinAnalysisBackendKind.Psi
    }
    return when (requested) {
        KotlinAnalysisBackendKind.Psi -> KotlinAnalysisBackendResolution(
            requested = requested,
            actual = KotlinAnalysisBackendKind.Psi,
            symbols = KotlinAnalysisBackendKind.Psi,
        )

        KotlinAnalysisBackendKind.Fe10BindingContext -> KotlinAnalysisBackendResolution(
            requested = requested,
            actual = KotlinAnalysisBackendKind.Fe10BindingContext,
            symbols = KotlinAnalysisBackendKind.Fe10BindingContext,
        )

        KotlinAnalysisBackendKind.AnalysisApi -> {
            val available = isKotlinAnalysisApiRuntimeAvailable().takeIf { analysisApiEnabled }
            if (analysisApiEnabled && available == true) {
                KotlinAnalysisBackendResolution(
                    requested = requested,
                    actual = KotlinAnalysisBackendKind.AnalysisApi,
                    symbols = KotlinAnalysisBackendKind.AnalysisApi,
                    analysisApiEnabled = true,
                    analysisApiAvailable = true,
                    analysisApiVersion = analysisApiVersion,
                )
            } else {
                KotlinAnalysisBackendResolution(
                    requested = requested,
                    actual = KotlinAnalysisBackendKind.Fe10BindingContext,
                    symbols = KotlinAnalysisBackendKind.Fe10BindingContext,
                    fallbackReason = analysisApiFallbackReason(),
                    analysisApiEnabled = analysisApiEnabled,
                    analysisApiAvailable = available,
                    analysisApiVersion = analysisApiVersion,
                )
            }
        }
    }
}

private fun KotlinPsiAnalysisRequest.analysisApiFallbackReason(): String {
    if (!analysisApiEnabled) {
        return "Kotlin Analysis API Gradle gate is disabled; enable -PpieceAnalysisApi.enabled=true before using the analysis-api backend."
    }
    if (!isKotlinAnalysisApiRuntimeAvailable()) {
        return "Kotlin Analysis API Gradle gate is enabled, but Analysis API runtime classes were not found on the JVM backend classpath."
    }
    return "Kotlin Analysis API runtime is gated on, but the analysis-api backend implementation is not wired yet; using explicit FE10 BindingContext fallback."
}

private fun isKotlinAnalysisApiRuntimeAvailable(): Boolean {
    return runCatching {
        Class.forName("org.jetbrains.kotlin.analysis.api.KaSession")
        Class.forName("org.jetbrains.kotlin.analysis.api.standalone.StandaloneAnalysisAPISessionBuilderKt")
        Class.forName("com.intellij.openapi.Disposable")
        Class.forName("org.jetbrains.kotlin.cli.common.config.ContentRootsKt")
    }.isSuccess
}

private fun KotlinPieceDeclaration.toManifestSlice(
    file: SourceFile,
    semanticSymbols: KotlinSemanticSymbols? = null,
    localTargetNames: Set<String> = emptySet(),
    importLocals: Set<String> = emptySet(),
): KotlinPsiManifestSlice {
    val kindName = kind.name.lowercase()
    val sliceSource = file.source.substring(range.startByte, range.endByte)
    val mergedRuntimeReferences = mergeSemanticReferences(
        psiReferences = runtimeReferences,
        semanticReferences = semanticSymbols?.runtimeReferences,
        resolvedNames = semanticSymbols?.resolvedRuntimeNames.orEmpty(),
        localTargetNames = localTargetNames,
        importLocals = importLocals,
    )
    val mergedTypeReferences = mergeSemanticReferences(
        psiReferences = typeReferences,
        semanticReferences = semanticSymbols?.typeReferences,
        resolvedNames = semanticSymbols?.resolvedTypeNames.orEmpty(),
        localTargetNames = localTargetNames,
        importLocals = importLocals,
    )
    val typeReferenceSet = mergedTypeReferences.toSet()
    val references = (mergedRuntimeReferences + mergedTypeReferences).distinct().sorted()
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

private fun mergeSemanticReferences(
    psiReferences: List<String>,
    semanticReferences: List<String>?,
    resolvedNames: List<String>,
    localTargetNames: Set<String>,
    importLocals: Set<String>,
): List<String> {
    if (semanticReferences == null) return psiReferences
    val resolvedNameSet = resolvedNames.toSet()
    return (semanticReferences + psiReferences.filter { reference ->
        reference !in localTargetNames && (reference in importLocals || reference !in resolvedNameSet)
    })
        .distinct()
        .sorted()
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
    signature?.let { field("signature", it) }
}

private fun KotlinPsiDiagnostic.toJson(): String = buildKotlinPsiJsonObject {
    field("code", code)
    field("severity", severity)
    field("message", message)
    path?.let { field("path", it) }
    line?.let { field("line", it) }
    column?.let { field("column", it) }
    lineEnd?.let { field("lineEnd", it) }
    columnEnd?.let { field("columnEnd", it) }
}

private fun KotlinAnalysisBackendMetadata.toJson(): String = buildKotlinPsiJsonObject {
    field("requested", requested)
    field("actual", actual)
    field("declarations", declarations)
    field("symbols", symbols)
    field("diagnostics", diagnostics)
    field("status", status)
    fallbackReason?.let { field("fallbackReason", it) }
    analysisApiEnabled?.let { field("analysisApiEnabled", it) }
    analysisApiAvailable?.let { field("analysisApiAvailable", it) }
    analysisApiVersion?.let { field("analysisApiVersion", it) }
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
