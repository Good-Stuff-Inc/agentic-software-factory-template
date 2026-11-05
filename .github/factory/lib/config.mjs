#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
export const labelsPath = fileURLToPath(new URL('../labels.json', import.meta.url));
export const markerPath = fileURLToPath(new URL('../asf-spec-marker.txt', import.meta.url));
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Repository-relative paths, for messages and for scripts that run from the repository root.
export const CONFIG_FILE = '.github/factory/config.json';
export const MARKER_FILE = '.github/factory/asf-spec-marker.txt';
export const ENRICHMENT_WORKFLOW = '.github/workflows/issue-enrichment.md';
export const ENRICHMENT_LOCK = '.github/workflows/issue-enrichment.lock.yml';

export const PROJECT_FIELDS = [
  {
    name: 'Proposed Type',
    options: [
      { name: 'Bug', color: 'RED', description: 'Existing behaviour is wrong' },
      { name: 'Feature', color: 'GREEN', description: 'New user-visible capability' },
      { name: 'Chore', color: 'GRAY', description: 'Maintenance, tooling, dependencies or docs' },
    ],
  },
  {
    name: 'Priority',
    options: [
      { name: 'P0', color: 'RED', description: 'Outage, data loss or security incident' },
      { name: 'P1', color: 'ORANGE', description: 'Materially wrong behaviour, no acceptable workaround' },
      { name: 'P2', color: 'YELLOW', description: 'Real value, but the business survives without it' },
      { name: 'P3', color: 'BLUE', description: 'Nice to have' },
    ],
  },
  {
    name: 'Complexity',
    options: [
      { name: 'XS', color: 'GRAY', description: 'A few lines, one file, obvious' },
      { name: 'S', color: 'BLUE', description: 'One module plus tests, well understood' },
      { name: 'M', color: 'GREEN', description: 'Several files or a new endpoint' },
      { name: 'L', color: 'YELLOW', description: 'Cross-cutting, touches a data model or API contract' },
      { name: 'XL', color: 'RED', description: 'Needs to be broken down before anyone starts' },
    ],
  },
];

export const REQUIRED_FIELDS = PROJECT_FIELDS.map((field) => field.name);

export const ISSUE_TYPES = [
  { name: 'Bug', description: 'An unexpected problem or behavior', color: 'red' },
  { name: 'Feature', description: 'A request, idea, or new functionality', color: 'blue' },
  { name: 'Task', description: 'A specific piece of work', color: 'yellow' },
];

export const NEEDS_ASSIGNMENT_VIEW = {
  name: 'Needs assignment',
  filter: 'is:issue is:open no:assignee label:needs-assignment',
  sortField: 'Priority',
};

const SETUP_HINT = 'Run the "Factory setup" workflow, or `node .github/factory/scripts/setup.mjs`, '
  + 'and see docs/SETUP.md.';

export function readMarker(path = markerPath) {
  const marker = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0];
  if (!/^<!-- asf-spec: v\d+ -->$/.test(marker)) {
    throw new Error(`${MARKER_FILE} must start with a marker line such as "<!-- asf-spec: v1 -->".`);
  }
  return marker;
}

export function readLabels(path = labelsPath) {
  const labels = JSON.parse(readFileSync(path, 'utf8'))?.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('.github/factory/labels.json must contain a non-empty "labels" array.');
  }
  for (const label of labels) {
    if (typeof label?.name !== 'string' || !/^[0-9a-f]{6}$/i.test(label?.color ?? '')
      || typeof label?.description !== 'string') {
      throw new Error(`Invalid label in .github/factory/labels.json: ${JSON.stringify(label)}`);
    }
  }
  return labels;
}

// Reads safe-outputs.add-labels.allowed from the workflow frontmatter, which
// must stay identical to labels.json or the agent can emit a label that does not exist.
export function parseAllowedLabels(markdown) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}add-labels:\s*$/.test(line));
  if (start === -1) {
    return [];
  }
  const labels = [];
  let inAllowed = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) {
      break;
    }
    if (/^ {4}allowed:\s*$/.test(line)) {
      inAllowed = true;
      continue;
    }
    const item = /^ {6}- +["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (inAllowed && item) {
      labels.push(item[1]);
    } else if (/^ {4}\S/.test(line)) {
      inAllowed = false;
    }
  }
  return labels;
}

export function loadConfig(path = configPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${CONFIG_FILE}: ${detail}`);
  }

  return {
    project: {
      owner: typeof raw?.project?.owner === 'string' ? raw.project.owner.trim() : '',
      number: raw?.project?.number ?? null,
      title: typeof raw?.project?.title === 'string' && raw.project.title.trim()
        ? raw.project.title.trim()
        : 'Agentic Software Factory',
    },
    ruleset: {
      enabled: raw?.ruleset?.enabled !== false,
      requiredApprovals: Number.isInteger(raw?.ruleset?.requiredApprovals)
        ? raw.ruleset.requiredApprovals
        : 1,
    },
    security: {
      enabled: raw?.security?.enabled !== false,
    },
  };
}

export function isValidOwner(owner) {
  return typeof owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner);
}

export function isValidProjectNumber(number) {
  return Number.isSafeInteger(number) && number > 0;
}

export function resolveProject(config) {
  const { owner, number } = config.project;

  if (!isValidOwner(owner) || !isValidProjectNumber(number)) {
    throw new Error(
      `The factory project is not configured: ${CONFIG_FILE} needs "project.owner" (an organization login) `
      + `and "project.number" (a positive integer). ${SETUP_HINT}`,
    );
  }

  return { owner, number, url: `https://github.com/orgs/${owner}/projects/${number}` };
}

export function writeProjectToConfig(owner, number, path = configPath) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.project = { ...raw.project, owner, number };
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    readMarker();
    const project = resolveProject(loadConfig());
    console.log(`Factory project: ${project.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
