import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CODEX_LOGIN,
  MAX_FIX_ATTEMPTS,
} from "./constants.mjs";
import { GitHubClient } from "./github-client.mjs";
import {
  attemptMarker,
  buildClaudePrompt,
  canStartFixAttempt,
  handledReviewMarker,
  hasMarker,
  isEligibleFix,
  isEligibleRequest,
  limitMarker,
  manualInterventionComment,
  markerComment,
  markersComment,
  parseAttemptCount,
  selectCodexThreadsToResolve,
} from "./orchestrator.mjs";

const REQUEST_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

export async function runAction({ env, event, client }) {
  const outputs = emptyOutputs(event);

  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    return handleRequestEvent({ event, client, outputs });
  }
  if (env.GITHUB_EVENT_NAME === "pull_request_review") {
    return handleReviewEvent({ env, event, client, outputs });
  }

  return outputs;
}

async function handleRequestEvent({ event, client, outputs }) {
  if (!REQUEST_ACTIONS.has(event.action)) {
    return outputs;
  }

  const prNumber = event.pull_request?.number ?? event.number;
  if (!Number.isInteger(prNumber)) {
    throw new Error("Pull request event is missing a pull request number");
  }

  const pr = await client.getPullRequest(prNumber);
  outputs["pr-number"] = String(pr.number);
  outputs["head-ref"] = pr.head?.ref ?? "";

  if (
    !isEligibleRequest(pr) ||
    event.pull_request?.head?.sha !== pr.head?.sha
  ) {
    return outputs;
  }

  await client.createCommitStatus(
    pr.head.sha,
    "pending",
    `PR #${pr.number} is awaiting the current native Codex review`,
  );

  return outputs;
}

async function handleReviewEvent({ env, event, client, outputs }) {
  const codexLogin = readInput(env, "codex-login") || DEFAULT_CODEX_LOGIN;
  if (codexLogin.includes("*")) {
    throw new Error("codex-login must be one exact GitHub login, not a wildcard");
  }
  if (
    event.action !== "submitted" ||
    !sameText(event.review?.user?.login, codexLogin)
  ) {
    return outputs;
  }

  const prNumber = event.pull_request?.number ?? event.number;
  if (!Number.isInteger(prNumber)) {
    throw new Error("Review event is missing a pull request number");
  }

  const pr = await client.getPullRequest(prNumber);
  outputs["pr-number"] = String(pr.number);
  outputs["head-ref"] = pr.head?.ref ?? "";
  const headSha = pr.head?.sha;

  if (
    !isEligibleRequest(pr) ||
    event.pull_request?.head?.sha !== headSha ||
    event.review?.commit_id !== headSha
  ) {
    return outputs;
  }

  const handledMarker = handledReviewMarker(event.review.node_id, headSha);

  try {
    const comments = await client.listIssueComments(pr.number);
    const reviewComments = await client.listReviewComments(
      pr.number,
      event.review.id,
    );
    const findingCount = Math.max(
      reviewComments.length,
      sameText(event.review?.state, "changes_requested") ? 1 : 0,
    );

    if (hasMarker(comments, handledMarker)) {
      await setTerminalStatus(client, pr, findingCount);
      return outputs;
    }

    const threads = await client.listReviewThreads(pr.number);
    const threadIds = selectCodexThreadsToResolve({
      threads,
      codexLogin,
      clean: findingCount === 0,
    });
    for (const threadId of threadIds) {
      await client.resolveReviewThread(threadId);
    }

    if (findingCount === 0) {
      await client.postIssueComment(
        pr.number,
        markerComment(handledMarker),
      );
      await setTerminalStatus(client, pr, findingCount);
      return outputs;
    }

    await setTerminalStatus(client, pr, findingCount);
    const sameRepository = sameText(
      pr.head?.repo?.full_name,
      pr.base?.repo?.full_name,
    );
    const authorPermission = sameRepository
      ? await client.getCollaboratorPermission(pr.user?.login)
      : null;
    const eligibleForFix = isEligibleFix({
      pr,
      authorPermission,
      review: event.review,
      currentHeadSha: headSha,
      findingCount,
    });

    if (!eligibleForFix) {
      await client.postIssueComment(pr.number, markerComment(handledMarker));
      return outputs;
    }

    const maxAttempts = parseMaxAttempts(env);
    const completedAttempts = parseAttemptCount(
      comments,
      pr.number,
      maxAttempts,
    );
    const nextAttempt = canStartFixAttempt(completedAttempts, maxAttempts);

    if (!nextAttempt.allowed) {
      const manualComment = manualInterventionComment({
        prNumber: pr.number,
        maxAttempts,
      }).replace(
        limitMarker(pr.number, maxAttempts),
        `${handledMarker}\n${limitMarker(pr.number, maxAttempts)}`,
      );
      if (hasMarker(comments, limitMarker(pr.number, maxAttempts))) {
        await client.postIssueComment(pr.number, markerComment(handledMarker));
      } else {
        await client.postIssueComment(pr.number, manualComment);
      }
      return outputs;
    }

    await client.postIssueComment(
      pr.number,
      markersComment([
        handledMarker,
        attemptMarker(pr.number, nextAttempt.attempt),
      ]),
    );
    outputs["should-fix"] = "true";
    outputs.attempt = String(nextAttempt.attempt);
    outputs.prompt = buildClaudePrompt({
      repository: env.GITHUB_REPOSITORY,
      prNumber: pr.number,
      reviewUrl: event.review.html_url,
      attempt: nextAttempt.attempt,
      maxAttempts,
    });
    return outputs;
  } catch (error) {
    await failClosed(client, pr, error);
  }
}

async function setTerminalStatus(client, pr, findingCount) {
  if (findingCount === 0) {
    await client.createCommitStatus(
      pr.head.sha,
      "success",
      `PR #${pr.number} passed the current native Codex review`,
    );
    return;
  }

  await client.createCommitStatus(
    pr.head.sha,
    "failure",
    `PR #${pr.number} has unresolved native Codex findings`,
  );
}

async function failClosed(client, pr, originalError) {
  try {
    await client.createCommitStatus(
      pr.head.sha,
      "failure",
      `PR #${pr.number} review orchestration failed; manual intervention required`,
    );
  } catch (statusError) {
    throw new AggregateError(
      [originalError, statusError],
      originalError.message,
    );
  }
  throw originalError;
}

function emptyOutputs(event) {
  const pr = event.pull_request;
  return {
    "should-fix": "false",
    "pr-number": pr?.number === undefined ? "" : String(pr.number),
    "head-ref": pr?.head?.ref ?? "",
    prompt: "",
    attempt: "",
  };
}

function parseMaxAttempts(env) {
  const raw =
    readInput(env, "max-fix-attempts") || String(MAX_FIX_ATTEMPTS);
  const value = Number.parseInt(raw, 10);
  if (
    String(value) !== raw.trim() ||
    value < 1 ||
    value > MAX_FIX_ATTEMPTS
  ) {
    throw new Error(
      `max-fix-attempts must be an integer from 1 through ${MAX_FIX_ATTEMPTS}`,
    );
  }
  return value;
}

function readInput(env, name) {
  const exactKey = `INPUT_${name.toUpperCase()}`;
  const underscoreKey = exactKey.replaceAll("-", "_");
  return env[exactKey] ?? env[underscoreKey] ?? "";
}

function sameText(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export async function writeOutputs(
  path,
  outputs,
  append = appendFile,
  uuid = randomUUID,
) {
  const chunks = [];
  for (const [name, value] of Object.entries(outputs)) {
    const delimiter = `codex_${uuid()}`;
    chunks.push(`${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
  await append(path, chunks.join(""), "utf8");
}

export async function main(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  const outputPath = env.GITHUB_OUTPUT;
  const repository = env.GITHUB_REPOSITORY;
  const token = readInput(env, "github-token");
  if (!eventPath || !outputPath || !repository || !token) {
    throw new Error(
      "GITHUB_EVENT_PATH, GITHUB_OUTPUT, GITHUB_REPOSITORY, and github-token are required",
    );
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const client = new GitHubClient({ token, repository });
  const outputs = await runAction({ env, event, client });
  await writeOutputs(outputPath, outputs);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    const message = String(error?.message ?? error)
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
