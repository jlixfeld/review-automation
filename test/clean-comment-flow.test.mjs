import assert from "node:assert/strict";
import test from "node:test";

import { runAction } from "../src/index.mjs";
import {
  handledReviewMarker,
  markerComment,
} from "../src/orchestrator.mjs";

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const pullRequest = {
  number: 42,
  state: "open",
  draft: false,
  head: {
    sha: HEAD_SHA,
    ref: "feature/example",
    repo: { full_name: "jlixfeld/example" },
  },
  base: { repo: { full_name: "jlixfeld/example" } },
  user: { login: "jlixfeld" },
};
const cleanComment = {
  id: 501,
  node_id: "CLEAN_COMMENT",
  user: { login: CODEX_LOGIN },
  body: [
    "Codex Review: Didn't find any major issues. Breezy!",
    "",
    "**Reviewed commit:** `0123456789`",
  ].join("\n"),
};
const cleanEvent = {
  action: "created",
  issue: { number: 42, pull_request: {} },
  comment: cleanComment,
};

test("clean current-head comment resolves Codex threads and marks success", async () => {
  const client = fakeClient({
    threads: [
      thread("old-codex", CODEX_LOGIN),
      thread("human", "jlixfeld"),
    ],
  });

  const result = await runCleanComment(client);

  assert.deepEqual(result, {
    "should-fix": "false",
    "pr-number": "42",
    "head-ref": "feature/example",
    prompt: "",
    attempt: "",
  });
  assert.deepEqual(client.calls, [
    ["getPullRequest", 42],
    ["listIssueComments", 42],
    ["listReviewThreads", 42],
    ["resolveReviewThread", "old-codex"],
    [
      "postIssueComment",
      42,
      markerComment(handledReviewMarker("CLEAN_COMMENT", HEAD_SHA)),
    ],
    [
      "createCommitStatus",
      HEAD_SHA,
      "success",
      "PR #42 passed the current native Codex review",
    ],
  ]);
});

test("stale clean comments and non-Codex comments are ignored", async () => {
  const staleClient = fakeClient();
  const stale = await runCleanComment(staleClient, {
    ...cleanEvent,
    comment: {
      ...cleanComment,
      body: cleanComment.body.replace("0123456789", "aaaaaaaaaa"),
    },
  });
  assert.equal(stale["should-fix"], "false");
  assert.deepEqual(staleClient.calls, [["getPullRequest", 42]]);

  const otherClient = fakeClient();
  const other = await runCleanComment(otherClient, {
    ...cleanEvent,
    comment: {
      ...cleanComment,
      user: { login: "other-reviewer[bot]" },
    },
  });
  assert.equal(other["should-fix"], "false");
  assert.deepEqual(otherClient.calls, []);
});

test("thread resolution failure cannot produce a clean status", async () => {
  const client = fakeClient({
    threadsError: new Error("GraphQL unavailable"),
  });

  await assert.rejects(runCleanComment(client), /GraphQL unavailable/);
  assert.deepEqual(client.calls.at(-1), [
    "createCommitStatus",
    HEAD_SHA,
    "failure",
    "PR #42 review orchestration failed; manual intervention required",
  ]);
  assert.equal(
    client.calls.some(
      ([method, , state]) =>
        method === "createCommitStatus" && state === "success",
    ),
    false,
  );
});

async function runCleanComment(client, event = cleanEvent) {
  return runAction({
    env: {
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_REPOSITORY: "jlixfeld/example",
      INPUT_CODEX_LOGIN: CODEX_LOGIN,
    },
    event,
    client,
  });
}

function fakeClient({
  pr = pullRequest,
  comments = [],
  threads = [],
  threadsError,
} = {}) {
  const calls = [];
  return {
    calls,
    async getPullRequest(number) {
      calls.push(["getPullRequest", number]);
      return pr;
    },
    async listIssueComments(number) {
      calls.push(["listIssueComments", number]);
      return comments;
    },
    async listReviewThreads(number) {
      calls.push(["listReviewThreads", number]);
      if (threadsError) {
        throw threadsError;
      }
      return threads;
    },
    async resolveReviewThread(id) {
      calls.push(["resolveReviewThread", id]);
    },
    async postIssueComment(...args) {
      calls.push(["postIssueComment", ...args]);
    },
    async createCommitStatus(...args) {
      calls.push(["createCommitStatus", ...args]);
    },
  };
}

function thread(id, login, isResolved = false) {
  return {
    id,
    isResolved,
    comments: {
      nodes: [{ author: { login } }],
    },
  };
}
