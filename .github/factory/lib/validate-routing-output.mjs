#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMarker } from './config.mjs';

export function validateRoutingOutput(output, issueNumber) {
  const entries = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const isBug = entries.some((entry) => entry.type === 'add_labels'
    && entry.labels?.some((label) => label.name === 'type:bug'));

  if (isBug && !entries.some((entry) => entry.type === 'assign_to_agent'
    && entry.issue_number === issueNumber)) {
    throw new Error(`Bug #${issueNumber} was routed without a valid assign_to_agent issue_number. No Copilot handoff was made.`);
  }
}

export function isPipelineIssue(issueBody, marker) {
  return typeof issueBody === 'string' && issueBody.split(/\r?\n/).includes(marker);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , outputPath, number] = process.argv;
    const issueNumber = Number(number);
    if (!outputPath || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new Error('Usage: validate-routing-output.mjs <safe-outputs.jsonl> <issue-number>');
    }
    const marker = readMarker();
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (isPipelineIssue(event.issue?.body, marker)) {
      validateRoutingOutput(readFileSync(outputPath, 'utf8'), issueNumber);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
