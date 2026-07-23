#!/usr/bin/env node

import { bootstrapRepository } from "../src/bootstrap.mjs";

const args = process.argv.slice(2);
const repositoryIndex = args.indexOf("--repo");
const repository = repositoryIndex === -1 ? null : args[repositoryIndex + 1];
const dryRun = args.includes("--dry-run");

if (!repository) {
  console.error(
    "Usage: node scripts/bootstrap-repo.mjs --repo OWNER/REPO [--dry-run]",
  );
  process.exitCode = 2;
} else {
  bootstrapRepository({
    repository,
    dryRun,
    secret: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
