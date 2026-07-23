import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptMarker,
  buildClaudePrompt,
  canStartFixAttempt,
  handledReviewMarker,
  hasMarker,
  isEligibleFix,
  isEligibleRequest,
  manualInterventionComment,
  markerComment,
  parseAttemptCount,
  requestMarker,
  reviewRequestComment,
  selectCodexThreadsToResolve,
} from "../src/orchestrator.mjs";

const sameRepositoryPullRequest = {
  number: 42,
  state: "open",
  draft: false,
  head: {
    sha: "abc123",
    ref: "feature/example",
    repo: { full_name: "jlixfeld/example" },
  },
  base: {
    repo: { full_name: "jlixfeld/example" },
  },
  user: { login: "jlixfeld" },
};

test("markers and generated marker comments are exact", () => {
  assert.equal(
    requestMarker(42, "abc123"),
    "<!-- codex-review-loop:request:42:abc123 -->",
  );
  assert.equal(
    handledReviewMarker("PRR_kwDOExample", "abc123"),
    "<!-- codex-review-loop:handled:PRR_kwDOExample:abc123 -->",
  );
  assert.equal(
    attemptMarker(42, 7),
    "<!-- codex-review-loop:attempt:42:7 -->",
  );
  assert.equal(
    markerComment(attemptMarker(42, 7)),
    "<!-- codex-review-loop:attempt:42:7 -->\n\n- Codex",
  );
  assert.equal(
    reviewRequestComment(42, "abc123"),
    "@codex review\n\n<!-- codex-review-loop:request:42:abc123 -->\n\n- Codex",
  );
});

test("marker matching is exact and idempotent", () => {
  const marker = requestMarker(42, "abc123");
  const comments = [
    { body: `prefix ${marker} suffix` },
    { body: markerComment(attemptMarker(42, 1)) },
  ];

  assert.equal(hasMarker(comments, marker), true);
  assert.equal(hasMarker(comments, requestMarker(43, "abc123")), false);
  assert.equal(hasMarker(comments, requestMarker(42, "def456")), false);
});

test("attempt parsing is scoped, distinct, and rejects malformed markers", () => {
  const bodies = [
    markerComment(attemptMarker(42, 1)),
    markerComment(attemptMarker(42, 1)),
    markerComment(attemptMarker(42, 3)),
    markerComment(attemptMarker(99, 9)),
    "<!-- codex-review-loop:attempt:42:not-a-number -->\n\n- Codex",
    "<!-- codex-review-loop:attempt:42:0 -->\n\n- Codex",
    "<!-- codex-review-loop:attempt:42:11 -->\n\n- Codex",
  ];

  assert.equal(parseAttemptCount(bodies, 42, 10), 2);
  assert.equal(parseAttemptCount(bodies, 99, 10), 1);
});

test("attempts one through ten are permitted and attempt eleven is denied", () => {
  for (let completed = 0; completed < 10; completed += 1) {
    assert.deepEqual(canStartFixAttempt(completed, 10), {
      allowed: true,
      attempt: completed + 1,
    });
  }

  assert.deepEqual(canStartFixAttempt(10, 10), {
    allowed: false,
    attempt: null,
  });
  assert.deepEqual(canStartFixAttempt(11, 10), {
    allowed: false,
    attempt: null,
  });
});

test("request eligibility requires an open non-draft pull request", () => {
  assert.equal(isEligibleRequest(sameRepositoryPullRequest), true);
  assert.equal(
    isEligibleRequest({ ...sameRepositoryPullRequest, state: "closed" }),
    false,
  );
  assert.equal(
    isEligibleRequest({ ...sameRepositoryPullRequest, draft: true }),
    false,
  );
});

test("fix eligibility enforces repository, trust, head, and findings", () => {
  const eligible = {
    pr: sameRepositoryPullRequest,
    authorPermission: "write",
    review: { commit_id: "abc123" },
    currentHeadSha: "abc123",
    findingCount: 1,
  };

  assert.equal(isEligibleFix(eligible), true);
  assert.equal(isEligibleFix({ ...eligible, authorPermission: "maintain" }), true);
  assert.equal(isEligibleFix({ ...eligible, authorPermission: "admin" }), true);
  assert.equal(isEligibleFix({ ...eligible, authorPermission: "read" }), false);
  assert.equal(isEligibleFix({ ...eligible, findingCount: 0 }), false);
  assert.equal(
    isEligibleFix({
      ...eligible,
      review: { commit_id: "stale" },
    }),
    false,
  );
  assert.equal(
    isEligibleFix({
      ...eligible,
      pr: {
        ...sameRepositoryPullRequest,
        head: {
          ...sameRepositoryPullRequest.head,
          repo: { full_name: "contributor/example" },
        },
      },
    }),
    false,
  );
});

test("only superseded unresolved Codex-rooted threads are selected", () => {
  const threads = [
    thread("old-codex", "ChatGPT-Codex-Connector[bot]", "OLD_REVIEW"),
    thread("latest-codex", "chatgpt-codex-connector[bot]", "LATEST_REVIEW"),
    thread("human", "jlixfeld", "OLD_REVIEW"),
    thread("other-bot", "other-reviewer[bot]", "OLD_REVIEW"),
    thread("resolved-codex", "chatgpt-codex-connector[bot]", "OLD_REVIEW", true),
  ];

  assert.deepEqual(
    selectCodexThreadsToResolve({
      threads,
      codexLogin: "chatgpt-codex-connector[bot]",
      latestReviewNodeId: "LATEST_REVIEW",
      clean: false,
    }),
    ["old-codex"],
  );
  assert.deepEqual(
    selectCodexThreadsToResolve({
      threads,
      codexLogin: "chatgpt-codex-connector[bot]",
      latestReviewNodeId: "LATEST_REVIEW",
      clean: true,
    }),
    ["old-codex", "latest-codex"],
  );
});

test("Claude prompt is complete and requires technical evaluation", () => {
  assert.equal(
    buildClaudePrompt({
      repository: "jlixfeld/example",
      prNumber: 42,
      reviewUrl: "https://github.com/jlixfeld/example/pull/42#pullrequestreview-123",
      attempt: 4,
      maxAttempts: 10,
    }),
    [
      "Address the latest native Codex review for jlixfeld/example pull request #42.",
      "Review: https://github.com/jlixfeld/example/pull/42#pullrequestreview-123",
      "This is fix attempt 4 of 10.",
      "",
      "Read every unresolved inline finding from that latest Codex review. Evaluate each finding technically; do not accept it automatically. Implement only justified fixes, and explain unsupported findings in your progress comment.",
      "",
      "For every behavior change, add or update a test that would have caught the problem. Run the repository's documented verification commands. Keep unrelated code unchanged. Commit and push the verified changes to the existing pull-request branch. Do not create a new pull request and do not merge.",
    ].join("\n"),
  );
});

test("manual intervention comment is concise, idempotent, and attributed", () => {
  assert.equal(
    manualInterventionComment({ prNumber: 42, maxAttempts: 10 }),
    [
      "Codex findings remain after 10 Claude fix attempts. The `codex-review` gate will stay failing until a new revision receives a clean Codex review. Manual intervention is required.",
      "",
      "<!-- codex-review-loop:limit:42:10 -->",
      "",
      "- Codex",
    ].join("\n"),
  );
});

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
