import assert from "node:assert/strict";
import test from "node:test";

import { runAction } from "../src/index.mjs";

const pullRequest = {
  number: 42,
  state: "open",
  draft: false,
  head: {
    sha: "abc123",
    ref: "feature/example",
    repo: { full_name: "jlixfeld/example" },
  },
  base: { repo: { full_name: "jlixfeld/example" } },
  user: { login: "jlixfeld" },
};

const requestEvent = {
  action: "synchronize",
  pull_request: {
    number: 42,
    head: { sha: "abc123" },
  },
};

test("request event sets pending and relies on native auto-review", async () => {
  const client = fakeClient({ pr: pullRequest, comments: [] });

  const result = await runAction({
    env: { GITHUB_EVENT_NAME: "pull_request_target" },
    event: requestEvent,
    client,
  });

  assert.deepEqual(result, {
    "should-fix": "false",
    "pr-number": "42",
    "head-ref": "feature/example",
    prompt: "",
    attempt: "",
  });
  assert.deepEqual(client.calls, [
    ["getPullRequest", 42],
    [
      "createCommitStatus",
      "abc123",
      "pending",
      "PR #42 is awaiting the current native Codex review",
    ],
  ]);
});

test("request retries refresh pending without posting comments", async () => {
  const client = fakeClient({ pr: pullRequest, comments: [] });

  const result = await runAction({
    env: { GITHUB_EVENT_NAME: "pull_request_target" },
    event: requestEvent,
    client,
  });

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(client.calls, [
    ["getPullRequest", 42],
    [
      "createCommitStatus",
      "abc123",
      "pending",
      "PR #42 is awaiting the current native Codex review",
    ],
  ]);
});

test("closed and draft pull requests are ignored", async () => {
  for (const pr of [
    { ...pullRequest, state: "closed" },
    { ...pullRequest, draft: true },
  ]) {
    const client = fakeClient({ pr, comments: [] });
    const result = await runAction({
      env: { GITHUB_EVENT_NAME: "pull_request_target" },
      event: requestEvent,
      client,
    });

    assert.equal(result["should-fix"], "false");
    assert.deepEqual(client.calls, [["getPullRequest", 42]]);
  }
});

test("stale request events cannot modify the current head status", async () => {
  const client = fakeClient({
    pr: { ...pullRequest, head: { ...pullRequest.head, sha: "new-head" } },
    comments: [],
  });

  const result = await runAction({
    env: { GITHUB_EVENT_NAME: "pull_request_target" },
    event: requestEvent,
    client,
  });

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(client.calls, [["getPullRequest", 42]]);
});

test("unsupported request actions are ignored before calling GitHub", async () => {
  const client = fakeClient({ pr: pullRequest, comments: [] });

  const result = await runAction({
    env: { GITHUB_EVENT_NAME: "pull_request_target" },
    event: { ...requestEvent, action: "closed" },
    client,
  });

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(client.calls, []);
});

function fakeClient({ pr, comments }) {
  const calls = [];
  return {
    calls,
    async getPullRequest(number) {
      calls.push(["getPullRequest", number]);
      return pr;
    },
    async createCommitStatus(...args) {
      calls.push(["createCommitStatus", ...args]);
    },
  };
}
