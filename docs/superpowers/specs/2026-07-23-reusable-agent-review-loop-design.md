# Reusable Codex-to-Claude Pull Request Review Loop

**Issue:** [jlixfeld/review-automation#1](https://github.com/jlixfeld/review-automation/issues/1)

## Purpose

Provide one centrally maintained GitHub Actions workflow that coordinates native Codex
pull-request reviews with Claude fixes across every active, non-fork repository owned by
`jlixfeld`.

The workflow replaces manual handoffs between Codex and Claude:

1. Codex reviews the latest pull-request revision.
2. Claude evaluates and fixes justified findings.
3. A Claude push requests a new Codex review.
4. The cycle repeats until Codex reports no findings or ten Claude fix attempts have run.

The authoritative merge gate is a `codex-review` commit status. A GitHub approval badge is not
required because GitHub does not document native Codex reviews as qualifying approvals.

## Scope

### Included

- All 26 active, non-fork repositories owned by `jlixfeld` as of 2026-07-23.
- Public and private repositories.
- A public central repository, `jlixfeld/review-automation`.
- A thin caller workflow in each target repository.
- Repository-local review guidance in `AGENTS.md`.
- A bootstrap command for future repositories.
- A maximum of ten Claude fix attempts per pull request.

### Excluded

- Archived repositories.
- Forks.
- Automatic writes to fork-originated pull requests.
- Replacing existing deterministic CI, security, or build checks.
- Letting Codex modify pull-request branches.
- Merging pull requests automatically.
- Treating a model-authored review as a substitute for deterministic tests.

## Repository Model

`jlixfeld/review-automation` is public so both public and private repositories can call the same
reusable workflow. It contains no credentials.

The stable interface is published from the `v1` ref. Target repositories call:

```yaml
uses: jlixfeld/review-automation/.github/workflows/review-loop.yml@v1
```

Breaking changes require a new major ref. Changes to `v1` are validated in the canary
repositories before the ref moves.

Each target repository owns:

- `.github/workflows/agent-review-loop.yml`, which forwards supported GitHub events to the
  reusable workflow;
- `AGENTS.md`, including a `## Code Review Rules` section;
- the encrypted `CLAUDE_CODE_OAUTH_TOKEN` Actions secret; and
- its own branch-protection configuration.

## Eligible Pull Requests

Codex review runs for pull requests that are open and not drafts.

Claude fixes run only when all of the following are true:

- the pull request is open and not a draft;
- the head repository is the same repository as the base repository;
- the pull request author has write-equivalent repository permission;
- the latest native Codex review applies to the current head SHA;
- that review contains at least one inline finding; and
- fewer than ten Claude fix attempts have been recorded.

Fork-originated pull requests may receive Codex review feedback, but the workflow never gives
Claude write credentials or pushes commits to them.

## Event Flow

### Receiving terminal review signals

The target caller listens for:

- `pull_request_review`: `submitted`, for finding-bearing reviews;
- `issue_comment`: `created`, for clean reviews containing a reviewed commit SHA.

Native Codex auto-review is configured for every pull-request revision. Until Codex emits one of
the authenticated terminal signals above, the required `codex-review` context is absent and the
pull request remains blocked.

GitHub Actions does not post `@codex review`: bot-authored mentions are not associated with the
user's connected Codex account.

### Receiving Codex review

The review handlers ignore signals unless:

- the author is the configured native Codex GitHub App account;
- the review or clean-comment commit matches the pull request's current head SHA; and
- the signal has not already been handled.

It fetches the inline comments associated with that review. Inline comments are the finding
signal:

- zero inline comments means the current revision is clean;
- one or more inline comments means findings remain.

The native Codex summary remains the human-readable review summary. The orchestrator does not
duplicate it.

### Clean revision

When the latest Codex review has no inline findings, the handler:

1. Resolves all older unresolved review threads authored by the native Codex App.
2. Records a hidden handled-review marker.
3. Sets `codex-review` on the current head SHA to `success`.
4. Does not invoke Claude.

### Findings remain

When the latest Codex review has inline findings, the handler:

1. Resolves older Codex threads superseded by the latest review, leaving the latest review's
   threads unresolved.
2. Records a hidden handled-review marker.
3. Sets `codex-review` on the current head SHA to `failure`.
4. Counts prior Claude fix-attempt markers on the pull request.
5. If the count is below ten, records the next attempt marker and invokes Claude.
6. If the count is ten, leaves the failure in place and posts one concise manual-intervention
   comment.

Each workflow-generated GitHub comment ends with a separate `- Codex` footer.

## Claude Fix Contract

The existing `anthropics/claude-code-action@v1` integration performs fixes. It receives a
direct prompt that requires it to:

- read every unresolved inline finding from the latest Codex review;
- evaluate each finding technically rather than accepting it automatically;
- implement only justified fixes;
- add or update tests for every behavior change;
- run the repository's documented verification commands;
- commit and push to the existing pull-request branch; and
- leave unrelated code unchanged.

Claude may rebut an unsupported finding in its progress comment instead of changing code. A
rebuttal does not clear the gate by itself: a subsequent Codex review must return clean.

The Claude action receives write permissions only in the fix job and only for eligible
same-repository pull requests. Its OAuth secret is passed explicitly, not inherited wholesale.

## Iteration Accounting

A fix attempt is counted immediately before invoking Claude. Hidden issue-comment markers are
the durable counter because they survive workflow retries and new commits.

The limit is exactly ten attempts:

- attempts 1 through 10 may invoke Claude;
- after attempt 10, any subsequent finding-bearing Codex review leaves `codex-review` failing;
- rerunning an already handled workflow does not increment the count; and
- a clean Codex review ends the loop regardless of the current count.

Starting a materially new pull request resets the count naturally because markers are scoped to
one pull request. Reopening the same pull request does not reset it.

## Conversation Resolution

GitHub review threads are queried through GraphQL.

The workflow resolves only threads whose root comment author is the configured native Codex App.
It never resolves human or other-bot conversations.

On each new Codex review:

- threads belonging to older Codex reviews are resolved;
- threads belonging to the latest finding-bearing review remain unresolved;
- a clean latest review resolves all older Codex threads.

This treats the latest Codex review as the authoritative assessment of the latest head SHA while
preserving the historical discussion in collapsed threads.

## Commit Status

The workflow writes a terminal classic commit status named `codex-review` to the pull request
head SHA:

- `failure`: Codex findings remain, the iteration limit was reached, or orchestration failed;
- `success`: the latest Codex clean comment identifies the current head SHA.

Before either terminal signal, the required context is absent and GitHub keeps merging blocked.

Status descriptions identify the pull request and iteration without exposing secrets or model
output.

The status is made required only after it has succeeded in a live canary pull request. Existing
required status checks are preserved.

## Security Boundaries

- Orchestration runs only for authenticated Codex review and clean-comment events.
- Untrusted pull-request code is never executed by the orchestration step.
- The native Codex reviewer remains read-only.
- Claude receives write access only for trusted, same-repository pull requests.
- Fork pull requests never receive Claude credentials.
- The central repository stores no secrets.
- Each target repository receives only `CLAUDE_CODE_OAUTH_TOKEN`, installed from Infisical
  without printing its value.
- The workflow passes the Claude secret by name rather than using `secrets: inherit`.
- GitHub tokens use job-scoped least privilege.
- Bot-trigger allowlists name the exact native Codex App account; wildcards are forbidden.
- Workflow actions are pinned to stable major refs or immutable SHAs.
- Concurrency prevents stale runs from writing status for a superseded head SHA.

## Failure Handling

- If native Codex does not respond, the required `codex-review` context remains absent.
- If native auto-review is disabled or does not run on every revision, canary rollout stops.
- If a Codex review targets an old SHA, it is ignored.
- If Claude fails without pushing, `codex-review` remains failing and the attempt stays counted.
- If Claude pushes after the PR closes or the head changes, normal GitHub branch protections
  reject or supersede the stale operation.
- If GraphQL conversation resolution fails, the gate stays failing rather than reporting a
  false clean state.
- If the configured Codex bot identity changes, reviews from the unknown actor are ignored until
  the allowlist is updated.

## Testing

The central repository uses dependency-free Node.js tests (`node --test`) for orchestration
logic. Tests cover:

- event eligibility;
- same-repository and trusted-author enforcement;
- request-marker idempotency;
- current-head review matching;
- finding detection from inline comments;
- handled-review idempotency;
- exact ten-attempt behavior;
- status transitions;
- Codex-only conversation resolution;
- footer inclusion in every generated comment;
- stale-event rejection; and
- failure paths that must not report success.

Workflow YAML is validated separately. Tests mock GitHub boundaries and assert the complete
request bodies, prompts, actors, SHAs, and status payloads passed across those boundaries.

## Rollout

### Phase 1: Central implementation

1. Implement and test the reusable workflow and composite orchestration action.
2. Publish the initial stable `v1` ref only after CI passes.

### Phase 2: Private canary

1. Enable native Codex review for `jlixfeld/StratBacktester`.
2. Install the Claude OAuth secret from Infisical.
3. Add the thin caller and exact `## Code Review Rules` guidance through a pull request.
4. Verify a finding-bearing cycle and a clean cycle.
5. Make `codex-review` required only after the clean cycle succeeds.

### Phase 3: Public canary

Use `jlixfeld/python-infisical` to verify:

- public-repository review behavior;
- same-repository Claude fixes; and
- fork-originated pull requests cannot receive writes or secrets.

### Phase 4: Fleet rollout

For each remaining active, non-fork repository:

1. Create a tracking issue.
2. Open a rollout pull request containing the caller and local review rules.
3. Install the Claude OAuth secret from Infisical.
4. Enable native Codex review.
5. Run a clean canary revision.
6. Add `codex-review` to required checks.
7. Remove only the obsolete required-human-approval gate, when present.
8. Preserve every other branch-protection and ruleset setting.

Archived repositories and forks remain unchanged.

### Future repositories

The central repository provides a bootstrap command that:

- verifies the target is active and not a fork;
- installs the caller workflow and review guidance through an issue and pull request;
- installs the Claude secret without displaying it; and
- defers branch-protection changes until a successful canary status exists.

## Acceptance Criteria

- One public, versioned workflow implementation serves all eligible repositories.
- StratBacktester completes an end-to-end Codex finding → Claude fix → Codex clean cycle.
- The public canary proves fork-originated PRs cannot trigger Claude writes.
- `codex-review` cannot succeed for an old review, an orchestration error, or remaining findings.
- The loop invokes Claude no more than ten times per pull request.
- Only native Codex review conversations are automatically resolved.
- Every workflow-generated GitHub comment ends with `- Codex`.
- Existing CI and security checks remain required.
- No archived repository or fork is modified.
