import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePieceAction } from "piece-compiler/node";
import { legacyStableTextHash, stableTextHash } from "../src/core/hash.js";

function fixture(name, value = 1) {
  const filePath = `/repo/src/${name}.ts`;
  const targetLabel = `//repo/src:${name}.ts__function_${name}`;
  const actionId = `${targetLabel}%compile`;
  const artifactId = `${name}.compile.json`;
  const target = {
    id: `${filePath}#function:${name}`,
    label: targetLabel,
    name,
    actions: [actionId]
  };
  const action = {
    id: actionId,
    target: targetLabel,
    kind: "compile",
    inputs: [],
    outputs: [artifactId]
  };
  const artifact = {
    id: artifactId,
    target: targetLabel,
    kind: "piece-compile",
    path: artifactId,
    cacheKey: `${name}-cache-key`
  };
  return {
    filePath,
    source: `export const ${name} = () => ${value};\n`,
    actionPackage: {
      version: 1,
      kind: "single-file-package",
      label: `//repo/src:${name}.ts`,
      filePath,
      language: "typescript",
      targets: [target],
      actions: [action],
      artifacts: [artifact]
    },
    pieceTarget: name
  };
}

async function compileFixture(root, name, value = 1, extra = {}) {
  const input = fixture(name, value);
  return compilePieceAction({
    ...input,
    language: "typescript",
    actionCacheStorePath: join(root, "cache", "action-cache.json"),
    ...extra
  });
}

async function readStore(root) {
  return JSON.parse(await readFile(join(root, "cache", "action-cache.json"), "utf8"));
}

function storedJavaScriptArtifact(store, result) {
  const record = store.records[result.actionCache.record.key];
  const artifact = record?.result?.outputFiles?.find((file) => file.originalPath?.endsWith(".js"));
  if (!artifact) {
    throw new Error("Expected a promoted JavaScript cache artifact.");
  }
  return artifact;
}

describe("Node local action cache", () => {
  it("falls back to a real compiler run when a cached artifact is changed without changing its size", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-integrity-"));
    try {
      const first = await compileFixture(root, "greet");
      const store = await readStore(root);
      const artifact = storedJavaScriptArtifact(store, first);
      const original = await readFile(artifact.path);
      const tampered = Buffer.from(original);
      tampered[0] ^= 0x01;
      expect(tampered.byteLength).toBe((await stat(artifact.path)).size);
      await writeFile(artifact.path, tampered);

      const second = await compileFixture(root, "greet", 1, { actionCacheMode: "reuse-local" });

      expect(second.status).toBe("success");
      expect(second.actionCache.execution.skipped).toBe(false);
      expect(second.actionCache.reuse).toMatchObject({
        status: "skipped",
        reason: "cached-artifact-content-hash-mismatch"
      });
      expect(second.commands.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked cached artifacts instead of following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-symlink-"));
    try {
      const first = await compileFixture(root, "greet");
      const store = await readStore(root);
      const artifact = storedJavaScriptArtifact(store, first);
      const external = join(root, "external.js");
      await writeFile(external, await readFile(artifact.path));
      await rm(artifact.path);
      await symlink(external, artifact.path, "file");

      const second = await compileFixture(root, "greet", 1, { actionCacheMode: "reuse-local" });

      expect(second.status).toBe("success");
      expect(second.actionCache.execution.skipped).toBe(false);
      expect(second.actionCache.reuse).toMatchObject({
        status: "skipped",
        reason: "cached-artifact-symlink"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cache record whose artifact path escapes its verified store root", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-escape-"));
    try {
      const first = await compileFixture(root, "greet");
      const store = await readStore(root);
      const artifact = storedJavaScriptArtifact(store, first);
      const external = join(root, "external.js");
      await writeFile(external, await readFile(artifact.path));
      store.records[first.actionCache.record.key].result.outputFiles.find((file) => file.path === artifact.path).path = external;
      await writeFile(join(root, "cache", "action-cache.json"), `${JSON.stringify(store, null, 2)}\n`, "utf8");

      const second = await compileFixture(root, "greet", 1, { actionCacheMode: "reuse-local" });

      expect(second.status).toBe("success");
      expect(second.actionCache.execution.skipped).toBe(false);
      expect(second.actionCache.reuse).toMatchObject({
        status: "skipped",
        reason: "cached-artifact-outside-store"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an older local store as a miss and replaces it with the fingerprint v3 schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-v1-"));
    const storePath = join(root, "cache", "action-cache.json");
    try {
      await mkdir(join(root, "cache"), { recursive: true });
      await writeFile(
        storePath,
        `${JSON.stringify({ version: 1, kind: "piece-action-cache-store", records: {} }, null, 2)}\n`,
        "utf8"
      );

      const result = await compileFixture(root, "greet");
      const store = await readStore(root);

      expect(result.actionCache.status).toBe("miss");
      expect(result.actionCache.execution.skipped).toBe(false);
      expect(result.actionCache.reasons).toContainEqual(expect.objectContaining({ code: "action-cache-store-schema-miss" }));
      expect(store).toMatchObject({ version: 3, schemaVersion: 3, fingerprintVersion: 2, keyAlgorithm: "sha256" });
      expect(store.records[result.actionCache.record.key]).toMatchObject({
        version: 3,
        cacheSchemaVersion: 3,
        fingerprintVersion: 2,
        keyAlgorithm: "sha256"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses raw source in the secure key and does not inherit a legacy FNV collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-key-"));
    const firstSource = "export const greet = () => 1; // 1ff4dw1-76f\n";
    const secondSource = "export const greet = () => 1; // yfiuuu-n56\n";
    try {
      // This is a deterministic collision for the v1 32-bit FNV-derived
      // source hash. The rest of the action identity remains identical.
      expect(firstSource).not.toBe(secondSource);
      expect(legacyStableTextHash(firstSource)).toBe(legacyStableTextHash(secondSource));
      expect(stableTextHash(firstSource)).not.toBe(stableTextHash(secondSource));

      const first = await compileFixture(root, "greet", 1, { source: firstSource });
      const second = await compileFixture(root, "greet", 1, { source: secondSource });

      expect(first.actionCache.record.legacyKey).not.toBe(second.actionCache.record.legacyKey);
      expect(first.actionCache.record.key).toMatch(/^[a-f0-9]{64}$/);
      expect(second.actionCache.record.key).toMatch(/^[a-f0-9]{64}$/);
      expect(first.actionCache.record.key).not.toBe(second.actionCache.record.key);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every record when concurrent actions persist into one local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "piece-node-cache-concurrent-"));
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => compileFixture(root, `target${index}`, index)));
      const store = await readStore(root);

      expect(store).toMatchObject({ version: 3, schemaVersion: 3, fingerprintVersion: 2, keyAlgorithm: "sha256" });
      expect(Object.keys(store.records)).toHaveLength(results.length);
      for (const result of results) {
        expect(result.actionCache.persistence).toMatchObject({ status: "stored", recordKey: result.actionCache.record.key });
        expect(store.records[result.actionCache.record.key]).toMatchObject({
          version: 3,
          cacheSchemaVersion: 3,
          fingerprintVersion: 2,
          keyAlgorithm: "sha256",
          result: { status: "success" }
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
