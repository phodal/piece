@file:Suppress("DEPRECATION")

package piece.kotlin

import org.jetbrains.kotlin.cli.common.config.addKotlinSourceRoot
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.CliBindingTrace
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.cli.jvm.compiler.TopDownAnalyzerFacadeForJVM
import org.jetbrains.kotlin.cli.jvm.config.addJvmClasspathRoot
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.ModuleDescriptor
import org.jetbrains.kotlin.descriptors.PackageFragmentDescriptor
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.psiUtil.collectDescendantsOfType
import org.jetbrains.kotlin.resolve.BindingContext
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.ExperimentalPathApi
import kotlin.io.path.createDirectories
import kotlin.io.path.deleteRecursively
import kotlin.io.path.writeText

data class KotlinBindingSymbolRequest(
    val filePath: String,
    val source: String,
    val classpath: List<String> = defaultKotlinSemanticClasspath(),
)

data class KotlinBindingSymbolResult(
    val symbolsByDeclaration: Map<String, KotlinSemanticSymbols>,
    val diagnostics: List<KotlinPsiDiagnostic> = emptyList(),
)

data class KotlinSemanticSymbols(
    val runtimeReferences: List<String> = emptyList(),
    val typeReferences: List<String> = emptyList(),
    val resolvedRuntimeNames: List<String> = emptyList(),
    val resolvedTypeNames: List<String> = emptyList(),
)

internal class KotlinBindingSymbolBackend {
    fun symbols(request: KotlinBindingSymbolRequest): KotlinBindingSymbolResult {
        val workspace = Files.createTempDirectory("piece-kotlin-binding-")
        val disposable = Disposer.newDisposable()
        return try {
            val sourceName = request.filePath.replace('\\', '/').substringAfterLast('/').ifBlank { "Main.kt" }
            val sourceFile = workspace.resolve(sourceName)
            workspace.createDirectories()
            sourceFile.writeText(request.source)

            val configuration = CompilerConfiguration().apply {
                put(CommonConfigurationKeys.MODULE_NAME, "piece-semantic-symbols")
                put(CommonConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
                addKotlinSourceRoot(sourceFile.toString())
                request.classpath
                    .filter { it.isNotBlank() }
                    .map(::File)
                    .filter { it.exists() }
                    .forEach(::addJvmClasspathRoot)
            }
            // FE10 BindingContext is a pinned Kotlin 2.2 fallback until a standalone Analysis API artifact is available.
            val environment = KotlinCoreEnvironment.createForProduction(
                disposable,
                configuration,
                EnvironmentConfigFiles.JVM_CONFIG_FILES,
            )
            val sourceFiles = environment.getSourceFiles()
            val sourceKtFile = sourceFiles.firstOrNull {
                it.virtualFilePath == sourceFile.toAbsolutePath().normalize().toString()
            } ?: sourceFiles.firstOrNull()
                ?: return KotlinBindingSymbolResult(emptyMap())
            val analysis = TopDownAnalyzerFacadeForJVM.analyzeFilesWithJavaIntegration(
                project = environment.project,
                files = sourceFiles,
                trace = CliBindingTrace(environment.project),
                configuration = configuration,
                packagePartProvider = { scope -> environment.createPackagePartProvider(scope) },
            )
            val bindingContext = analysis.bindingContext
            val descriptorToDeclaration = sourceKtFile.declarations
                .mapNotNull { declaration ->
                    val name = declaration.name ?: return@mapNotNull null
                    val descriptor = bindingContext.get(BindingContext.DECLARATION_TO_DESCRIPTOR, declaration)?.topLevelOriginal()
                        ?: return@mapNotNull null
                    descriptor to name
                }
                .toMap()

            val symbolsByDeclaration = sourceKtFile.declarations
                .mapNotNull { declaration ->
                    val name = declaration.name ?: return@mapNotNull null
                    name to declaration.collectSemanticSymbols(bindingContext, descriptorToDeclaration)
                }
                .toMap()
            KotlinBindingSymbolResult(symbolsByDeclaration)
        } catch (error: Throwable) {
            KotlinBindingSymbolResult(
                symbolsByDeclaration = emptyMap(),
                diagnostics = listOf(
                    KotlinPsiDiagnostic(
                        code = "kotlin-binding-symbol-analysis-error",
                        severity = "warning",
                        message = error.message ?: error::class.java.name,
                        path = request.filePath,
                    ),
                ),
            )
        } finally {
            Disposer.dispose(disposable)
            workspace.deleteRecursivelyIfExists()
        }
    }
}

private fun KtDeclaration.collectSemanticSymbols(
    bindingContext: BindingContext,
    descriptorToDeclaration: Map<DeclarationDescriptor, String>,
): KotlinSemanticSymbols {
    val runtimeReferences = linkedSetOf<String>()
    val typeReferences = linkedSetOf<String>()
    val resolvedRuntimeNames = linkedSetOf<String>()
    val resolvedTypeNames = linkedSetOf<String>()

    for (reference in collectDescendantsOfType<KtNameReferenceExpression>()) {
        val referencedName = reference.getReferencedName()
        val isTypeReference = reference.isInsideTypeReference()
        val resolvedDescriptor = reference.resolveTargetDescriptor(bindingContext)?.topLevelOriginal()
        if (resolvedDescriptor != null) {
            if (isTypeReference) {
                resolvedTypeNames += referencedName
            } else {
                resolvedRuntimeNames += referencedName
            }
        }
        val localDeclaration = resolvedDescriptor?.let(descriptorToDeclaration::get)
        if (localDeclaration != null && localDeclaration != name) {
            if (isTypeReference) {
                typeReferences += localDeclaration
            } else {
                runtimeReferences += localDeclaration
            }
        }
    }

    return KotlinSemanticSymbols(
        runtimeReferences = runtimeReferences.sorted(),
        typeReferences = typeReferences.sorted(),
        resolvedRuntimeNames = resolvedRuntimeNames.sorted(),
        resolvedTypeNames = resolvedTypeNames.sorted(),
    )
}

private fun KtNameReferenceExpression.resolveTargetDescriptor(bindingContext: BindingContext): DeclarationDescriptor? {
    bindingContext.get(BindingContext.REFERENCE_TARGET, this)?.let { return it }
    val callExpression = parent as? KtCallExpression ?: parent?.parent as? KtCallExpression ?: return null
    if (callExpression.calleeExpression != this) return null
    bindingContext.get(BindingContext.REFERENCE_TARGET, callExpression)?.let { return it }
    val call = bindingContext.get(BindingContext.CALL, callExpression)
        ?: bindingContext.get(BindingContext.CALL, this)
        ?: return null
    return bindingContext.get(BindingContext.RESOLVED_CALL, call)?.resultingDescriptor
}

private fun KtNameReferenceExpression.isInsideTypeReference(): Boolean {
    return PsiTreeUtil.getParentOfType(this, KtTypeReference::class.java, false) != null
}

private fun DeclarationDescriptor.topLevelOriginal(): DeclarationDescriptor {
    var current = original
    while (true) {
        val parent = current.containingDeclaration?.original ?: return current
        if (parent is PackageFragmentDescriptor || parent is ModuleDescriptor) {
            return current
        }
        current = parent
    }
}

@OptIn(ExperimentalPathApi::class)
private fun Path.deleteRecursivelyIfExists() {
    if (Files.exists(this)) {
        deleteRecursively()
    }
}
