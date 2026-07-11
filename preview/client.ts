import { javascript } from "@codemirror/lang-javascript";
import { EditorView, basicSetup } from "codemirror";
import * as esbuild from "esbuild-wasm/esm/browser";
import {
  analyzePieceFile,
  applyPieceEdit,
  buildPiecePreview
} from "../src/core/piece-pipeline.js";
import { createFallbackDeclarationExtractor } from "../src/core/declaration-extractor.js";

const filePath = "/workspace/DashboardPage.tsx";
const targetName = "UserCard";
const fixturePath = "/@fixture/DashboardPage.UserCard.fixture.ts";
const previewPropsModule = `export const previewProps = { user: { id: "u-1024", name: "Ada Lovelace", status: "active", score: 94 } };`;

type MetricRecord = Record<string, string | number>;

const editorHost = document.querySelector<HTMLElement>("#editor")!;
const editorPosition = document.querySelector<HTMLElement>("#editor-position")!;
const editorStats = document.querySelector<HTMLElement>("#editor-stats")!;
const iframe = document.querySelector<HTMLIFrameElement>("#preview")!;
const status = document.querySelector<HTMLElement>("#status")!;
const target = document.querySelector<HTMLElement>("#target")!;
const metricsGrid = document.querySelector<HTMLElement>("#metrics-grid")!;
const fixtureSizeSelect = document.querySelector<HTMLSelectElement>("#fixture-size")!;
const runBenchmarkButton = document.querySelector<HTMLButtonElement>("#run-benchmark")!;
const sampleEditButton = document.querySelector<HTMLButtonElement>("#apply-sample-edit")!;
const runEditSequenceButton = document.querySelector<HTMLButtonElement>("#run-edit-sequence")!;
const assetRevision = new URL(import.meta.url).searchParams.get("v");

let esbuildReady = false;
let currentAnalysis: any;
let currentPreview: any;
let currentSource = "";
let lastMetrics: MetricRecord = {};
let debounceTimer = 0;
let editorView: EditorView;
let suppressEditorRebuild = false;
let latestRebuildVersion = 0;
let editSequenceRunning = false;
const declarationExtractor = createFallbackDeclarationExtractor();
const textEncoder = new TextEncoder();

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
const ORDER_PRODUCTS = [
  "Mechanical Keyboard",
  "Ultrawide Monitor",
  "Noise Cancelling Headset",
  "Standing Desk",
  "Ergonomic Chair",
  "USB-C Dock",
  "4K Webcam",
  "Wireless Mouse"
];
const ORDER_CUSTOMERS = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Katherine Johnson",
  "Margaret Hamilton",
  "Radia Perlman",
  "Barbara Liskov",
  "Tim Berners-Lee"
];

function buildSampleOrders(count: number) {
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const status = ORDER_STATUSES[index % ORDER_STATUSES.length];
    const product = ORDER_PRODUCTS[index % ORDER_PRODUCTS.length];
    const customer = ORDER_CUSTOMERS[index % ORDER_CUSTOMERS.length];
    const quantity = 1 + (index % 5);
    const unitPrice = (19.99 + (index % 12) * 7.5).toFixed(2);
    const month = 1 + (index % 6);
    const day = 1 + (index % 27);
    rows.push(
      `  { id: "ORD-${1000 + index}", customer: "${customer}", product: "${product}", status: "${status}", quantity: ${quantity}, unitPrice: ${unitPrice}, placedAt: "2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}" }`
    );
  }
  return rows.join(",\n");
}

// Mirrors a realistic ops dashboard: a handful of hand-authored components and
// helpers operating over a sizable embedded sample dataset, instead of a
// mechanically repeated block of near-identical throwaway components.
function createRealisticFixture(orderCount = 420) {
  const sampleOrders = buildSampleOrders(orderCount);

  return `import * as React from "react";

export type OrderStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";

export interface Order {
  id: string;
  customer: string;
  product: string;
  status: OrderStatus;
  quantity: number;
  unitPrice: number;
  placedAt: string;
}

export const SAMPLE_ORDERS: Order[] = [
${sampleOrders}
];

export function formatCurrency(value: number) {
  return "$" + value.toFixed(2);
}

export function formatDate(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function computeOrderTotal(order: Order) {
  return order.quantity * order.unitPrice;
}

export function sumRevenue(orders: Order[]) {
  let total = 0;
  for (const order of orders) {
    total += computeOrderTotal(order);
  }
  return total;
}

export function countByStatus(orders: Order[], status: OrderStatus) {
  let count = 0;
  for (const order of orders) {
    if (order.status === status) {
      count += 1;
    }
  }
  return count;
}

export function sortOrdersByDate(orders: Order[]) {
  return [...orders].sort(compareOrdersByDate);
}

function compareOrdersByDate(left: Order, right: Order) {
  return right.placedAt.localeCompare(left.placedAt);
}

const STATUS_LABELS: { [key in OrderStatus]: string } = {
  pending: "Pending",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled"
};

const STATUS_COLORS: { [key in OrderStatus]: string } = {
  pending: "#a45b00",
  processing: "#1677ff",
  shipped: "#7c3aed",
  delivered: "#0f7a4f",
  cancelled: "#b91c1c"
};

interface StatusBadgeProps {
  status: OrderStatus;
}

export function StatusBadge(props: StatusBadgeProps) {
  const color = STATUS_COLORS[props.status];
  return (
    <span className="status-badge" style={{ color, borderColor: color }}>
      {STATUS_LABELS[props.status]}
    </span>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  tone: "up" | "down" | "neutral";
}

export function StatCard(props: StatCardProps) {
  const className = "stat-card stat-" + props.tone;
  return (
    <div className={className}>
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">{props.value}</strong>
    </div>
  );
}

interface StatsPanelProps {
  orders: Order[];
}

export function StatsPanel(props: StatsPanelProps) {
  const revenue = sumRevenue(props.orders);
  const openOrders = countByStatus(props.orders, "pending") + countByStatus(props.orders, "processing");
  const delivered = countByStatus(props.orders, "delivered");
  const cancelled = countByStatus(props.orders, "cancelled");
  return (
    <section className="stats-panel">
      <StatCard label="Total revenue" value={formatCurrency(revenue)} tone="up" />
      <StatCard label="Open orders" value={String(openOrders)} tone="neutral" />
      <StatCard label="Delivered" value={String(delivered)} tone="up" />
      <StatCard label="Cancelled" value={String(cancelled)} tone="down" />
    </section>
  );
}

interface OrderRowProps {
  order: Order;
}

export function OrderRow(props: OrderRowProps) {
  return (
    <tr>
      <td>{props.order.id}</td>
      <td>{props.order.customer}</td>
      <td>{props.order.product}</td>
      <td><StatusBadge status={props.order.status} /></td>
      <td>{props.order.quantity}</td>
      <td>{formatCurrency(computeOrderTotal(props.order))}</td>
      <td>{formatDate(props.order.placedAt)}</td>
    </tr>
  );
}

function renderOrderRow(order: Order) {
  return <OrderRow key={order.id} order={order} />;
}

interface OrdersTableProps {
  orders: Order[];
}

export function OrdersTable(props: OrdersTableProps) {
  const sorted = sortOrdersByDate(props.orders);
  const visible = sorted.slice(0, 25);
  return (
    <div className="orders-table">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Status</th>
            <th>Qty</th>
            <th>Total</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(renderOrderRow)}
        </tbody>
      </table>
    </div>
  );
}

interface FilterBarProps {
  placeholder: string;
}

export function FilterBar(props: FilterBarProps) {
  return (
    <div className="filter-bar">
      <input placeholder={props.placeholder} />
    </div>
  );
}

const NAV_ITEMS = ["Overview", "Orders", "Customers", "Inventory", "Reports", "Settings"];

function renderNavItem(item: string, active: string) {
  const className = item === active ? "nav-item active" : "nav-item";
  return (
    <a key={item} className={className} href={"#" + item.toLowerCase()}>
      {item}
    </a>
  );
}

interface SidebarProps {
  active: string;
}

export function Sidebar(props: SidebarProps) {
  const items = [];
  for (const item of NAV_ITEMS) {
    items.push(renderNavItem(item, props.active));
  }
  return <nav className="sidebar">{items}</nav>;
}

type UserStatus = "active" | "disabled" | "paused";

interface User {
  id: string;
  name: string;
  status: UserStatus;
  score: number;
}

interface UserCardProps {
  user: User;
}

const statusColorMap = {
  active: "#0f7a4f",
  disabled: "#6b7280",
  paused: "#a45b00"
};

const statusLabelMap = {
  active: "Active account",
  disabled: "Disabled account",
  paused: "Paused account"
};

export function formatScore(score: number) {
  return score.toFixed(1);
}

export function UserCard(props: UserCardProps) {
  const color = statusColorMap[props.user.status];
  return (
    <article className="user-card" data-piece-version="00" style={{ borderColor: color }}>
      <h1>{props.user.name}</h1>
      <p data-testid="status-label" style={{ color }}>{statusLabelMap[props.user.status]}</p>
      <strong data-testid="score">Score: {formatScore(props.user.score)}</strong>
    </article>
  );
}

function cacheProbe() {
  return "Cache probe 00";
}

export default function DashboardPage() {
  const user: User = { id: "u-1024", name: "Ada Lovelace", status: "active", score: 94 };
  return (
    <main className="dashboard">
      <Sidebar active="Overview" />
      <div className="dashboard-content">
        <header className="dashboard-header">
          <UserCard user={user} />
          <FilterBar placeholder="Search orders" />
        </header>
        <StatsPanel orders={SAMPLE_ORDERS} />
        <OrdersTable orders={SAMPLE_ORDERS} />
      </div>
    </main>
  );
}
`;
}

function metric(label: string, value: string | number, tone = "") {
  return `<div class="metric ${tone}"><b>${value}</b><span>${label}</span></div>`;
}

function getEditorSource() {
  return editorView.state.doc.toString();
}

function updateEditorStatus(view: EditorView) {
  const source = view.state.doc.toString();
  const mainSelection = view.state.selection.main;
  const line = view.state.doc.lineAt(mainSelection.head);
  const selected = view.state.selection.ranges.reduce((total, range) => total + Math.abs(range.to - range.from), 0);
  editorPosition.textContent = `Ln ${line.number}, Col ${mainSelection.head - line.from + 1}`;
  editorStats.textContent = `${view.state.doc.lines} lines | ${textEncoder.encode(source).length} bytes${selected > 0 ? ` | ${selected} selected` : ""}`;
}

function setEditorSource(value: string, selection = 0) {
  const boundedSelection = Math.max(0, Math.min(selection, value.length));
  suppressEditorRebuild = true;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: value },
    selection: { anchor: boundedSelection },
    scrollIntoView: true
  });
  suppressEditorRebuild = false;
  updateEditorStatus(editorView);
}

const previewEditorTheme = EditorView.theme({
  "&": {
    height: "100%"
  },
  ".cm-scroller": {
    overflow: "auto"
  },
  ".cm-content": {
    minHeight: "100%"
  }
});

function createEditor() {
  return new EditorView({
    doc: createRealisticFixture(Number(fixtureSizeSelect.value)),
    parent: editorHost,
    extensions: [
      basicSetup,
      javascript({ jsx: true, typescript: true }),
      previewEditorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updateEditorStatus(update.view);
          if (!suppressEditorRebuild) {
            scheduleRebuild();
          }
          return;
        }
        if (update.selectionSet || update.focusChanged) {
          updateEditorStatus(update.view);
        }
      })
    ]
  });
}

function renderMetrics(metrics: MetricRecord) {
  metricsGrid.dataset.metrics = JSON.stringify(metrics);
  metricsGrid.innerHTML = [
    metric("piece total", metrics.pieceTotalMs ?? "-", "good"),
    metric("piece e2e", metrics.pieceE2EMs ?? "-"),
    metric("full esbuild-wasm", metrics.fullTotalMs ?? "-", "warn"),
    metric("speedup", metrics.speedup ?? "-", "good"),
    metric("e2e speedup", metrics.e2eSpeedup ?? "-"),
    metric("cache", metrics.cache ?? "-"),
    metric("reconcile", metrics.diffMs ?? "-"),
    metric("version", metrics.version ?? "-"),
    metric("analyze", metrics.analyzeMs ?? "-"),
    metric("closure", metrics.closureMs ?? "-"),
    metric("piece bundle", metrics.bundleMs ?? "-"),
    metric("closure bytes", metrics.closureBytes ?? "-"),
    metric("source bytes", metrics.sourceBytes ?? "-"),
    metric("affected", metrics.affectedTargets ?? "-"),
    metric("dirty", metrics.dirtyPieces ?? "-"),
    metric("shape changes", metrics.publicShapeChanges ?? "-"),
    metric("artifact reuse", metrics.reusedArtifacts ?? "-"),
    metric("invalidated", metrics.invalidatedArtifacts ?? "-"),
    metric("sequence edits", metrics.sequenceEdits ?? "-"),
    metric("sequence cache hits", metrics.sequenceCacheHits ?? "-"),
    metric("sequence diff p50", metrics.sequenceDiffP50 ?? "-"),
    metric("sequence diff p95", metrics.sequenceDiffP95 ?? "-"),
    metric("slices", metrics.slices ?? "-"),
    metric("edges", metrics.edges ?? "-")
  ].join("");
}

function assetUrl(path: string) {
  const url = new URL(path, document.baseURI);
  if (assetRevision) {
    url.searchParams.set("v", assetRevision);
  }
  return url.href;
}

function iframeSrcDoc(code: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="importmap">
      {
        "imports": {
          "react": ${JSON.stringify(assetUrl("dist/vendor/react.js"))},
          "react-dom/client": ${JSON.stringify(assetUrl("dist/vendor/react-dom-client.js"))},
          "react/jsx-runtime": ${JSON.stringify(assetUrl("dist/vendor/react-jsx-runtime.js"))}
        }
      }
    </script>
    <style>
      body { margin: 0; font: 14px/1.5 Inter, system-ui, sans-serif; background: #f8fafc; color: #17202a; }
      #root { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .user-card { width: min(420px, 90vw); border: 2px solid #0f7a4f; border-radius: 8px; padding: 24px; background: #fff; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12); }
      .user-card h1 { margin: 0 0 8px; font-size: 28px; }
      .user-card p { margin: 0 0 16px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script>
  </body>
</html>`;
}

async function ensureEsbuild() {
  if (esbuildReady) {
    return;
  }
  await esbuild.initialize({
    wasmURL: assetUrl("dist/vendor/esbuild.wasm"),
    worker: true
  });
  esbuildReady = true;
}

function virtualPlugin(files: Record<string, string>) {
  return {
    name: "preview-vfs",
    setup(build: any) {
      build.onResolve({ filter: /^\/workspace\// }, (args: any) => ({ path: args.path, namespace: "preview-vfs" }));
      build.onLoad({ filter: /.*/, namespace: "preview-vfs" }, (args: any) => ({
        contents: files[args.path],
        loader: args.path.endsWith(".ts") ? "ts" : "tsx"
      }));
    }
  };
}

async function buildFullEsbuild(source: string) {
  const startedAt = performance.now();
  const files = {
    [filePath]: source,
    "/workspace/full-entry.tsx": `import * as React from "react";
import { createRoot } from "react-dom/client";
import DashboardPage from "${filePath}";
createRoot(document.getElementById("root")!).render(<DashboardPage />);`
  };
  await esbuild.build({
    entryPoints: ["/workspace/full-entry.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [virtualPlugin(files)]
  });
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function sourceRangeForChangedText(previousSource: string, nextSource: string) {
  let startByte = 0;
  while (startByte < previousSource.length && startByte < nextSource.length && previousSource[startByte] === nextSource[startByte]) {
    startByte += 1;
  }

  let previousEnd = previousSource.length;
  let nextEnd = nextSource.length;
  while (previousEnd > startByte && nextEnd > startByte && previousSource[previousEnd - 1] === nextSource[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const startLine = nextSource.slice(0, startByte).split("\n").length;
  const endLine = nextSource.slice(0, nextEnd).split("\n").length;
  return {
    startByte,
    endByte: Math.max(startByte + 1, nextEnd),
    startLine,
    endLine
  };
}

async function compilePiece(source: string, previousPreview?: any, analysisOverride?: any) {
  await ensureEsbuild();
  const buildEngine = {
    name: "browser-esbuild-wasm",
    build(options: any) {
      return esbuild.build(options);
    },
    transform(source: string, options: any) {
      return esbuild.transform(source, options);
    }
  };
  const analysis = analysisOverride ?? (await analyzePieceFile({ filePath, source, declarationExtractor }));
  const preview = await buildPiecePreview({
    filePath,
    source,
    analysis,
    declarationExtractor,
    target: targetName,
    buildEngine,
    compileStrategy: "transform",
    previousPreview,
    preview: {
      propsModulePath: fixturePath,
      virtualFiles: {
        [fixturePath]: previewPropsModule
      }
    }
  });
  return { analysis, preview };
}

async function rebuild(source: string, mode: "initial" | "edit" | "benchmark" = "edit") {
  const rebuildVersion = latestRebuildVersion + 1;
  latestRebuildVersion = rebuildVersion;
  try {
    status.textContent = "Compiling...";
    const previousAnalysis = currentAnalysis;
    const previousPreview = currentPreview;
    const reuseAnalysis = mode === "benchmark" && currentAnalysis;
    let affectedTargets = 1;
    let analysisWorkMs = 0;
    let analysisOverride = reuseAnalysis ? currentAnalysis : undefined;
    let reconciliationMetrics = {
      dirtyPieces: 0,
      publicShapeChanges: 0,
      reusedArtifacts: 0,
      invalidatedArtifacts: 0,
      diffMs: 0
    };

    if (mode === "edit" && previousAnalysis && currentSource) {
      const editResult = await applyPieceEdit({
        filePath,
        source,
        previousAnalysis,
        declarationExtractor,
        changedRanges: [sourceRangeForChangedText(currentSource, source)]
      });
      affectedTargets = editResult.affectedTargets.length;
      analysisWorkMs = editResult.metrics.totalMs;
      analysisOverride = editResult.analysis;
      reconciliationMetrics = {
        dirtyPieces: editResult.reconciliation.dirtyPieces.length,
        publicShapeChanges: editResult.reconciliation.publicShapeChangedPieces.length,
        reusedArtifacts: editResult.reconciliation.reusedArtifactIds.length,
        invalidatedArtifacts: editResult.reconciliation.invalidatedArtifactIds.length,
        diffMs: editResult.metrics.phases.diffMs
      };
    }

    const result = await compilePiece(source, previousPreview, analysisOverride);

    if (reuseAnalysis) {
      affectedTargets = 0;
    } else if (!previousAnalysis) {
      analysisWorkMs = result.analysis.metrics.totalMs;
    }

    const fullTotalMs = mode === "benchmark" ? await buildFullEsbuild(source) : undefined;
    if (rebuildVersion !== latestRebuildVersion) {
      return;
    }

    currentAnalysis = result.analysis;
    currentPreview = result.preview;
    currentSource = source;
    iframe.srcdoc = iframeSrcDoc(result.preview.bundle?.code ?? "");
    const pieceTotalMs = result.preview.metrics.totalMs;
    const pieceE2EMs = Math.round(((reuseAnalysis ? 0 : analysisWorkMs) + pieceTotalMs) * 1000) / 1000;
    const fullBaseline = fullTotalMs === undefined ? "not sampled (click Run Benchmark)" : `${fullTotalMs}ms`;
    const speedup = fullTotalMs && fullTotalMs > 0 ? `${(fullTotalMs / Math.max(pieceTotalMs, 0.001)).toFixed(2)}x` : "-";
    const e2eSpeedup = fullTotalMs && fullTotalMs > 0 ? `${(fullTotalMs / Math.max(pieceE2EMs, 0.001)).toFixed(2)}x` : "-";
    lastMetrics = {
      version: rebuildVersion,
      pieceTotalMs,
      pieceE2EMs,
      fullTotalMs: fullTotalMs ?? "Run Benchmark",
      speedup,
      e2eSpeedup,
      cache: result.preview.metrics.cache.status,
      analyzeMs: reuseAnalysis ? 0 : analysisWorkMs,
      closureMs: result.preview.metrics.phases.closureMs,
      bundleMs: result.preview.metrics.phases.bundleMs,
      closureBytes: result.preview.metrics.closureBytes,
      sourceBytes: result.preview.metrics.sourceBytes,
      affectedTargets,
      ...reconciliationMetrics,
      slices: result.analysis.metrics.sliceCount,
      edges: result.analysis.metrics.edgeCount
    };
    renderMetrics(lastMetrics);
    status.textContent = `${mode}: piece=${pieceTotalMs}ms, full baseline=${fullBaseline}, speedup=${speedup}, e2e=${e2eSpeedup}`;
    target.textContent = `target: ${targetName}`;
    (window as any).__piecePreview = {
      version: rebuildVersion,
      source,
      metrics: lastMetrics,
      analysis: result.analysis,
      preview: result.preview
    };
    return lastMetrics;
  } catch (error) {
    if (rebuildVersion !== latestRebuildVersion) {
      return;
    }
    console.error(error);
    status.textContent = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

function scheduleRebuild() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    void rebuild(getEditorSource(), "edit");
  }, 250);
}

function nextMarkerVersion(source: string, pattern: RegExp, render: (version: string) => string) {
  return source.replace(pattern, (_match, version) => render(String((Number(version) + 1) % 100).padStart(2, "0")));
}

function applySampleEdit() {
  const source = getEditorSource();
  const cursor = editorView.state.selection.main.head;
  const next = nextMarkerVersion(source, /data-piece-version="(\d{2})"/, (version) => `data-piece-version="${version}"`);
  if (next === source) {
    status.textContent = "Sample edit marker is missing from the current source.";
    return;
  }
  setEditorSource(next, cursor);
  void rebuild(next, "edit");
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) {
    return "-";
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return `${sorted[index].toFixed(3)}ms`;
}

async function runEditSequence() {
  if (editSequenceRunning) {
    return;
  }

  editSequenceRunning = true;
  runEditSequenceButton.disabled = true;
  try {
    let source = getEditorSource();
    const samples: MetricRecord[] = [];
    for (let index = 0; index < 10; index += 1) {
      const next = nextMarkerVersion(source, /Cache probe (\d{2})/, (version) => `Cache probe ${version}`);
      if (next === source) {
        status.textContent = "Cached-edit marker is missing from the current source.";
        return;
      }
      setEditorSource(next, editorView.state.selection.main.head);
      const metrics = await rebuild(next, "edit");
      if (!metrics) {
        return;
      }
      samples.push(metrics);
      source = next;
    }

    const diffTimes = samples.map((sample) => sample.diffMs).filter((value): value is number => typeof value === "number");
    const cacheHits = samples.filter((sample) => sample.cache === "hit").length;
    lastMetrics = {
      ...lastMetrics,
      sequenceEdits: samples.length,
      sequenceCacheHits: `${cacheHits}/${samples.length}`,
      sequenceDiffP50: percentile(diffTimes, 0.5),
      sequenceDiffP95: percentile(diffTimes, 0.95)
    };
    renderMetrics(lastMetrics);
    status.textContent = `cached edit sequence: ${samples.length} edits, ${cacheHits}/${samples.length} runtime cache hits, diff p50=${lastMetrics.sequenceDiffP50}`;
  } finally {
    editSequenceRunning = false;
    runEditSequenceButton.disabled = false;
  }
}

function resetFixture() {
  const source = createRealisticFixture(Number(fixtureSizeSelect.value));
  currentAnalysis = undefined;
  currentPreview = undefined;
  currentSource = "";
  setEditorSource(source, 0);
  void rebuild(source, "initial");
}

editorView = createEditor();
updateEditorStatus(editorView);
runBenchmarkButton.addEventListener("click", () => void rebuild(getEditorSource(), "benchmark"));
sampleEditButton.addEventListener("click", applySampleEdit);
runEditSequenceButton.addEventListener("click", () => void runEditSequence());
fixtureSizeSelect.addEventListener("change", resetFixture);

void rebuild(getEditorSource(), "initial");
