import { sanitizeModulePart } from "./source-utils.js";

function uniqueBySource(headers) {
  const seen = new Set();
  const result = [];
  for (const header of headers) {
    if (!seen.has(header.source)) {
      seen.add(header.source);
      result.push(header.source.trim());
    }
  }
  return result.filter(Boolean);
}

function sliceMap(manifest) {
  return new Map(manifest.slices.map((slice) => [slice.id, slice]));
}

function orderedClosureSlices(manifest, closure) {
  const slices = sliceMap(manifest);
  const ids = new Set([...closure.typeSlices, ...closure.valueSlices, ...closure.runtimeSlices]);
  return [...ids]
    .map((id) => slices.get(id))
    .filter(Boolean)
    .sort((left, right) => left.range.startByte - right.range.startByte || left.id.localeCompare(right.id));
}

function ensureTargetExport(source, targetName) {
  if (!targetName || targetName === "default" || new RegExp(`\\bexport\\s+(?:function|class|const|let|var)\\s+${targetName}\\b`).test(source)) {
    return source;
  }
  if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${targetName}\\b`).test(source)) {
    return source;
  }
  return `${source.trimEnd()}\n\nexport { ${targetName} };\n`;
}

function previewRenderExpression(targetName, propsModulePath) {
  if (propsModulePath) {
    return `<${targetName} {...previewProps} />`;
  }
  return `<${targetName} />`;
}

export function createPieceVirtualModules({ manifest, closure, preview = {} }) {
  const filePart = sanitizeModulePart(manifest.filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, ""));
  const targetPart = sanitizeModulePart(closure.targetName);
  const closurePath = `/@closure/${filePart}.${targetPart}.tsx`;
  const entryPath = `/@preview/${filePart}.${targetPart}.entry.tsx`;
  const headers = uniqueBySource(manifest.headers);
  const closureSlices = orderedClosureSlices(manifest, closure);
  const closureSource =
    closure.fallbackMode === "whole-file"
      ? ensureTargetExport(manifest.source, closure.targetName)
      : ensureTargetExport([...headers, ...closureSlices.map((slice) => slice.source.trim())].filter(Boolean).join("\n\n"), closure.targetName);
  const propsModulePath = preview.propsModulePath;
  const entryImports = [
    'import * as React from "react";',
    'import { createRoot } from "react-dom/client";',
    `import { ${closure.targetName} } from ${JSON.stringify(closurePath)};`
  ];
  if (propsModulePath) {
    entryImports.push(`import { previewProps } from ${JSON.stringify(propsModulePath)};`);
  }
  const rootId = preview.rootElementId ?? "root";
  const entrySource = [
    ...entryImports,
    "",
    `createRoot(document.getElementById(${JSON.stringify(rootId)})).render(${previewRenderExpression(closure.targetName, propsModulePath)});`,
    ""
  ].join("\n");

  return {
    version: 1,
    entryPath,
    closurePath,
    files: {
      [closurePath]: closureSource,
      [entryPath]: entrySource,
      ...(preview.virtualFiles ?? {})
    }
  };
}

export function createPieceInlinePreviewModule(virtualModules) {
  const closureSource = virtualModules.files[virtualModules.closurePath] ?? "";
  const entrySource = virtualModules.files[virtualModules.entryPath] ?? "";
  const supportSources = Object.entries(virtualModules.files)
    .filter(([path]) => path !== virtualModules.closurePath && path !== virtualModules.entryPath)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source);
  const rewrittenEntry = entrySource
    .split("\n")
    .filter((line) => !line.includes(JSON.stringify(virtualModules.closurePath)))
    .filter((line) => !supportSources.some((source) => source.includes("previewProps")) || !line.includes("previewProps } from"))
    .join("\n");

  return [closureSource, ...supportSources, rewrittenEntry].filter(Boolean).join("\n\n");
}

export function createPieceVirtualFileSystemPlugin(files) {
  return {
    name: "piece-virtual-file-system",
    setup(build) {
      const filter = /^\/@(?:closure|preview|fixture)\//;
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "piece-vfs" }));
      build.onLoad({ filter: /.*/, namespace: "piece-vfs" }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `Missing piece virtual module: ${args.path}` }] };
        }
        return {
          contents,
          loader: args.path.endsWith(".ts") ? "ts" : "tsx",
          resolveDir: "/"
        };
      });
    }
  };
}
