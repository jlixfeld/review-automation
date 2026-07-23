import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function validateRepository(metadata) {
  if (!metadata?.nameWithOwner || !metadata?.defaultBranchRef?.name) {
    throw new Error("Repository metadata is missing its name or default branch");
  }
  if (metadata.isFork) {
    throw new Error(`${metadata.nameWithOwner}: forks are excluded`);
  }
  if (metadata.isArchived) {
    throw new Error(`${metadata.nameWithOwner}: archived repositories are excluded`);
  }
  return metadata;
}

export function mergeReviewRules(existingAgents, reviewRules) {
  const existing = normalize(existingAgents).trimEnd();
  const rules = normalize(reviewRules).trim();
  const heading = "## Code Review Rules";
  const startPattern = /^## Code Review Rules[ \t]*$/m;
  const match = startPattern.exec(existing);

  if (!rules.startsWith(heading)) {
    throw new Error("Review rules must start with ## Code Review Rules");
  }

  if (!match) {
    return [existing, rules].filter(Boolean).join("\n\n") + "\n";
  }

  const sectionStart = match.index;
  const afterHeading = sectionStart + match[0].length;
  const followingHeading = /^## .+$/gm;
  followingHeading.lastIndex = afterHeading;
  const next = followingHeading.exec(existing);
  const before = existing.slice(0, sectionStart).trimEnd();
  const after = next ? existing.slice(next.index).trimStart() : "";

  return [before, rules, after].filter(Boolean).join("\n\n") + "\n";
}

export function buildBootstrapPlan({
  metadata,
  issueNumber,
  caller,
  reviewRules,
  existingAgents,
}) {
  validateRepository(metadata);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("A positive tracking issue number is required");
  }

  const repository = metadata.nameWithOwner;
  return {
    repository,
    defaultBranch: metadata.defaultBranchRef.name,
    branch: `chore/agent-review-loop-${issueNumber}`,
    issue: buildTrackingIssue(metadata),
    files: {
      ".github/workflows/agent-review-loop.yml": caller,
      "AGENTS.md": mergeReviewRules(existingAgents, reviewRules),
    },
    pullRequest: {
      title: "chore: install agent PR review loop",
      body: [
        `Closes #${issueNumber}.`,
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
  };
}

export function buildTrackingIssue(metadata) {
  validateRepository(metadata);
  return {
    title: "Install the reusable Codex-to-Claude PR review loop",
    body: [
      `Install the centrally maintained agent review loop in \`${metadata.nameWithOwner}\`.`,
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
  };
}

export function canEnableGate(statuses, canarySha) {
  return statuses.some(
    (status) =>
      status?.context === "codex-review" &&
      status?.state === "success" &&
      status?.sha === canarySha,
  );
}

export async function bootstrapRepository({
  repository,
  dryRun = false,
  secret,
  runner = runCommand,
  writeOutput = console.log,
}) {
  assertRepositoryName(repository);
  const metadataResult = await runner("gh", [
    "repo",
    "view",
    repository,
    "--json",
    "nameWithOwner,isFork,isArchived,visibility,defaultBranchRef",
  ]);
  const metadata = validateRepository(JSON.parse(metadataResult.stdout));

  if (dryRun) {
    const result = {
      repository: metadata.nameWithOwner,
      defaultBranch: metadata.defaultBranchRef.name,
      dryRun: true,
      plannedActions: [
        "install CLAUDE_CODE_OAUTH_TOKEN",
        "create tracking issue",
        "push rollout branch",
        "open rollout pull request",
      ],
      mutateBranchProtection: false,
    };
    writeOutput(JSON.stringify(result, null, 2));
    return result;
  }

  if (!secret) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN must be present in the environment",
    );
  }

  const caller = await readFile(
    new URL("../templates/agent-review-loop.yml", import.meta.url),
    "utf8",
  );
  const reviewRules = await readFile(
    new URL("../templates/code-review-rules.md", import.meta.url),
    "utf8",
  );
  const issue = buildTrackingIssue(metadata);
  const issueResult = await runner("gh", [
    "issue",
    "create",
    "--repo",
    repository,
    "--title",
    issue.title,
    "--body",
    issue.body,
  ]);
  const issueNumber = parseCreatedNumber(issueResult.stdout, "issues");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "review-automation-bootstrap-"),
  );
  const checkoutPath = join(temporaryRoot, "repository");

  try {
    await runner("gh", ["repo", "clone", repository, checkoutPath]);
    const agentsPath = join(checkoutPath, "AGENTS.md");
    let existingAgents = "";
    try {
      existingAgents = await readFile(agentsPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const plan = buildBootstrapPlan({
      metadata,
      issueNumber,
      caller,
      reviewRules,
      existingAgents,
    });
    await runner("git", ["checkout", "-b", plan.branch], {
      cwd: checkoutPath,
    });
    const workflowPath = join(
      checkoutPath,
      ".github",
      "workflows",
      "agent-review-loop.yml",
    );
    await mkdir(join(checkoutPath, ".github", "workflows"), {
      recursive: true,
    });
    await writeFile(
      workflowPath,
      plan.files[".github/workflows/agent-review-loop.yml"],
    );
    await writeFile(agentsPath, plan.files["AGENTS.md"]);
    await runner(
      "git",
      ["add", ".github/workflows/agent-review-loop.yml", "AGENTS.md"],
      { cwd: checkoutPath },
    );
    await runner(
      "git",
      ["commit", "-m", "chore: install agent PR review loop"],
      { cwd: checkoutPath },
    );
    await runner(
      "git",
      ["push", "origin", `HEAD:refs/heads/${plan.branch}`],
      { cwd: checkoutPath },
    );
    await runner(
      "gh",
      ["secret", "set", plan.installSecret, "--repo", repository],
      { input: `${secret}\n` },
    );
    const prResult = await runner("gh", [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      plan.defaultBranch,
      "--head",
      plan.branch,
      "--title",
      plan.pullRequest.title,
      "--body",
      plan.pullRequest.body,
    ]);
    const result = {
      repository,
      issue: issueResult.stdout.trim(),
      pullRequest: prResult.stdout.trim(),
      branch: plan.branch,
      mutateBranchProtection: false,
    };
    writeOutput(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeoutMs = options.timeoutMs ?? 120_000;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
    child.stdin.end(options.input ?? "");
  });
}

function normalize(value) {
  return String(value ?? "").replaceAll("\r\n", "\n");
}

function assertRepositoryName(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("Repository must use OWNER/REPO format");
  }
}

function parseCreatedNumber(url, segment) {
  const match = new RegExp(`/${segment}/(\\d+)/?$`).exec(url.trim());
  if (!match) {
    throw new Error(`Could not parse created ${segment} URL`);
  }
  return Number.parseInt(match[1], 10);
}
