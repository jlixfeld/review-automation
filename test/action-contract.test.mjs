import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("package exposes the dependency-free Node test command", async () => {
  const packageJson = await readJson(new URL("../package.json", import.meta.url));

  assert.deepEqual(packageJson, {
    name: "@jlixfeld/review-automation",
    private: true,
    type: "module",
    scripts: {
      test: "node --test",
    },
  });
});

test("action metadata declares the stable Node 20 contract", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");

  assert.match(action, /^name: Codex review orchestrator$/m);
  assert.deepEqual(
    [...action.matchAll(/^  ([a-z][a-z-]+):$/gm)].map((match) => match[1]),
    ["github-token", "codex-login", "max-fix-attempts"],
  );
  assert.match(action, /^runs:\n  using: node20\n  main: src\/index\.mjs$/m);
});

test("constants expose the exact stable values", async () => {
  const constants = await import("../src/constants.mjs");

  assert.deepEqual(
    {
      context: constants.CODEX_REVIEW_CONTEXT,
      login: constants.DEFAULT_CODEX_LOGIN,
      attempts: constants.MAX_FIX_ATTEMPTS,
      marker: constants.MARKER_PREFIX,
    },
    {
      context: "codex-review",
      login: "chatgpt-codex-connector[bot]",
      attempts: 10,
      marker: "codex-review-loop",
    },
  );
});
