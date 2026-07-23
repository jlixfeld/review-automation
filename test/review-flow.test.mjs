import assert from "node:assert/strict";
import test from "node:test";

import { runAction } from "../src/index.mjs";
import {
  attemptMarker,
  handledReviewMarker,
  markerComment,
} from "../src/orchestrator.mjs";

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
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
const review = {
  id: 123,
  node_id: "LATEST_REVIEW",
  user: { login: CODEX_LOGIN },
  commit_id: "abc123",
  html_url:
    "https://github.com/jlixfeld/example/pull/42#pullrequestreview-123",
};
const reviewEvent = {
  action: "submitted",
  pull_request: {
    number: 42,
    head: { sha: "abc123", ref: "feature/example" },
  },
  review,
};

test("clean review resolves Codex threads and marks the current SHA successful", async () => {
  const client = fakeClient({
    reviewComments: [],
    threads: [
      thread("old-codex", CODEX_LOGIN, "OLD_REVIEW"),
      thread("human", "jlixfeld", "OLD_REVIEW"),
    ],
  });

  const result = await runReview(client);

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
    ["listReviewComments", 42, 123],
    ["listReviewThreads", 42],
    ["resolveReviewThread", "old-codex"],
    [
      "postIssueComment",
      42,
      markerComment(handledReviewMarker("LATEST_REVIEW", "abc123")),
    ],
    [
      "createCommitStatus",
      "abc123",
      "success",
      "PR #42 passed the current native Codex review",
    ],
  ]);
});

test("finding review fails the gate and emits the complete Claude prompt", async () => {
  const client = fakeClient({
    reviewComments: [{ id: 501, body: "High-confidence finding" }],
    threads: [
      thread("old-codex", CODEX_LOGIN, "OLD_REVIEW"),
      thread("latest-codex", CODEX_LOGIN, "LATEST_REVIEW"),
    ],
    permission: "write",
  });

  const result = await runReview(client);

  assert.deepEqual(result, {
    "should-fix": "true",
    "pr-number": "42",
    "head-ref": "feature/example",
    prompt: [
      "Address the latest native Codex review for jlixfeld/example pull request #42.",
      "Review: https://github.com/jlixfeld/example/pull/42#pullrequestreview-123",
      "This is fix attempt 1 of 10.",
      "",
      "Read the review summary and every unresolved inline finding from that latest Codex review. Evaluate each finding technically; do not accept it automatically. Implement only justified fixes, and explain unsupported findings in your progress comment.",
      "",
      "For every behavior change, add or update a test that would have caught the problem. Run the repository's documented verification commands. Keep unrelated code unchanged. Commit and push the verified changes to the existing pull-request branch. If no code changes are justified, explain the rebuttal, then create and push an empty commit so the current conclusion receives a fresh Codex review. Do not create a new pull request and do not merge.",
    ].join("\n"),
    attempt: "1",
  });
  assert.deepEqual(client.calls, [
    ["getPullRequest", 42],
    ["listIssueComments", 42],
    ["listReviewComments", 42, 123],
    ["listReviewThreads", 42],
    [
      "createCommitStatus",
      "abc123",
      "failure",
      "PR #42 has unresolved native Codex findings",
    ],
    ["getCollaboratorPermission", "jlixfeld"],
    [
      "postIssueComment",
      42,
      [
        "<!-- codex-review-loop:handled:LATEST_REVIEW:abc123 -->",
        "<!-- codex-review-loop:attempt:42:1 -->",
        "",
        "- Codex",
      ].join("\n"),
    ],
  ]);
});

test("changes-requested review without inline comments fails closed", async () => {
  const client = fakeClient({
    reviewComments: [],
    threads: [thread("old-codex", CODEX_LOGIN, "OLD_REVIEW")],
    permission: "write",
  });
  const result = await runReview(client, {
    ...reviewEvent,
    review: {
      ...review,
      state: "changes_requested",
      body: "The migration can delete newer rows.",
    },
  });

  assert.equal(result["should-fix"], "true");
  assert.match(result.prompt, /Read the review summary/);
  assert.equal(
    client.calls.some(([method]) => method === "resolveReviewThread"),
    false,
  );
  assert.ok(
    client.calls.some(
      ([method, sha, state]) =>
        method === "createCommitStatus" &&
        sha === "abc123" &&
        state === "failure",
    ),
  );
});

test("attempts one through ten run, but an eleventh attempt cannot run", async () => {
  for (let priorAttempts = 0; priorAttempts <= 10; priorAttempts += 1) {
    const comments = [
      ...Array.from({ length: priorAttempts }, (_, index) =>
        automationComment(markerComment(attemptMarker(42, index + 1))),
      ),
      {
        user: { login: "jlixfeld" },
        body: markerComment(attemptMarker(42, 10)),
      },
      {
        user: { login: "jlixfeld" },
        body: "<!-- codex-review-loop:limit:42:10 -->",
      },
    ];
    const client = fakeClient({
      comments,
      reviewComments: [{ id: 501 }],
      permission: "write",
    });

    const result = await runReview(client);

    if (priorAttempts < 10) {
      assert.equal(result["should-fix"], "true");
      assert.equal(result.attempt, String(priorAttempts + 1));
    } else {
      assert.equal(result["should-fix"], "false");
      assert.equal(result.attempt, "");
      assert.ok(
        client.calls.some(
          ([method, , body]) =>
            method === "postIssueComment" &&
            body.includes("Manual intervention is required.") &&
            body.endsWith("- Codex"),
        ),
      );
    }
  }
});

test("wrong actor is ignored without calling GitHub", async () => {
  const client = fakeClient();
  const result = await runReview(client, {
    ...reviewEvent,
    review: { ...review, user: { login: "other-reviewer[bot]" } },
  });

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(client.calls, []);
});

test("stale review and stale event SHA are ignored", async () => {
  for (const event of [
    { ...reviewEvent, review: { ...review, commit_id: "stale" } },
    {
      ...reviewEvent,
      pull_request: {
        ...reviewEvent.pull_request,
        head: { ...reviewEvent.pull_request.head, sha: "stale" },
      },
    },
  ]) {
    const client = fakeClient();
    const result = await runReview(client, event);

    assert.equal(result["should-fix"], "false");
    assert.deepEqual(client.calls, [["getPullRequest", 42]]);
  }
});

test("an already handled review repairs terminal status but never reinvokes Claude", async () => {
  const client = fakeClient({
    comments: [
      automationComment(
        markerComment(handledReviewMarker("LATEST_REVIEW", "abc123")),
      ),
    ],
    reviewComments: [{ id: 501 }],
  });

  const result = await runReview(client);

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(client.calls, [
    ["getPullRequest", 42],
    ["listIssueComments", 42],
    ["listReviewComments", 42, 123],
    [
      "createCommitStatus",
      "abc123",
      "failure",
      "PR #42 has unresolved native Codex findings",
    ],
  ]);
});

test("a pull-request author cannot spoof a handled-review marker", async () => {
  const client = fakeClient({
    comments: [
      {
        user: { login: "jlixfeld" },
        body: markerComment(
          handledReviewMarker("LATEST_REVIEW", "abc123"),
        ),
      },
    ],
    reviewComments: [{ id: 501 }],
    permission: "write",
  });

  const result = await runReview(client);

  assert.equal(result["should-fix"], "true");
  assert.equal(result.attempt, "1");
});

test("fork findings never request permission, credentials, or Claude fixes", async () => {
  const forkPr = {
    ...pullRequest,
    head: {
      ...pullRequest.head,
      repo: { full_name: "contributor/example" },
    },
  };
  const client = fakeClient({
    pr: forkPr,
    reviewComments: [{ id: 501 }],
  });

  const result = await runReview(client);

  assert.equal(result["should-fix"], "false");
  assert.equal(
    client.calls.some(([method]) => method === "getCollaboratorPermission"),
    false,
  );
  assert.equal(
    client.calls.some(
      ([method, , body]) =>
        method === "postIssueComment" &&
        body.includes("codex-review-loop:attempt"),
    ),
    false,
  );
});

test("untrusted authors cannot trigger Claude", async () => {
  const client = fakeClient({
    reviewComments: [{ id: 501 }],
    permission: "read",
  });

  const result = await runReview(client);

  assert.equal(result["should-fix"], "false");
  assert.deepEqual(
    client.calls.filter(([method]) => method === "getCollaboratorPermission"),
    [["getCollaboratorPermission", "jlixfeld"]],
  );
  assert.equal(
    client.calls.some(
      ([method, , body]) =>
        method === "postIssueComment" &&
        body.includes("codex-review-loop:attempt"),
    ),
    false,
  );
});

test("thread resolution failures keep the gate failing and never report success", async () => {
  const client = fakeClient({
    reviewComments: [],
    threadsError: new Error("GraphQL unavailable"),
  });

  await assert.rejects(runReview(client), /GraphQL unavailable/);
  assert.deepEqual(client.calls.at(-1), [
    "createCommitStatus",
    "abc123",
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

test("a failed success-status write is replaced with a failure status", async () => {
  const client = fakeClient({
    reviewComments: [],
    failSuccessStatus: true,
  });

  await assert.rejects(runReview(client), /success status failed/);
  assert.deepEqual(client.calls.slice(-2), [
    [
      "createCommitStatus",
      "abc123",
      "success",
      "PR #42 passed the current native Codex review",
    ],
    [
      "createCommitStatus",
      "abc123",
      "failure",
      "PR #42 review orchestration failed; manual intervention required",
    ],
  ]);
});

async function runReview(client, event = reviewEvent) {
  return runAction({
    env: {
      GITHUB_EVENT_NAME: "pull_request_review",
      GITHUB_REPOSITORY: "jlixfeld/example",
      INPUT_CODEX_LOGIN: CODEX_LOGIN,
      INPUT_MAX_FIX_ATTEMPTS: "10",
    },
    event,
    client,
  });
}

function fakeClient({
  pr = pullRequest,
  comments = [],
  reviewComments = [],
  threads = [],
  permission = "write",
  threadsError,
  failSuccessStatus = false,
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
    async listReviewComments(...args) {
      calls.push(["listReviewComments", ...args]);
      return reviewComments;
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
    async getCollaboratorPermission(login) {
      calls.push(["getCollaboratorPermission", login]);
      return permission;
    },
    async createCommitStatus(...args) {
      calls.push(["createCommitStatus", ...args]);
      if (failSuccessStatus && args[1] === "success") {
        throw new Error("success status failed");
      }
    },
    async postIssueComment(...args) {
      calls.push(["postIssueComment", ...args]);
    },
  };
}

function thread(id, login, reviewId, isResolved = false) {
  return {
    id,
    isResolved,
    comments: {
      nodes: [
        {
          author: { login },
          pullRequestReview: { id: reviewId },
        },
      ],
    },
  };
}

function automationComment(body) {
  return {
    user: { login: "github-actions[bot]" },
    body,
  };
}
