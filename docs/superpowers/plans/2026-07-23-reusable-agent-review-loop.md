# Reusable Agent Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and roll out a centrally maintained GitHub Actions loop that requests read-only native Codex reviews, lets Claude fix justified findings, and blocks merging through a `codex-review` commit status until the current revision is clean.

**Architecture:** A dependency-free JavaScript action in `jlixfeld/review-automation` owns orchestration and GitHub API calls. A reusable workflow exposes it to thin per-repository callers, then conditionally invokes `anthropics/claude-code-action@v1` with an explicit secret. Hidden issue-comment markers make review requests, handled reviews, and the ten-attempt counter durable and idempotent. Target repositories receive only a caller workflow and an exact `AGENTS.md` review-rules section.

**Tech Stack:** Node.js 20 ESM, built-in `node:test`, GitHub REST and GraphQL APIs via `fetch`, GitHub Actions reusable workflows, `anthropics/claude-code-action@v1`, GitHub CLI, Infisical.

## Global Constraints

- Implement only on `feature/reusable-agent-review-loop` in the isolated worktree.
- Keep native Codex review read-only; the orchestrator never edits a PR branch.
- Never pass Claude credentials to a fork-originated PR.
- Permit Claude attempts 1 through 10 and never an eleventh attempt.
- Every generated GitHub comment must end with a separate `- Codex` footer.
- Treat the PR's current head SHA as authoritative; stale events cannot change its status.
- Keep the `codex-review` status failing if thread resolution or orchestration fails.
- Do not make `codex-review` required in a target repository until that repository has produced a successful live canary status.
- Preserve all existing deterministic checks and all unrelated branch-protection settings.
- Use `apply_patch` for edits and `uv` for any Python execution.

---

## Task 1: Establish the Node action contract

**Files:**

- Create: `package.json`
- Create: `action.yml`
- Create: `src/constants.mjs`
- Create: `test/action-contract.test.mjs`

**Interface:**

```js
export const CODEX_REVIEW_CONTEXT = "codex-review";
export const DEFAULT_CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const MAX_FIX_ATTEMPTS = 10;
export const MARKER_PREFIX = "codex-review-loop";
```

- [ ] Write `test/action-contract.test.mjs` first. Assert the package runs `node --test`, the action uses `node20`, the entrypoint is `src/index.mjs`, and the action declares only the required inputs: `github-token`, `codex-login`, and `max-fix-attempts`.
- [ ] Run `node --test test/action-contract.test.mjs` and verify it fails because the contract files do not exist.
- [ ] Add the minimal `package.json`, `action.yml`, and constants needed to satisfy the test.
- [ ] Run `node --test test/action-contract.test.mjs` and verify it passes.
- [ ] Commit with `git commit -m "feat: define review orchestration action contract"`.

## Task 2: Implement pure marker, eligibility, and prompt logic

**Files:**

- Create: `src/orchestrator.mjs`
- Create: `test/orchestrator.test.mjs`

**Interfaces:**

```js
export function requestMarker(prNumber, headSha) {}
export function handledReviewMarker(reviewNodeId, headSha) {}
export function attemptMarker(prNumber, attempt) {}
export function parseAttemptCount(commentBodies, prNumber) {}
export function isEligibleRequest(pr) {}
export function isEligibleFix({ pr, authorPermission, review, currentHeadSha, findingCount }) {}
export function selectCodexThreadsToResolve({ threads, codexLogin, latestReviewNodeId, clean }) {}
export function buildClaudePrompt({ repository, prNumber, reviewUrl, attempt, maxAttempts }) {}
export function manualInterventionComment({ prNumber, maxAttempts }) {}
```

- [ ] Write failing tests for exact marker strings, request-marker idempotency, handled-review idempotency, malformed marker rejection, and attempt counts scoped to one PR.
- [ ] Add failing tests proving attempts 1 through 10 are permitted and attempt 11 is denied.
- [ ] Add failing tests for open/non-draft request eligibility, same-repository enforcement, trusted-author enforcement, current-head matching, finding detection, and stale review rejection.
- [ ] Add failing tests proving only unresolved threads rooted by the configured Codex actor are selected; human and other-bot threads are never selected.
- [ ] Add failing tests asserting the complete Claude prompt and manual-intervention comment, including the separate `- Codex` footer in generated comments.
- [ ] Run `node --test test/orchestrator.test.mjs` and verify the expected failures.
- [ ] Implement the smallest pure functions that pass the tests. Normalize GitHub logins case-insensitively, but do not accept wildcard identities.
- [ ] Run `node --test test/orchestrator.test.mjs` and verify it passes.
- [ ] Commit with `git commit -m "feat: add review loop decision logic"`.

## Task 3: Implement the GitHub boundary

**Files:**

- Create: `src/github-client.mjs`
- Create: `test/github-client.test.mjs`

**Interface:**

```js
export class GitHubClient {
  constructor({ token, repository, fetchImpl = fetch }) {}
  async getPullRequest(prNumber) {}
  async getCollaboratorPermission(login) {}
  async listIssueComments(prNumber) {}
  async postIssueComment(prNumber, body) {}
  async createCommitStatus(sha, state, description) {}
  async listReviewComments(prNumber, reviewId) {}
  async listReviewThreads(prNumber) {}
  async resolveReviewThread(threadId) {}
}
```

- [ ] Write tests with a fake `fetchImpl` that assert the complete method, URL, headers, and body for every REST request.
- [ ] Assert commit-status bodies exactly contain `state`, `context: "codex-review"`, and the expected description.
- [ ] Assert issue comments preserve hidden markers and end with the `- Codex` footer.
- [ ] Write GraphQL pagination tests for more than 100 review threads and assert the complete query variables for each page.
- [ ] Assert `resolveReviewThread` sends the exact mutation and thread ID.
- [ ] Add failing-path tests for non-2xx REST responses, GraphQL `errors`, and missing response fields.
- [ ] Run `node --test test/github-client.test.mjs` and verify it fails before implementation.
- [ ] Implement the dependency-free client and explicit error messages without logging tokens or response headers.
- [ ] Run `node --test test/github-client.test.mjs` and verify it passes.
- [ ] Commit with `git commit -m "feat: add GitHub API client"`.

## Task 4: Implement clean-comment orchestration

**Files:**

- Create: `src/index.mjs`
- Create: `test/clean-comment-flow.test.mjs`

**Clean flow:**

```text
issue_comment.created event
  -> require exact native Codex author
  -> parse reviewed commit from the clean summary
  -> fetch authoritative PR
  -> reject draft/closed/stale commit
  -> resolve prior Codex threads
  -> set current head status success
  -> output should-fix=false
```

- [ ] Refactor the action entrypoint to export `runAction({ env, event, client, output })` so tests do not spawn a process.
- [ ] Write a failing happy-path test asserting thread resolution and the exact success status.
- [ ] Add failing tests for non-Codex comments, stale reviewed commits, retries, and resolution failure.
- [ ] Assert in every test that clean-comment handling never returns `should-fix=true`.
- [ ] Run `node --test test/clean-comment-flow.test.mjs` and verify it fails.
- [ ] Implement clean-comment handling using the authoritative PR returned by GitHub.
- [ ] Run `node --test test/clean-comment-flow.test.mjs` and verify it passes.
- [ ] Commit with `git commit -m "feat: handle clean Codex review comments"`.

## Task 5: Implement review-event orchestration

**Files:**

- Modify: `src/index.mjs`
- Create: `test/review-flow.test.mjs`

**Review flow:**

```text
pull_request_review submitted
  -> verify exact Codex actor and current head
  -> skip an existing handled marker
  -> count inline findings belonging to that review
  -> resolve only superseded Codex threads
  -> clean: mark handled + status success
  -> findings: mark handled + status failure
     -> attempts < 10: record next attempt + output Claude prompt
     -> attempts == 10: post one manual-intervention comment
```

- [ ] Write a failing clean-review test asserting older Codex threads resolve, the handled marker is posted, no Claude prompt is produced, and the current SHA receives `success`.
- [ ] Write a failing findings test asserting the latest Codex threads remain open, older Codex threads resolve, failure is written before the attempt marker, and the complete Claude prompt is output.
- [ ] Write a table test for attempts 1–10 and prove that a review after attempt 10 cannot invoke Claude.
- [ ] Add stale SHA, wrong actor, duplicate review, human-thread, fork, untrusted-author, GraphQL failure, and status-write failure tests.
- [ ] Assert no clean success can be written after a thread-resolution error.
- [ ] Assert a fork PR may retain Codex findings but always produces `should-fix=false` and receives no attempt marker.
- [ ] Run `node --test test/review-flow.test.mjs` and verify it fails.
- [ ] Implement review handling and the action's `GITHUB_OUTPUT` writer.
- [ ] Add a thin process entry that reads `GITHUB_EVENT_PATH`, validates inputs, emits GitHub workflow errors, and exits nonzero on orchestration failure.
- [ ] Run `node --test test/review-flow.test.mjs` and the full `node --test`; verify both pass.
- [ ] Commit with `git commit -m "feat: orchestrate Codex review outcomes"`.

## Task 6: Add the reusable workflow and caller template

**Files:**

- Create: `.github/workflows/review-loop.yml`
- Create: `.github/workflows/ci.yml`
- Create: `templates/agent-review-loop.yml`
- Create: `test/workflow-contract.test.mjs`

**Reusable outputs:**

```yaml
outputs:
  should-fix:
  pr-number:
  head-ref:
  prompt:
  attempt:
```

- [ ] Write failing tests that parse the workflow files as text and assert supported events, explicit permissions, named secret passing, exact Codex bot allowlist, and no `secrets: inherit`.
- [ ] Assert the reusable workflow invokes the central action, invokes Claude only when `should-fix == 'true'`, and passes the complete action-generated prompt.
- [ ] Assert the caller handles `pull_request_review.submitted` and `issue_comment.created`.
- [ ] Assert the caller does not expose `pull_request_target`.
- [ ] Run `node --test test/workflow-contract.test.mjs` and verify it fails.
- [ ] Implement the reusable workflow, CI workflow, and thin caller template with least-privilege job permissions.
- [ ] Pin third-party actions to reviewed immutable commit SHAs where practical; document any intentional stable-major pin.
- [ ] Run the full `node --test` suite and a YAML parser/actionlint validation.
- [ ] Commit with `git commit -m "feat: add reusable review loop workflow"`.

## Task 7: Add bootstrap and rollout tooling

**Files:**

- Create: `scripts/bootstrap-repo.mjs`
- Create: `src/bootstrap.mjs`
- Create: `test/bootstrap.test.mjs`
- Create: `templates/code-review-rules.md`
- Modify: `README.md`

**CLI interface:**

```text
node scripts/bootstrap-repo.mjs --repo OWNER/REPO [--dry-run]
```

- [ ] Write failing tests for active repo acceptance and fork/archived repo rejection.
- [ ] Write failing tests asserting the exact issue body, branch name, caller path/content, `AGENTS.md` section merge behavior, PR body, and all `- Codex` footers.
- [ ] Write a failing dry-run test proving it performs no GitHub mutations and prints no secret.
- [ ] Write a failing test proving branch protection is not changed unless a successful `codex-review` status exists on the canary SHA.
- [ ] Run `node --test test/bootstrap.test.mjs` and verify it fails.
- [ ] Implement bootstrap planning as pure logic and keep shell/GitHub execution in the CLI boundary.
- [ ] Add README instructions for publishing `v1`, configuring native Codex, installing the Claude secret, canarying, rollback, and future-repo bootstrap.
- [ ] Run the full test suite and CLI dry-run against `jlixfeld/StratBacktester`.
- [ ] Commit with `git commit -m "feat: add safe repository bootstrap tooling"`.

## Task 8: Verify and publish the central implementation

**Files:**

- Modify only if verification finds a defect in files created above.

- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Run workflow YAML validation.
- [ ] Run the bootstrap dry-run for a private active repo, a public active repo, a fork, and an archived repo.
- [ ] Search for placeholders (`TODO`, `FIXME`, `TBD`, ellipses used as implementation stubs) and remove any.
- [ ] Review `git diff --stat`, `git diff`, and the commit series against every acceptance criterion in the design spec.
- [ ] Push `feature/reusable-agent-review-loop`.
- [ ] Open a PR referencing issue #1, with verification evidence and a `- Codex` footer.
- [ ] Wait for central CI and review feedback; address justified findings on the feature branch.
- [ ] After explicit user approval, merge the PR, create or move the protected `v1` ref to the verified merge commit, and verify the reusable workflow is publicly readable.

## Task 9: Canary StratBacktester

**Files in `jlixfeld/StratBacktester`:**

- Create: `.github/workflows/agent-review-loop.yml`
- Modify: `AGENTS.md`

- [ ] Create a tracking issue, isolated worktree, and rollout branch.
- [ ] Install `CLAUDE_CODE_OAUTH_TOKEN` from Infisical into the repository without displaying its value.
- [ ] Add the caller workflow pinned to the central canary SHA and merge the exact `## Code Review Rules` template into `AGENTS.md`.
- [ ] Add tests or static checks for the workflow and review-rules contract.
- [ ] Commit, push, and open the rollout PR.
- [ ] Verify native Codex auto-review triggers on every pull-request revision without a manual or bot-authored mention. Stop rollout if it does not.
- [ ] Exercise one high-confidence finding → Claude fix → new Codex review cycle.
- [ ] Verify the final clean review resolves superseded Codex conversations and writes `codex-review=success`.
- [ ] Merge only after user approval, then delete the worktree and local/remote rollout branch.
- [ ] Add `codex-review` to required checks and remove only the obsolete required-human-approval gate. Re-fetch branch protection and prove all other settings are unchanged.

## Task 10: Canary python-infisical and fork safety

**Files in `jlixfeld/python-infisical`:**

- Create: `.github/workflows/agent-review-loop.yml`
- Modify: `AGENTS.md`

- [ ] Repeat the issue/worktree/branch/PR process using the stable central `v1` ref.
- [ ] Verify a public same-repository PR can complete the finding/fix/clean loop.
- [ ] Open or use a harmless fork-originated canary PR and verify Claude does not run, no attempt marker is written, and no secret is exposed.
- [ ] Merge only after user approval, clean the worktree and branches, then enable the required status without changing unrelated protections.

## Task 11: Roll out to the remaining fleet

**Files in each eligible target repository:**

- Create: `.github/workflows/agent-review-loop.yml`
- Modify: `AGENTS.md`

- [ ] Query all `jlixfeld` repositories and produce a fresh inventory immediately before rollout.
- [ ] Exclude every repository where `isFork`, `isArchived`, or equivalent API flags are true.
- [ ] For each remaining repository, use the bootstrap command to create a tracking issue and rollout PR; do not push directly to its default branch.
- [ ] Install only the named Claude OAuth secret and enable native Codex review.
- [ ] Run a clean canary revision and verify `codex-review=success`.
- [ ] Add the required status and remove only obsolete human-approval requirements after successful canary verification.
- [ ] Re-fetch protection/rulesets and compare them with the saved pre-change snapshot.
- [ ] Merge each rollout PR only after user approval, then delete its worktree and local/remote branch.
- [ ] Publish a final table of included repositories, excluded forks/archives, rollout PRs, canary evidence, and branch-protection results.

## Final Verification

- [ ] The central test suite and workflow validation pass from a clean checkout.
- [ ] The private and public canaries each demonstrate a complete live loop.
- [ ] The public fork canary proves no Claude job or credential exposure.
- [ ] Current-head, idempotency, Codex-only resolution, comment-footer, and exact ten-attempt tests pass.
- [ ] Every active non-fork repository has the stable caller and review rules.
- [ ] Every required `codex-review` gate was enabled only after a successful canary.
- [ ] No archived repository, fork, existing deterministic check, or unrelated branch-protection setting was modified.
