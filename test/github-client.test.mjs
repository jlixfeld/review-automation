import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubClient,
  REVIEW_THREADS_QUERY,
  RESOLVE_THREAD_MUTATION,
} from "../src/github-client.mjs";

const TOKEN = "test-token";
const REPOSITORY = "jlixfeld/example";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "jlixfeld-review-automation",
  "X-GitHub-Api-Version": "2022-11-28",
};

test("getPullRequest sends the exact REST request", async () => {
  const pr = { number: 42, state: "open" };
  const fake = fakeFetch([jsonResponse(pr)]);
  const client = makeClient(fake);

  assert.deepEqual(await client.getPullRequest(42), pr);
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/pulls/42",
      { method: "GET", headers: API_HEADERS },
    ],
  ]);
});

test("getCollaboratorPermission returns the exact permission", async () => {
  const fake = fakeFetch([jsonResponse({ permission: "write" })]);
  const client = makeClient(fake);

  assert.equal(await client.getCollaboratorPermission("trusted-user"), "write");
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/collaborators/trusted-user/permission",
      { method: "GET", headers: API_HEADERS },
    ],
  ]);
});

test("listIssueComments paginates with exact REST requests", async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: `comment ${index + 1}`,
  }));
  const pageTwo = [{ id: 101, body: "last comment" }];
  const fake = fakeFetch([jsonResponse(pageOne), jsonResponse(pageTwo)]);
  const client = makeClient(fake);

  const comments = await client.listIssueComments(42);

  assert.equal(comments.length, 101);
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/issues/42/comments?per_page=100&page=1",
      { method: "GET", headers: API_HEADERS },
    ],
    [
      "https://api.github.com/repos/jlixfeld/example/issues/42/comments?per_page=100&page=2",
      { method: "GET", headers: API_HEADERS },
    ],
  ]);
});

test("postIssueComment sends the complete attributed body", async () => {
  const body =
    "<!-- codex-review-loop:handled:PRR_123:abc123 -->\n\n- Codex";
  const fake = fakeFetch([jsonResponse({ id: 9001 }, 201)]);
  const client = makeClient(fake);

  assert.deepEqual(await client.postIssueComment(42, body), { id: 9001 });
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/issues/42/comments",
      {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({ body }),
      },
    ],
  ]);
});

test("createCommitStatus sends the exact gate payload", async () => {
  const fake = fakeFetch([jsonResponse({ id: 77 }, 201)]);
  const client = makeClient(fake);

  await client.createCommitStatus(
    "abc123",
    "failure",
    "PR #42 has Codex findings; Claude attempt 4 of 10",
  );

  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/statuses/abc123",
      {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          state: "failure",
          context: "codex-review",
          description: "PR #42 has Codex findings; Claude attempt 4 of 10",
        }),
      },
    ],
  ]);
});

test("listReviewComments paginates and scopes comments to one review", async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    pull_request_review_id: 123,
  }));
  const pageTwo = [{ id: 101, pull_request_review_id: 123 }];
  const fake = fakeFetch([jsonResponse(pageOne), jsonResponse(pageTwo)]);
  const client = makeClient(fake);

  const comments = await client.listReviewComments(42, 123);

  assert.equal(comments.length, 101);
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/repos/jlixfeld/example/pulls/42/reviews/123/comments?per_page=100&page=1",
      { method: "GET", headers: API_HEADERS },
    ],
    [
      "https://api.github.com/repos/jlixfeld/example/pulls/42/reviews/123/comments?per_page=100&page=2",
      { method: "GET", headers: API_HEADERS },
    ],
  ]);
});

test("listReviewThreads paginates with complete GraphQL variables", async () => {
  const firstNodes = Array.from({ length: 100 }, (_, index) => ({
    id: `thread-${index + 1}`,
    isResolved: false,
    comments: { nodes: [] },
  }));
  const finalNode = {
    id: "thread-101",
    isResolved: false,
    comments: { nodes: [] },
  };
  const fake = fakeFetch([
    graphqlResponse(firstNodes, true, "cursor-100"),
    graphqlResponse([finalNode], false, null),
  ]);
  const client = makeClient(fake);

  const threads = await client.listReviewThreads(42);

  assert.equal(threads.length, 101);
  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: {
            owner: "jlixfeld",
            name: "example",
            number: 42,
            cursor: null,
          },
        }),
      },
    ],
    [
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: {
            owner: "jlixfeld",
            name: "example",
            number: 42,
            cursor: "cursor-100",
          },
        }),
      },
    ],
  ]);
});

test("resolveReviewThread sends the exact GraphQL mutation", async () => {
  const fake = fakeFetch([
    jsonResponse({
      data: {
        resolveReviewThread: {
          thread: { id: "thread-9", isResolved: true },
        },
      },
    }),
  ]);
  const client = makeClient(fake);

  await client.resolveReviewThread("thread-9");

  assert.deepEqual(fake.calls, [
    [
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          query: RESOLVE_THREAD_MUTATION,
          variables: { threadId: "thread-9" },
        }),
      },
    ],
  ]);
});

test("REST failures include status and endpoint without exposing the token", async () => {
  const fake = fakeFetch([
    jsonResponse({ message: "Forbidden" }, 403, "Forbidden"),
  ]);
  const client = makeClient(fake);

  await assert.rejects(
    client.getPullRequest(42),
    (error) =>
      error.message ===
        "GitHub REST GET /repos/jlixfeld/example/pulls/42 failed: 403 Forbidden" &&
      !error.message.includes(TOKEN),
  );
});

test("GraphQL errors fail closed", async () => {
  const fake = fakeFetch([
    jsonResponse({ errors: [{ message: "Something failed" }] }),
  ]);
  const client = makeClient(fake);

  await assert.rejects(
    client.listReviewThreads(42),
    /GitHub GraphQL failed: Something failed/,
  );
});

test("missing required response fields fail explicitly", async () => {
  const permissionClient = makeClient(fakeFetch([jsonResponse({})]));
  await assert.rejects(
    permissionClient.getCollaboratorPermission("trusted-user"),
    /missing permission/,
  );

  const threadClient = makeClient(
    fakeFetch([jsonResponse({ data: { repository: null } })]),
  );
  await assert.rejects(
    threadClient.listReviewThreads(42),
    /missing pull request review threads/,
  );
});

function makeClient(fetchImpl) {
  return new GitHubClient({
    token: TOKEN,
    repository: REPOSITORY,
    fetchImpl,
  });
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    const response = responses.shift();
    assert.ok(response, `unexpected fetch call: ${args[0]}`);
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(body, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function graphqlResponse(nodes, hasNextPage, endCursor) {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    },
  });
}
