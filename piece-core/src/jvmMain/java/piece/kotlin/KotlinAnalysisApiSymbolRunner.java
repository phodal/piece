package piece.kotlin;

import java.io.File;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.jar.JarFile;

/**
 * Isolated JVM runner for the opt-in Kotlin Analysis API prototype.
 *
 * <p>The main backend is compiled against kotlin-compiler-embeddable, while Analysis API standalone
 * expects the unshaded Kotlin compiler and IntelliJ classes. This runner intentionally uses
 * reflection so the default build does not need Analysis API on the compile classpath.
 */
public final class KotlinAnalysisApiSymbolRunner {
    private KotlinAnalysisApiSymbolRunner() {
    }

    public static void main(String[] args) {
        try {
            if (args.length == 0 || args.length % 2 != 0) {
                throw new IllegalArgumentException("Usage: KotlinAnalysisApiSymbolRunner <physical-source> <virtual-source> [physical-source virtual-source...]");
            }
            new Runner(args).run();
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            System.exit(1);
        }
    }

    private static final class Runner {
        private final List<SourceInput> sources = new ArrayList<>();
        private final List<String> classpathEntries = new ArrayList<>();
        private final List<String> identityClasspathEntries = new ArrayList<>();
        private final Map<String, String> virtualPathByPhysicalPath = new LinkedHashMap<>();
        private final Class<?> compilerConfigurationClass;
        private final Class<?> compilerConfigurationKeyClass;
        private final Class<?> function1Class;
        private final Class<?> disposableClass;
        private final Class<?> psiElementClass;
        private final Class<?> psiFileClass;
        private final Class<?> virtualFileClass;
        private final Class<?> ktElementClass;
        private final Class<?> ktFileClass;
        private final Class<?> ktDeclarationClass;
        private final Class<?> ktNameReferenceExpressionClass;
        private final Class<?> ktTypeReferenceClass;
        private final Class<?> kaSessionClass;
        private final Class<?> kaSymbolClass;
        private final Class<?> kaClassLikeSymbolClass;
        private final Class<?> kaConstructorSymbolClass;
        private final Class<?> kaCallableSymbolClass;
        private final Class<?> kaSymbolBasedReferenceClass;
        private final Class<?> psiTreeUtilClass;

        Runner(String[] args) throws ClassNotFoundException {
            List<String> sourcePaths = new ArrayList<>();
            int mode = 0;
            for (String arg : args) {
                if ("--classpath".equals(arg)) {
                    mode = 1;
                    continue;
                }
                if ("--identity-classpath".equals(arg)) {
                    mode = 2;
                    continue;
                }
                if (mode == 1) {
                    classpathEntries.add(arg);
                } else if (mode == 2) {
                    identityClasspathEntries.add(arg);
                } else {
                    sourcePaths.add(arg);
                }
            }
            if (sourcePaths.isEmpty() || sourcePaths.size() % 2 != 0) {
                throw new IllegalArgumentException("Usage: KotlinAnalysisApiSymbolRunner <physical-source> <virtual-source> [physical-source virtual-source...] [--classpath <jar-or-directory>...]");
            }
            for (int i = 0; i < sourcePaths.size(); i += 2) {
                SourceInput source = new SourceInput(sourcePaths.get(i), sourcePaths.get(i + 1));
                sources.add(source);
                virtualPathByPhysicalPath.put(normalizePath(source.physicalPath), source.virtualPath);
            }
            compilerConfigurationClass = cls("org.jetbrains.kotlin.config.CompilerConfiguration");
            compilerConfigurationKeyClass = cls("org.jetbrains.kotlin.config.CompilerConfigurationKey");
            function1Class = cls("kotlin.jvm.functions.Function1");
            disposableClass = cls("com.intellij.openapi.Disposable");
            psiElementClass = cls("com.intellij.psi.PsiElement");
            psiFileClass = cls("com.intellij.psi.PsiFile");
            virtualFileClass = cls("com.intellij.openapi.vfs.VirtualFile");
            ktElementClass = cls("org.jetbrains.kotlin.psi.KtElement");
            ktFileClass = cls("org.jetbrains.kotlin.psi.KtFile");
            ktDeclarationClass = cls("org.jetbrains.kotlin.psi.KtDeclaration");
            ktNameReferenceExpressionClass = cls("org.jetbrains.kotlin.psi.KtNameReferenceExpression");
            ktTypeReferenceClass = cls("org.jetbrains.kotlin.psi.KtTypeReference");
            kaSessionClass = cls("org.jetbrains.kotlin.analysis.api.KaSession");
            kaSymbolClass = cls("org.jetbrains.kotlin.analysis.api.symbols.KaSymbol");
            kaClassLikeSymbolClass = cls("org.jetbrains.kotlin.analysis.api.symbols.KaClassLikeSymbol");
            kaConstructorSymbolClass = cls("org.jetbrains.kotlin.analysis.api.symbols.KaConstructorSymbol");
            kaCallableSymbolClass = cls("org.jetbrains.kotlin.analysis.api.symbols.KaCallableSymbol");
            kaSymbolBasedReferenceClass = cls("org.jetbrains.kotlin.analysis.api.resolution.KaSymbolBasedReference");
            psiTreeUtilClass = cls("com.intellij.psi.util.PsiTreeUtil");
        }

        void run() throws Exception {
            Object config = compilerConfigurationClass.getConstructor().newInstance();
            Object moduleNameKey = cls("org.jetbrains.kotlin.config.CommonConfigurationKeys")
                .getField("MODULE_NAME")
                .get(null);
            compilerConfigurationClass
                .getMethod("put", compilerConfigurationKeyClass, Object.class)
                .invoke(config, moduleNameKey, "piece-analysis-api-prototype");
            Method addSourceRoot = cls("org.jetbrains.kotlin.cli.common.config.ContentRootsKt")
                .getMethod("addKotlinSourceRoot", compilerConfigurationClass, String.class);
            for (SourceInput source : sources) {
                addSourceRoot.invoke(null, config, source.physicalPath);
            }
            Method addJvmClasspathRoot = cls("org.jetbrains.kotlin.cli.jvm.config.JvmContentRootsKt")
                .getMethod("addJvmClasspathRoot", compilerConfigurationClass, File.class);
            for (String classpathEntry : classpathEntries) {
                File file = new File(classpathEntry);
                if (file.exists()) {
                    addJvmClasspathRoot.invoke(null, config, file);
                }
            }

            Object disposable = cls("com.intellij.openapi.util.Disposer")
                .getMethod("newDisposable")
                .invoke(null);
            try {
                Object session = buildSession(config, disposable);
                Object ktFile = findPrimaryKtFile(session, Path.of(sources.get(0).physicalPath).getFileName().toString());
                emitSymbols(ktFile);
            } finally {
                cls("com.intellij.openapi.util.Disposer")
                    .getMethod("dispose", disposableClass)
                    .invoke(null, disposable);
            }
        }

        private Object buildSession(Object config, Object disposable) throws Exception {
            Object unit = cls("kotlin.Unit").getField("INSTANCE").get(null);
            Object builderLambda = Proxy.newProxyInstance(
                function1Class.getClassLoader(),
                new Class<?>[] { function1Class },
                (proxy, method, args) -> {
                    if ("invoke".equals(method.getName())) {
                        args[0].getClass()
                            .getMethod("buildKtModuleProviderByCompilerConfiguration", compilerConfigurationClass)
                            .invoke(args[0], config);
                        return unit;
                    }
                    if ("toString".equals(method.getName())) {
                        return "piece-analysis-api-session-builder";
                    }
                    if ("hashCode".equals(method.getName())) {
                        return System.identityHashCode(proxy);
                    }
                    if ("equals".equals(method.getName())) {
                        return proxy == args[0];
                    }
                    return null;
                }
            );
            return cls("org.jetbrains.kotlin.analysis.api.standalone.StandaloneAnalysisAPISessionBuilderKt")
                .getMethod("buildStandaloneAnalysisAPISession", disposableClass, boolean.class, function1Class)
                .invoke(null, disposable, false, builderLambda);
        }

        private Object findPrimaryKtFile(Object session, String primaryFileName) throws Exception {
            Map<?, ?> modulesWithFiles = (Map<?, ?>) session.getClass()
                .getMethod("getModulesWithFiles")
                .invoke(session);
            Object fallback = null;
            for (Object filesObject : modulesWithFiles.values()) {
                for (Object file : (List<?>) filesObject) {
                    if (fallback == null && ktFileClass.isInstance(file)) {
                        fallback = file;
                    }
                    Object name = file.getClass().getMethod("getName").invoke(file);
                    if (primaryFileName.equals(name)) {
                        return file;
                    }
                }
            }
            if (fallback != null) {
                return fallback;
            }
            throw new IllegalStateException("Analysis API session did not return a Kotlin source file.");
        }

        private void emitSymbols(Object ktFile) throws Exception {
            List<?> declarations = (List<?>) ktFileClass.getMethod("getDeclarations").invoke(ktFile);
            for (Object declaration : declarations) {
                String declarationName = nameOfDeclaration(declaration);
                if (declarationName == null || declarationName.isBlank()) {
                    continue;
                }
                SymbolBuckets symbols = collectDeclarationSymbols(declaration, declarationName, sourcePathOfKtFile(ktFile));
                System.out.println(
                    "DECL\t" + declarationName +
                        "\t" + join(symbols.runtimeReferences) +
                        "\t" + join(symbols.typeReferences) +
                        "\t" + join(symbols.resolvedRuntimeNames) +
                        "\t" + join(symbols.resolvedTypeNames)
                );
                for (ExternalBinding binding : symbols.externalBindings) {
                    System.out.println(
                        "BIND\t" + declarationName +
                            "\t" + binding.local +
                            "\t" + binding.imported +
                            "\t" + binding.source +
                            "\t" + binding.kind +
                            "\t" + binding.typeOnly
                    );
                }
            }
        }

        private SymbolBuckets collectDeclarationSymbols(
            Object declaration,
            String declarationName,
            String primarySourcePath
        ) throws Exception {
            SymbolBuckets buckets = new SymbolBuckets();
            Collection<?> references = (Collection<?>) psiTreeUtilClass
                .getMethod("findChildrenOfType", psiElementClass, Class.class)
                .invoke(null, declaration, ktNameReferenceExpressionClass);
            for (Object reference : references) {
                String referencedName = (String) ktNameReferenceExpressionClass
                    .getMethod("getReferencedName")
                    .invoke(reference);
                boolean typeReference = isInsideTypeReference(reference);
                ReferenceResolution resolution = resolveReference(reference);
                if (resolution.resolved) {
                    if (typeReference) {
                        buckets.resolvedTypeNames.add(referencedName);
                    } else {
                        buckets.resolvedRuntimeNames.add(referencedName);
                    }
                }
                for (SymbolIdentity symbol : resolution.symbols) {
                    if (symbol.source.equals(primarySourcePath) && declarationName.equals(symbol.name)) {
                        continue;
                    }
                    if (!symbol.source.equals(primarySourcePath)) {
                        buckets.externalBindings.add(new ExternalBinding(
                            referencedName,
                            symbol.name,
                            symbol.source,
                            symbol.kind,
                            false
                        ));
                    } else {
                        if (typeReference) {
                            buckets.typeReferences.add(symbol.name);
                        } else {
                            buckets.runtimeReferences.add(symbol.name);
                        }
                    }
                }
            }
            return buckets;
        }

        private ReferenceResolution resolveReference(Object reference) throws Exception {
            Object lambda = Proxy.newProxyInstance(
                function1Class.getClassLoader(),
                new Class<?>[] { function1Class },
                (proxy, method, args) -> {
                    if (!"invoke".equals(method.getName())) {
                        return null;
                    }
                    Object kaSession = args[0];
                    ReferenceResolution resolution = new ReferenceResolution();
                    Object[] psiReferences = (Object[]) reference.getClass()
                        .getMethod("getReferences")
                        .invoke(reference);
                    for (Object psiReference : psiReferences) {
                        if (!kaSymbolBasedReferenceClass.isInstance(psiReference)) {
                            continue;
                        }
                        Collection<?> symbols = (Collection<?>) kaSymbolBasedReferenceClass
                            .getMethod("resolveToSymbols", kaSessionClass)
                            .invoke(psiReference, kaSession);
                        if (!symbols.isEmpty()) {
                            resolution.resolved = true;
                        }
                        for (Object symbol : symbols) {
                            Object psi = kaSymbolClass.getMethod("getPsi").invoke(symbol);
                            SymbolIdentity symbolIdentity = symbolIdentity(symbol, psi);
                            if (symbolIdentity != null) {
                                resolution.symbols.add(symbolIdentity);
                            }
                        }
                    }
                    return resolution;
                }
            );
            return (ReferenceResolution) cls("org.jetbrains.kotlin.analysis.api.AnalyzeKt")
                .getMethod("analyze", ktElementClass, function1Class)
                .invoke(null, reference, lambda);
        }

        private SymbolIdentity symbolIdentity(Object symbol, Object psi) throws Exception {
            TopLevelSymbol topLevelSymbol = topLevelDeclaration(psi);
            if (topLevelSymbol != null) {
                return new SymbolIdentity(topLevelSymbol.name, topLevelSymbol.source, "named");
            }
            if (kaClassLikeSymbolClass.isInstance(symbol)) {
                Object classId = kaClassLikeSymbolClass.getMethod("getClassId").invoke(symbol);
                if (classId == null) {
                    return null;
                }
                String packageName = classId.getClass().getMethod("getPackageFqName").invoke(classId).toString();
                if (isImplicitRuntimePackage(packageName)) {
                    return null;
                }
                Object shortClassName = classId.getClass().getMethod("getShortClassName").invoke(classId);
                return new SymbolIdentity(
                    nameString(shortClassName),
                    classpathSource(psi, packageName),
                    "named"
                );
            }
            if (kaConstructorSymbolClass.isInstance(symbol)) {
                Object classId = kaConstructorSymbolClass.getMethod("getContainingClassId").invoke(symbol);
                return classLikeIdentity(classId, psi);
            }
            if (kaCallableSymbolClass.isInstance(symbol)) {
                Object callableId = kaCallableSymbolClass.getMethod("getCallableId").invoke(symbol);
                if (callableId == null) {
                    return null;
                }
                String packageName = callableId.getClass().getMethod("getPackageName").invoke(callableId).toString();
                if (isImplicitRuntimePackage(packageName)) {
                    return null;
                }
                Object className = callableId.getClass().getMethod("getClassName").invoke(callableId);
                Object callableName = callableId.getClass().getMethod("getCallableName").invoke(callableId);
                if (callableName == null) {
                    return null;
                }
                if (className != null && !className.toString().isBlank()) {
                    return new SymbolIdentity(
                        nameString(callableName),
                        classMemberSource(psi, packageName, className.toString()),
                        "named"
                    );
                }
                return new SymbolIdentity(
                    nameString(callableName),
                    classpathSource(psi, packageName),
                    "named"
                );
            }
            return null;
        }

        private SymbolIdentity classLikeIdentity(Object classId, Object psi) throws Exception {
            if (classId == null) {
                return null;
            }
            String packageName = classId.getClass().getMethod("getPackageFqName").invoke(classId).toString();
            if (isImplicitRuntimePackage(packageName)) {
                return null;
            }
            Object shortClassName = classId.getClass().getMethod("getShortClassName").invoke(classId);
            String sourcePath = mappedSourcePathOfPsi(psi);
            return new SymbolIdentity(
                nameString(shortClassName),
                sourcePath == null ? classpathSource(psi, packageName) : sourcePath,
                "named"
            );
        }

        private boolean isInsideTypeReference(Object reference) throws Exception {
            Object parent = psiTreeUtilClass
                .getMethod("getParentOfType", psiElementClass, Class.class, boolean.class)
                .invoke(null, reference, ktTypeReferenceClass, false);
            return parent != null;
        }

        private TopLevelSymbol topLevelDeclaration(Object psi) throws Exception {
            Object current = psi;
            while (current != null) {
                Object parent = psiElementClass.getMethod("getParent").invoke(current);
                if (ktDeclarationClass.isInstance(current)) {
                    if (parent == null || !ktFileClass.isInstance(parent)) {
                        return null;
                    }
                    String name = nameOfDeclaration(current);
                    if (name == null) {
                        return null;
                    }
                    return new TopLevelSymbol(name, sourcePathOfKtFile(parent));
                }
                if (parent != null && ktFileClass.isInstance(parent)) {
                    return null;
                }
                current = parent;
            }
            return null;
        }

        private String sourcePathOfKtFile(Object ktFile) throws Exception {
            Object virtualFilePath = ktFileClass.getMethod("getVirtualFilePath").invoke(ktFile);
            String physicalPath = normalizePath(virtualFilePath.toString());
            return virtualPathByPhysicalPath.getOrDefault(physicalPath, physicalPath);
        }

        private String nameOfDeclaration(Object declaration) throws Exception {
            Object name = ktDeclarationClass.getMethod("getName").invoke(declaration);
            return name == null ? null : name.toString();
        }

        private String classpathSource(Object psi, String packageName) throws Exception {
            String virtualPath = psiVirtualPath(psi);
            String ownerPath = packageName.isBlank() ? "" : packageName.replace('.', '/');
            String classpathArtifact = classpathArtifactPath(virtualPath, ownerPath);
            if (classpathArtifact != null) {
                return "classpath:" + classpathArtifact + (ownerPath.isBlank() ? "" : "!" + ownerPath);
            }
            return "classpath:" + (packageName.isBlank() ? "<unknown>" : packageName);
        }

        private String classMemberSource(Object psi, String packageName, String className) throws Exception {
            String ownerName = className.replace('.', '/');
            String base = mappedSourcePathOfPsi(psi);
            if (base == null) {
                base = classpathSource(psi, packageName);
            }
            if (ownerName.isBlank()) {
                return base;
            }
            return base + "/" + ownerName;
        }

        private String mappedSourcePathOfPsi(Object psi) throws Exception {
            String virtualPath = psiVirtualPath(psi);
            if (virtualPath == null || virtualPath.isBlank()) {
                return null;
            }
            return virtualPathByPhysicalPath.get(normalizePath(virtualPath));
        }

        private String psiVirtualPath(Object psi) throws Exception {
            if (psi == null || !psiElementClass.isInstance(psi)) {
                return null;
            }
            Object psiFile = psiElementClass.getMethod("getContainingFile").invoke(psi);
            if (psiFile == null) {
                return null;
            }
            Object virtualFile = psiFileClass.getMethod("getVirtualFile").invoke(psiFile);
            if (virtualFile == null) {
                return null;
            }
            Object path = virtualFileClass.getMethod("getPath").invoke(virtualFile);
            return path == null ? null : path.toString();
        }

        private String classpathArtifactPath(String virtualPath, String ownerPath) {
            if (virtualPath != null && !virtualPath.isBlank()) {
                String path = virtualPath;
                if (path.startsWith("jar://")) {
                    path = path.substring("jar://".length());
                } else if (path.startsWith("file://")) {
                    path = path.substring("file://".length());
                }
                int jarIndex = path.indexOf(".jar!");
                if (jarIndex >= 0) {
                    return normalizePath(path.substring(0, jarIndex + ".jar".length()));
                }
                if (path.endsWith(".jar")) {
                    return normalizePath(path);
                }
                String normalizedPath = normalizePath(path);
                for (String classpathEntry : classpathEntries) {
                    String normalizedEntry = normalizePath(classpathEntry);
                    File entry = new File(normalizedEntry);
                    if (entry.isDirectory() && normalizedPath.startsWith(normalizedEntry + File.separator)) {
                        return normalizedEntry;
                    }
                }
            }
            if (ownerPath == null || ownerPath.isBlank()) {
                return null;
            }
            for (String classpathEntry : identityClasspathEntries) {
                String normalizedEntry = normalizePath(classpathEntry);
                File entry = new File(normalizedEntry);
                if (entry.isFile() && entry.getName().endsWith(".jar") && jarContainsPackage(entry, ownerPath)) {
                    return normalizedEntry;
                }
                if (entry.isDirectory() && new File(entry, ownerPath).exists()) {
                    return normalizedEntry;
                }
            }
            return null;
        }

        private static boolean jarContainsPackage(File jarFile, String ownerPath) {
            try (JarFile jar = new JarFile(jarFile)) {
                return jar.stream().anyMatch(entry ->
                    !entry.isDirectory() && entry.getName().startsWith(ownerPath + "/")
                );
            } catch (Exception ignored) {
                return false;
            }
        }

        private static String nameString(Object name) throws Exception {
            Object value = name.getClass().getMethod("asString").invoke(name);
            return value == null ? name.toString() : value.toString();
        }

        private static boolean isImplicitRuntimePackage(String packageName) {
            return packageName.equals("kotlin") ||
                packageName.startsWith("kotlin.") ||
                packageName.equals("java.lang");
        }

        private static Class<?> cls(String name) throws ClassNotFoundException {
            return Class.forName(name);
        }

        private static String join(TreeSet<String> values) {
            return String.join(",", values);
        }

        private static String normalizePath(String path) {
            return Paths.get(path).toAbsolutePath().normalize().toString();
        }
    }

    private static final class SymbolBuckets {
        final TreeSet<String> runtimeReferences = new TreeSet<>();
        final TreeSet<String> typeReferences = new TreeSet<>();
        final TreeSet<String> resolvedRuntimeNames = new TreeSet<>();
        final TreeSet<String> resolvedTypeNames = new TreeSet<>();
        final TreeSet<ExternalBinding> externalBindings = new TreeSet<>();
    }

    private static final class ReferenceResolution {
        boolean resolved = false;
        final List<SymbolIdentity> symbols = new ArrayList<>();
    }

    private record SourceInput(String physicalPath, String virtualPath) {
    }

    private record TopLevelSymbol(String name, String source) {
    }

    private record SymbolIdentity(String name, String source, String kind) {
    }

    private record ExternalBinding(String local, String imported, String source, String kind, boolean typeOnly)
        implements Comparable<ExternalBinding> {
        @Override
        public int compareTo(ExternalBinding other) {
            int sourceCompare = source.compareTo(other.source);
            if (sourceCompare != 0) return sourceCompare;
            int importedCompare = imported.compareTo(other.imported);
            if (importedCompare != 0) return importedCompare;
            int localCompare = local.compareTo(other.local);
            if (localCompare != 0) return localCompare;
            return Boolean.compare(typeOnly, other.typeOnly);
        }
    }
}
