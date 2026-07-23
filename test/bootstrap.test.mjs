import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapRepository,
  buildBootstrapPlan,
  canEnableGate,
  mergeReviewRules,
  validateRepository,
} from "../src/bootstrap.mjs";

const metadata = {
  nameWithOwner: "jlixfeld/example",
  isFork: false,
  isArchived: false,
  visibility: "PRIVATE",
  defaultBranchRef: { name: "main" },
};

const rules = [
  "## Code Review Rules",
  "",
  "- Keep review strictly read-only.",
  "- Post only high-confidence findings.",
].join("\n");

test("active source repositories are accepted", () => {
  assert.deepEqual(validateRepository(metadata), metadata);
});

test("forks and archived repositories are rejected", () => {
  assert.throws(
    () => validateRepository({ ...metadata, isFork: true }),
    /forks are excluded/,
  );
  assert.throws(
    () => validateRepository({ ...metadata, isArchived: true }),
    /archived repositories are excluded/,
  );
});

test("review rules append once and replace an existing section surgically", () => {
  assert.equal(
    mergeReviewRules("# Repository Instructions\n", rules),
    `# Repository Instructions\n\n${rules}\n`,
  );
  assert.equal(
    mergeReviewRules(
      [
        "# Repository Instructions",
        "",
        "Keep this.",
        "",
        "## Code Review Rules",
        "",
        "Old rules.",
        "",
        "## Testing",
        "",
        "Run tests.",
        "",
      ].join("\n"),
      rules,
    ),
    [
      "# Repository Instructions",
      "",
      "Keep this.",
      "",
      rules,
      "",
      "## Testing",
      "",
      "Run tests.",
      "",
    ].join("\n"),
  );
});

test("bootstrap plan contains exact issue, branch, PR, and file actions", () => {
  assert.deepEqual(
    buildBootstrapPlan({
      metadata,
      issueNumber: 17,
      caller: "name: Agent review loop\n",
      reviewRules: rules,
      existingAgents: "# Repository Instructions\n",
    }),
    {
      repository: "jlixfeld/example",
      defaultBranch: "main",
      branch: "chore/agent-review-loop-17",
      issue: {
        title: "Install the reusable Codex-to-Claude PR review loop",
        body: [
          "Install the centrally maintained agent review loop in `jlixfeld/example`.",
          "",
          "Acceptance criteria:",
          "- add the thin caller workflow;",
          "- add the exact native Codex review rules;",
          "- install the named Claude OAuth secret without exposing it;",
          "- verify a live canary before changing branch protection;",
          "- preserve every existing deterministic check and unrelated protection.",
          "",
          "- Codex",
        ].join("\n"),
      },
      files: {
        ".github/workflows/agent-review-loop.yml":
          "name: Agent review loop\n",
        "AGENTS.md": `# Repository Instructions\n\n${rules}\n`,
      },
      pullRequest: {
        title: "chore: install agent PR review loop",
        body: [
          "Closes #17.",
          "",
          "Adds the centrally maintained Codex-to-Claude pull request review loop and repository-local native Codex review rules.",
          "",
          "Branch protection is intentionally unchanged until a live `codex-review` canary succeeds.",
          "",
          "- Codex",
        ].join("\n"),
      },
      installSecret: "CLAUDE_CODE_OAUTH_TOKEN",
      mutateBranchProtection: false,
    },
  );
});

test("gate enablement requires success on the exact canary SHA", () => {
  const statuses = [
    { context: "codex-review", state: "success", sha: "canary" },
    { context: "lint", state: "success", sha: "other" },
  ];

  assert.equal(canEnableGate(statuses, "canary"), true);
  assert.equal(canEnableGate(statuses, "other"), false);
  assert.equal(
    canEnableGate(
      [{ context: "codex-review", state: "failure", sha: "canary" }],
      "canary",
    ),
    false,
  );
});

test("every generated GitHub body ends with the Codex footer", () => {
  const plan = buildBootstrapPlan({
    metadata,
    issueNumber: 17,
    caller: "workflow\n",
    reviewRules: rules,
    existingAgents: "",
  });

  assert.equal(plan.issue.body.endsWith("\n\n- Codex"), true);
  assert.equal(plan.pullRequest.body.endsWith("\n\n- Codex"), true);
});

test("dry-run performs only repository inspection and never exposes a secret", async () => {
  const calls = [];
  const output = [];
  const secret = "never-print-this-value";
  const runner = async (command, args) => {
    calls.push([command, args]);
    return { stdout: JSON.stringify(metadata), stderr: "" };
  };

  const result = await bootstrapRepository({
    repository: "jlixfeld/example",
    dryRun: true,
    secret,
    runner,
    writeOutput: (value) => output.push(value),
  });

  assert.deepEqual(calls, [
    [
      "gh",
      [
        "repo",
        "view",
        "jlixfeld/example",
        "--json",
        "nameWithOwner,isFork,isArchived,visibility,defaultBranchRef",
      ],
    ],
  ]);
  assert.deepEqual(result, {
    repository: "jlixfeld/example",
    defaultBranch: "main",
    dryRun: true,
    plannedActions: [
      "install CLAUDE_CODE_OAUTH_TOKEN",
      "create tracking issue",
      "push rollout branch",
      "open rollout pull request",
    ],
    mutateBranchProtection: false,
  });
  assert.equal(output.join("\n").includes(secret), false);
});
