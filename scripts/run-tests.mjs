#!/usr/bin/env node
/**
 * Wrapper for `vitest run` that works around vitest 4.x bug where the
 * process hangs after tests complete (vitest-dev/vitest#8766).
 *
 * Vitest's fork worker blocks in rpcDone() waiting for pending RPC
 * responses, preventing the process from exiting. This wrapper sets
 * a hard timeout: if vitest hasn't exited within MAX_SECONDS after
 * startup, it kills the entire process tree and exits based on
 * whether any test failures were detected in the output.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MAX_SECONDS = 60;
const vitestBin = resolve("node_modules/.bin/vitest");
const args = ["run", ...process.argv.slice(2)];

const child = spawn(vitestBin, args, {
  stdio: ["inherit", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "1" },
  detached: true, // create process group so we can kill the tree
});

let hasFailed = false;
let sawSummary = false;

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const text = chunk.toString();
  if (text.includes("failed")) hasFailed = true;
  if (text.includes("Test Files")) sawSummary = true;
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

// Hard timeout — vitest hangs indefinitely after tests due to a known bug
const timer = setTimeout(() => {
  process.stderr.write(
    "\n[run-tests] vitest did not exit within timeout — forcing exit (vitest-dev/vitest#8766)\n",
  );
  try {
    // Kill the entire process group (vitest + its fork workers)
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  // Force our own exit after a brief delay
  setTimeout(() => process.exit(hasFailed ? 1 : 0), 500);
}, MAX_SECONDS * 1000);
timer.unref();

child.on("close", (code) => {
  clearTimeout(timer);
  if (sawSummary) {
    // vitest printed summary — trust its exit code
    process.exit(code ?? 0);
  }
  if (code === null || code === 137 || code === 143) {
    // Killed by us or timeout — decide from output
    process.exit(hasFailed ? 1 : 0);
  }
  process.exit(code ?? 1);
});
