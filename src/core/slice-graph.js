import { isKnownGlobalReference } from "./source-utils.js";
import { buildPieceSymbolTable, serializePieceSymbolTable } from "./symbol-table.js";

function sliceById(manifest) {
  return new Map(manifest.slices.map((slice) => [slice.id, slice]));
}

function edgeId(edge) {
  return `${edge.from}->${edge.to}:${edge.kind}:${edge.symbols.join(",")}:${edge.import?.signature ?? ""}`;
}

function createEdge(from, to, kind, symbol) {
  return {
    from,
    to,
    kind,
    symbols: [symbol]
  };
}

function addEdge(edges, edge) {
  const id = edgeId(edge);
  if (!edges.has(id)) {
    edges.set(id, edge);
  }
}

function edgeKindForReference(reference, slice, targetSlice) {
  if (slice.symbols.typeReferences.includes(reference) || targetSlice.kind === "type") {
    return "type";
  }
  return "runtime";
}

function importBindingsForReference(slice, symbolTable, reference) {
  const sliceBindings = (slice.importBindings ?? []).filter((binding) => binding.local === reference);
  if (sliceBindings.length > 0) {
    return sliceBindings;
  }
  return symbolTable.importsByLocal.get(reference) ?? [];
}

function collectEdgesForSlice({ slice, symbolTable, slices, globals }) {
  const edges = new Map();
  const diagnostics = [];

  for (const reference of slice.symbols.references) {
    const localTarget = symbolTable.local.get(reference);
    if (localTarget && localTarget !== slice.id) {
      addEdge(edges, createEdge(slice.id, localTarget, edgeKindForReference(reference, slice, slices.get(localTarget)), reference));
      continue;
    }

    const importBindings = importBindingsForReference(slice, symbolTable, reference);
    if (importBindings.length > 0) {
      for (const importBinding of importBindings) {
        addEdge(edges, {
          from: slice.id,
          to: `${importBinding.source}#${importBinding.imported}`,
          kind: "external",
          symbols: [reference],
          import: importBinding
        });
      }
      continue;
    }

    const importBinding = symbolTable.imports.get(reference);
    if (importBinding) {
      addEdge(edges, {
        from: slice.id,
        to: `${importBinding.source}#${importBinding.imported}`,
        kind: "external",
        symbols: [reference],
        import: importBinding
      });
      continue;
    }

    if (!isKnownGlobalReference(reference, globals)) {
      addEdge(edges, createEdge(slice.id, `unknown:${reference}`, "unknown", reference));
      diagnostics.push({
        code: "unknown-reference",
        severity: "warning",
        message: `Unable to resolve reference "${reference}" in ${slice.name ?? slice.id}.`,
        sliceId: slice.id,
        symbol: reference
      });
    }
  }

  return {
    edges: [...edges.values()],
    diagnostics
  };
}

export function buildPieceSliceGraph(manifest, options = {}) {
  const symbolTable = buildPieceSymbolTable(manifest);
  const slices = sliceById(manifest);
  const edges = new Map();
  const diagnostics = [];

  for (const slice of manifest.slices) {
    const result = collectEdgesForSlice({ slice, symbolTable, slices, globals: options.globals });
    for (const edge of result.edges) {
      addEdge(edges, edge);
    }
    diagnostics.push(...result.diagnostics);
  }

  return {
    version: 1,
    filePath: manifest.filePath,
    slices: manifest.slices,
    edges: [...edges.values()].sort((left, right) => edgeId(left).localeCompare(edgeId(right))),
    symbolTable: serializePieceSymbolTable(symbolTable),
    diagnostics
  };
}

export function updatePieceSliceGraph(previousGraph, manifest, changedSliceIds, options = {}) {
  const changed = new Set(changedSliceIds);
  if (!previousGraph || changed.size === 0) {
    return buildPieceSliceGraph(manifest, options);
  }

  const symbolTable = buildPieceSymbolTable(manifest);
  const slices = sliceById(manifest);
  const edges = new Map();
  const diagnostics = previousGraph.diagnostics.filter((diagnostic) => !changed.has(diagnostic.sliceId));

  for (const edge of previousGraph.edges) {
    if (!changed.has(edge.from)) {
      addEdge(edges, edge);
    }
  }

  for (const sliceId of changed) {
    const slice = slices.get(sliceId);
    if (!slice) {
      continue;
    }
    const result = collectEdgesForSlice({ slice, symbolTable, slices, globals: options.globals });
    for (const edge of result.edges) {
      addEdge(edges, edge);
    }
    diagnostics.push(...result.diagnostics);
  }

  return {
    version: 1,
    filePath: manifest.filePath,
    slices: manifest.slices,
    edges: [...edges.values()].sort((left, right) => edgeId(left).localeCompare(edgeId(right))),
    symbolTable: serializePieceSymbolTable(symbolTable),
    diagnostics
  };
}

/**
 * Build forward and reverse edge indexes together. Callers that need both
 * dependency directions (notably reconciliation) avoid two full edge scans.
 */
export function indexPieceGraphEdges(graph) {
  const edgesBySource = new Map();
  const edgesByTarget = new Map();
  for (const edge of graph.edges) {
    const outgoing = edgesBySource.get(edge.from);
    if (outgoing) {
      outgoing.push(edge);
    } else {
      edgesBySource.set(edge.from, [edge]);
    }
    const incoming = edgesByTarget.get(edge.to);
    if (incoming) {
      incoming.push(edge);
    } else {
      edgesByTarget.set(edge.to, [edge]);
    }
  }
  return { edgesBySource, edgesByTarget };
}

export function reversePieceGraph(graph) {
  return indexPieceGraphEdges(graph).edgesByTarget;
}
