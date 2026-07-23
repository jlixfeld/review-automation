import assert from "node:assert/strict";
import test from "node:test";

import { runAction, writeOutputs } from "../src/index.mjs";

test("writeOutputs preserves the complete multiline prompt", async () => {
  const calls = [];
  const append = async (...args) => calls.push(args);
  const identifiers = ["one", "two"];

  await writeOutputs(
    "/tmp/github-output",
    {
      "should-fix": "true",
      prompt: "line one\nline two",
    },
    append,
    () => identifiers.shift(),
  );

  assert.deepEqual(calls, [
    [
      "/tmp/github-output",
      [
        "should-fix<<codex_one",
        "true",
        "codex_one",
        "prompt<<codex_two",
        "line one",
        "line two",
        "codex_two",
        "",
      ].join("\n"),
      "utf8",
    ],
  ]);
});

test("codex-login rejects wildcard actor configuration", async () => {
  await assert.rejects(
    runAction({
      env: {
        GITHUB_EVENT_NAME: "pull_request_review",
        INPUT_CODEX_LOGIN: "*",
      },
      event: {
        action: "submitted",
        review: { user: { login: "chatgpt-codex-connector[bot]" } },
      },
      client: {},
    }),
    /one exact GitHub login/,
  );
});
