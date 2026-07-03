export * from "./index.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as esbuild from "esbuild";

const SOURCE_FILE_PATTERN = /\.(tsx?|jsx?)$/;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

export function createNodeEsbuildBuildEngine(options = {}) {
  return {
    name: options.name ?? "node-esbuild",
    build(buildOptions) {
      return esbuild.build({
        ...options.buildOptions,
        ...buildOptions
      });
    },
    transform(source, transformOptions = {}) {
      return esbuild.transform(source, {
        ...options.transformOptions,
        ...transformOptions
      });
    }
  };
}

async function collectSourceFilesFromDirectory(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

export function createNodeVirtualFileSystem(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());

  return {
    kind: "node",
    cwd,
    toAbsolutePath(path) {
      return isAbsolute(path) ? path : resolve(cwd, path);
    },
    relativePath(path) {
      return relative(cwd, this.toAbsolutePath(path)) || ".";
    },
    async readText(path) {
      return readFile(this.toAbsolutePath(path), "utf8");
    },
    async writeText(path, contents) {
      const absolutePath = this.toAbsolutePath(path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    },
    async collectSourceFiles(sourceRoots) {
      const roots = sourceRoots.length > 0 ? sourceRoots : ["."];
      const files = [];
      for (const sourceRoot of roots) {
        files.push(...(await collectSourceFilesFromDirectory(this.toAbsolutePath(sourceRoot))));
      }
      return [...new Set(files.map((file) => this.relativePath(file)))].sort();
    },
    dirname(path) {
      return dirname(this.toAbsolutePath(path));
    }
  };
}
