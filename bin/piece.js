#!/usr/bin/env node
import { runPieceCli } from "../src/cli/index.js";

try {
  process.exitCode = await runPieceCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`piece failed unexpectedly: ${error?.message ?? String(error)}\n`);
  process.exitCode = 4;
}
