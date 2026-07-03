import { createPieceInlinePreviewModule, createPieceVirtualFileSystemPlugin } from "./virtual-modules.js";

function outputText(outputFile) {
  if (typeof outputFile.text === "string") {
    return outputFile.text;
  }
  if (outputFile.contents) {
    return new TextDecoder().decode(outputFile.contents);
  }
  return "";
}

export async function buildPiecePreviewBundle({ buildEngine, virtualModules, target = "es2022", external = [], plugins = [], compileStrategy = "build" }) {
  if (!buildEngine || typeof buildEngine.build !== "function") {
    throw new TypeError("buildPiecePreviewBundle() requires an esbuild-compatible buildEngine.");
  }

  if (compileStrategy === "transform") {
    if (typeof buildEngine.transform !== "function") {
      throw new TypeError("buildPiecePreviewBundle() transform strategy requires a buildEngine.transform() function.");
    }
    const result = await buildEngine.transform(createPieceInlinePreviewModule(virtualModules), {
      loader: "tsx",
      format: "esm",
      target,
      sourcemap: "inline",
      jsx: "automatic"
    });
    const code = result.code ?? "";
    return {
      version: 1,
      buildEngine: buildEngine.name,
      compileStrategy,
      entryPath: virtualModules.entryPath,
      outputFiles: [
        {
          path: virtualModules.entryPath.replace(/\.tsx$/, ".js"),
          text: code,
          contents: new TextEncoder().encode(code)
        }
      ],
      code,
      metafile: undefined
    };
  }

  const result = await buildEngine.build({
    entryPoints: [virtualModules.entryPath],
    bundle: true,
    platform: "browser",
    format: "esm",
    target,
    write: false,
    sourcemap: "inline",
    metafile: true,
    legalComments: "none",
    external,
    plugins: [createPieceVirtualFileSystemPlugin(virtualModules.files), ...plugins]
  });
  const outputFiles = result.outputFiles ?? [];
  const scriptOutput = outputFiles.find((file) => !file.path.endsWith(".map") && !file.path.endsWith(".css"));

  return {
    version: 1,
    buildEngine: buildEngine.name,
    compileStrategy,
    entryPath: virtualModules.entryPath,
    outputFiles,
    code: scriptOutput ? outputText(scriptOutput) : "",
    metafile: result.metafile
  };
}
