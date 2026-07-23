import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("reusable workflow exposes the stable explicit interface", async () => {
  const workflow = await read(".github/workflows/review-loop.yml");

  for (const fragment of [
    "workflow_call:",
    "automation_ref:",
    "default: v1",
    "codex_login:",
    "default: chatgpt-codex-connector[bot]",
    "max_fix_attempts:",
    "default: 10",
    "claude_code_oauth_token:",
    "required: true",
    "should-fix:",
    "pr-number:",
    "head-ref:",
    "prompt:",
    "attempt:",
  ]) {
    assert.ok(workflow.includes(fragment), `missing ${fragment}`);
  }
  assert.equal(workflow.includes("secrets: inherit"), false);
});

test("orchestration job has only review and status permissions", async () => {
  const workflow = await read(".github/workflows/review-loop.yml");

  assert.match(
    workflow,
    /orchestrate:\n(?:.*\n)*?    permissions:\n      contents: read\n      issues: write\n      pull-requests: write\n      statuses: write\n/,
  );
  assert.match(
    workflow,
    /repository: jlixfeld\/review-automation\n          ref: \$\{\{ inputs\.automation_ref \}\}\n          path: review-automation\n          persist-credentials: false/,
  );
  assert.match(workflow, /uses: \.\/review-automation/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /group: agent-review-loop-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/,
  );
});

test("Claude runs only for an eligible action output with exact bot and secret", async () => {
  const workflow = await read(".github/workflows/review-loop.yml");

  assert.match(
    workflow,
    /if: needs\.orchestrate\.outputs\.should-fix == 'true'/,
  );
  assert.match(
    workflow,
    /uses: anthropics\/claude-code-action@44423bdec74b97d67543eb16c110546762c110b2/,
  );
  assert.match(
    workflow,
    /allowed_bots: \$\{\{ inputs\.codex_login \}\}/,
  );
  assert.match(
    workflow,
    /claude_code_oauth_token: \$\{\{ secrets\.claude_code_oauth_token \}\}/,
  );
  assert.match(
    workflow,
    /prompt: \$\{\{ needs\.orchestrate\.outputs\.prompt \}\}/,
  );
  assert.match(
    workflow,
    /fix:\n(?:.*\n)*?    permissions:\n      actions: read\n      contents: write\n      issues: write\n      pull-requests: write\n/,
  );
});

test("caller listens to the exact supported events and passes one named secret", async () => {
  const caller = await read("templates/agent-review-loop.yml");

  for (const fragment of [
    "pull_request_target:",
    "types: [opened, synchronize, reopened, ready_for_review]",
    "pull_request_review:",
    "types: [submitted]",
    "uses: jlixfeld/review-automation/.github/workflows/review-loop.yml@v1",
    "claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  ]) {
    assert.ok(caller.includes(fragment), `missing ${fragment}`);
  }
  assert.equal(caller.includes("secrets: inherit"), false);
  assert.equal(caller.includes("actions/checkout"), false);
  assert.equal(caller.includes("pull_request.head.repo"), false);
});

test("action metadata declares every reusable output", async () => {
  const action = await read("action.yml");

  for (const output of [
    "should-fix:",
    "pr-number:",
    "head-ref:",
    "prompt:",
    "attempt:",
  ]) {
    assert.ok(action.includes(output), `missing action output ${output}`);
  }
});

test("central CI pins official actions and runs all tests", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(
    workflow,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/,
  );
  assert.match(workflow, /node-version: 20/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /ruby -e 'require "yaml";/);
});

test("README documents canary-before-gate and fork safety", async () => {
  const readme = await read("README.md");

  assert.match(readme, /Only then add `codex-review`/);
  assert.match(
    readme,
    /fork-originated pull request does not start\s+the Claude job/,
  );
  assert.match(readme, /at most ten times/);
  assert.match(readme, /does not use `secrets: inherit`/);
});
