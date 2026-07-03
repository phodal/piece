import { stableTextHash } from "./hash.js";
import {
  collectIdentifierReferences,
  createSourceRange,
  isHookName,
  isPascalCaseName
} from "./source-utils.js";

function sliceId(filePath, kind, name, index) {
  return `${filePath}#${kind}:${name ?? index}`;
}

function sourceForNode(source, node) {
  return source.slice(node.startIndex, node.endIndex);
}

function nodeName(source, node) {
  const nameNode = typeof node.childForFieldName === "function" ? node.childForFieldName("name") : undefined;
  return nameNode ? sourceForNode(source, nameNode) : undefined;
}

function treeSitterSliceKind(node) {
  if (node.type === "interface_declaration" || node.type === "type_alias_declaration") return "type";
  if (node.type === "class_declaration") return "class";
  if (node.type === "function_declaration") return "function";
  if (node.type === "enum_declaration") return "value";
  if (node.type === "lexical_declaration" || node.type === "variable_declaration" || node.type === "const_declaration" || node.type === "let_declaration" || node.type === "var_declaration") return "value";
  return undefined;
}

function hasFunctionInitializer(node) {
  const text = node.text ?? "";
  return /=>|function\s*\(/.test(text);
}

function hasJsx(source) {
  return /<[A-Z][A-Za-z0-9_$]*(\s|>|\/>)/.test(source);
}

function createSliceFromTreeNode({ filePath, source, node, index, sourceNode = node }) {
  let kind = treeSitterSliceKind(node);
  const text = sourceForNode(source, sourceNode);
  const name = nodeName(source, node) ?? text.match(/\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1];
  if (kind === "value" && hasFunctionInitializer({ text })) {
    kind = "function";
  }
  if (!kind) {
    return undefined;
  }

  const previewable = (kind === "function" || kind === "class") && Boolean(name) && isPascalCaseName(name) && !isHookName(name);
  const references = collectIdentifierReferences(text, { excluded: [name] });

  return {
    id: sliceId(filePath, kind, name, index),
    filePath,
    kind,
    name,
    exportName: /\bexport\b/.test(text) && name ? name : undefined,
    isDefaultExport: /\bexport\s+default\b/.test(text),
    range: createSourceRange(source, sourceNode.startIndex, sourceNode.endIndex),
    source: text,
    symbols: {
      defines: name ? [name] : [],
      references,
      typeReferences: [],
      jsxReferences: [...new Set([...text.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)].map((match) => match[1]))].sort()
    },
    preview: {
      previewable,
      reason: previewable ? undefined : "not a previewable component declaration"
    },
    hashes: {
      bodyHash: stableTextHash(text),
      signatureHash: stableTextHash(text.slice(0, Math.min(text.length, 240))),
      typeHash: kind === "type" ? stableTextHash(text) : undefined
    },
    safety: {
      hasTopLevelSideEffect: false,
      hasDynamicImport: /import\s*\(|require\s*\(/.test(text),
      hasUnknownGlobal: false,
      fallbackRequired: false
    }
  };
}

function extractImportBindings(source, headerSource) {
  const bindings = [];
  for (const match of headerSource.matchAll(/import\s+(type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/gs)) {
    const isTypeOnly = Boolean(match[1]);
    const clause = match[2].trim();
    const moduleSource = match[3];
    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defaultMatch && !clause.startsWith("{") && !clause.startsWith("*")) {
      bindings.push({ local: defaultMatch[1], imported: "default", source: moduleSource, kind: "default", isTypeOnly });
    }
    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch) {
      bindings.push({ local: namespaceMatch[1], imported: "*", source: moduleSource, kind: "namespace", isTypeOnly });
    }
    const namedMatch = clause.match(/\{([^}]+)\}/s);
    if (namedMatch) {
      for (const part of namedMatch[1].split(",")) {
        const binding = part.trim();
        if (!binding) continue;
        const [imported, local = imported] = binding.split(/\s+as\s+/);
        bindings.push({ local: local.trim(), imported: imported.replace(/^type\s+/, "").trim(), source: moduleSource, kind: "named", isTypeOnly: isTypeOnly || /^type\s+/.test(imported.trim()) });
      }
    }
  }
  return bindings.sort((left, right) => left.local.localeCompare(right.local));
}

export function createTreeSitterDeclarationExtractor(options = {}) {
  return {
    name: options.name ?? "tree-sitter-declaration-extractor",
    async extract({ filePath, source, previousTree }) {
      const tree = options.tree ?? options.parser?.parse(source, previousTree);
      if (!tree?.rootNode) {
        throw new TypeError("Tree-sitter extractor requires a parser or tree with rootNode.");
      }

      const slices = [];
      const headers = [];
      const effects = [];
      const rootChildren = tree.rootNode.namedChildren ?? [];

      rootChildren.forEach((node, index) => {
        if (node.type === "export_statement") {
          const exportedDeclaration = (node.namedChildren ?? []).find((child) => treeSitterSliceKind(child));
          if (exportedDeclaration) {
            const slice = createSliceFromTreeNode({ filePath, source, node: exportedDeclaration, sourceNode: node, index });
            if (slice) {
              slices.push(slice);
              return;
            }
          }
        }

        if (node.type === "import_statement" || node.type === "export_statement") {
          const headerSource = sourceForNode(source, node);
          headers.push({
            id: sliceId(filePath, "header", node.type, index),
            filePath,
            kind: "header",
            range: createSourceRange(source, node.startIndex, node.endIndex),
            source: headerSource,
            importBindings: extractImportBindings(source, headerSource)
          });
          return;
        }

        const slice = createSliceFromTreeNode({ filePath, source, node, index });
        if (slice) {
          slices.push(slice);
          return;
        }

        const effectSource = sourceForNode(source, node);
        effects.push({
          id: sliceId(filePath, "effect", `top-level-${index}`, index),
          filePath,
          kind: "effect",
          range: createSourceRange(source, node.startIndex, node.endIndex),
          source: effectSource,
          hashes: { bodyHash: stableTextHash(effectSource) },
          safety: { hasTopLevelSideEffect: true, hasDynamicImport: /import\s*\(|require\s*\(/.test(effectSource), hasUnknownGlobal: true, fallbackRequired: true }
        });
      });

      return {
        version: 1,
        filePath,
        source,
        parser: this.name,
        slices,
        headers,
        effects,
        importBindings: headers.flatMap((header) => header.importBindings),
        hasTopLevelEffect: effects.length > 0,
        diagnostics: []
      };
    }
  };
}

export function createFallbackDeclarationExtractor() {
  return {
    name: "fallback-declaration-extractor",
    async extract({ filePath, source }) {
      const namedChildren = findFallbackTopLevelNodes(source);
      const extractor = createTreeSitterDeclarationExtractor({
        tree: {
          rootNode: {
            namedChildren
          }
        }
      });
      const manifest = await extractor.extract({ filePath, source });
      return { ...manifest, parser: this.name };
    }
  };
}

function fallbackNodeType(keyword, text) {
  if (keyword === "import") return "import_statement";
  if (keyword === "interface") return "interface_declaration";
  if (keyword === "type") return "type_alias_declaration";
  if (keyword === "class") return "class_declaration";
  if (keyword === "function") return "function_declaration";
  if (keyword === "enum") return "enum_declaration";
  if ((keyword === "const" || keyword === "let" || keyword === "var") && /=>|function\s*\(/.test(text)) return "lexical_declaration";
  if (keyword === "const" || keyword === "let" || keyword === "var") return "lexical_declaration";
  return "expression_statement";
}

function findFallbackTopLevelNodes(source) {
  const nodes = [];
  const pattern = /^(import|export\s+(?:default\s+)?(?:interface|type|class|function|const|let|var|enum)|interface|type|class|function|const|let|var|enum)\b/gm;
  let match;

  while ((match = pattern.exec(source))) {
    const startIndex = match.index;
    const rawKeyword = match[1];
    const keyword = rawKeyword.split(/\s+/).filter((part) => part !== "export" && part !== "default")[0];
    const endIndex = findFallbackDeclarationEnd(source, startIndex);
    const text = source.slice(startIndex, endIndex);
    nodes.push({
      type: fallbackNodeType(keyword, text),
      startIndex,
      endIndex,
      namedChildren: []
    });
    pattern.lastIndex = Math.max(pattern.lastIndex, endIndex);
  }

  return nodes;
}

function findFallbackDeclarationEnd(source, startIndex) {
  let curlyDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let sawBody = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      curlyDepth += 1;
      sawBody = true;
      continue;
    }
    if (char === "}") {
      curlyDepth = Math.max(0, curlyDepth - 1);
      if (sawBody && curlyDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        return consumeOptionalSemicolon(source, index + 1);
      }
      continue;
    }
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === ";" && curlyDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      return index + 1;
    }
  }

  return source.length;
}

function consumeOptionalSemicolon(source, index) {
  let current = index;
  while (/\s/.test(source[current] ?? "")) {
    current += 1;
  }
  return source[current] === ";" ? current + 1 : index;
}
