#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENRICHMENT_LOCK,
  ENRICHMENT_WORKFLOW,
  ISSUE_TYPES,
  loadConfig,
  NEEDS_ASSIGNMENT_VIEW,
  parseAllowedLabels,
  PROJECT_FIELDS,
  readLabels,
  readMarker,
  repositoryRoot,
  resolveProject,
} from '../lib/config.mjs';
import { createGhClient, messageOf, paginate, statusOf } from '../lib/gh.mjs';

const RERUN_IN_ACTIONS = 'Run the "Factory doctor" workflow to check it with the real secret.';
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const COPILOT_LOGINS = new Set(['copilot-swe-agent', 'copilot']);

const PROJECT_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      title
      repositories(first: 100) { nodes { id } }
      views(first: 50) { nodes { name } }
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { name dataType }
          ... on ProjectV2SingleSelectField { options { name } }
        }
      }
    }
  }
}`;

const ASSIGNABLE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
      nodes { login }
    }
  }
}`;

const ISSUE_TYPES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { issueTypes(first: 50) { nodes { name } } }
}`;

function defaultReadFile(path) {
  const absolute = join(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

export function activeCodeownersRules(text) {
  return (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function checkLocalFiles(add, readFile, { config, labels }) {
  let project = null;
  try {
    project = resolveProject(config ?? loadConfig());
    add('Configuration', 'pass', `Project ${project.url}`);
  } catch (error) {
    add('Configuration', 'fail', messageOf(error));
  }

  try {
    readMarker();
    add('Intake marker', 'pass', 'Marker line is valid.');
  } catch (error) {
    add('Intake marker', 'fail', messageOf(error));
  }

  const workflow = readFile(ENRICHMENT_WORKFLOW);
  if (workflow === null) {
    add('Enrichment workflow', 'fail', `${ENRICHMENT_WORKFLOW} is missing.`);
  } else {
    const allowed = new Set(parseAllowedLabels(workflow));
    const names = new Set(labels.map((label) => label.name));
    const notAllowed = [...names].filter((name) => !allowed.has(name));
    const unknown = [...allowed].filter((name) => !names.has(name));
    if (notAllowed.length > 0 || unknown.length > 0) {
      add('Label allow-list', 'fail', `${ENRICHMENT_WORKFLOW} add-labels.allowed and labels.json differ`
        + `${notAllowed.length > 0 ? `; not allowed: ${notAllowed.join(', ')}` : ''}`
        + `${unknown.length > 0 ? `; not in labels.json: ${unknown.join(', ')}` : ''}. Fix one, then run \`gh aw compile\`.`);
    } else {
      add('Label allow-list', 'pass', 'Matches labels.json.');
    }
  }
  if (readFile(ENRICHMENT_LOCK) === null) {
    add('Enrichment workflow', 'fail', `${ENRICHMENT_LOCK} is missing. Run \`gh aw compile\` and commit the result.`);
  }
  return project;
}

async function checkLabels(add, client, repo, labels) {
  try {
    const existing = await paginate(client, `/repos/${repo.fullName}/labels`);
    const byName = new Map(existing.map((label) => [label.name, label]));
    const missing = labels.filter((label) => !byName.has(label.name)).map((label) => label.name);
    const drifted = labels.filter((label) => {
      const current = byName.get(label.name);
      return current && (current.color.toLowerCase() !== label.color.toLowerCase() || (current.description ?? '') !== label.description);
    }).map((label) => label.name);
    if (missing.length > 0) {
      add('Labels', 'fail', `Missing: ${missing.join(', ')}. Run setup with the "labels" step.`);
    } else if (drifted.length > 0) {
      add('Labels', 'warn', `Color or description differs from labels.json: ${drifted.join(', ')}.`);
    } else {
      add('Labels', 'pass', `All ${labels.length} labels exist.`);
    }
  } catch (error) {
    add('Labels', 'fail', `Could not list labels: ${messageOf(error)}`);
  }
}

async function checkWorkflowState(add, client, repo) {
  try {
    const workflow = await client.request('GET', `/repos/${repo.fullName}/actions/workflows/issue-enrichment.lock.yml`);
    if (workflow?.state === 'active') {
      add('Enrichment workflow', 'pass', 'Active.');
    } else {
      add('Enrichment workflow', 'fail', `State is "${workflow?.state}". Enable it on the Actions tab.`);
    }
  } catch (error) {
    add('Enrichment workflow', 'fail', statusOf(error) === 404
      ? `Not found on ${repo.defaultBranch}. Commit ${ENRICHMENT_LOCK} to the default branch.`
      : `Could not read workflow state: ${messageOf(error)}`);
  }
}

function checkSecrets(add, secrets) {
  for (const [name, present] of [['GH_AW_READ_PROJECT_TOKEN', secrets.read], ['GH_AW_AGENT_TOKEN', secrets.agent]]) {
    if (present === true) {
      add('Secrets', 'pass', `${name} is set.`);
    } else if (present === false) {
      add('Secrets', 'fail', `${name} is not set. See docs/SETUP.md.`);
    } else {
      add('Secrets', 'warn', `Could not confirm ${name} with this token. ${RERUN_IN_ACTIONS}`);
    }
  }
  for (const name of secrets.exposed ?? []) {
    add('Secrets', 'warn', `${name} is a repository or organization secret, so a workflow on any branch can read it. `
      + 'Move it to the "factory" environment. See docs/SETUP.md.');
  }
  if (secrets.bootstrap === true) {
    add('Secrets', 'warn', 'ASF_BOOTSTRAP_TOKEN is still set. Setup is done with it; delete the secret and revoke the token.');
  }
}

function unavailable(name, present) {
  return present === false ? `Skipped until ${name} is set.` : `${name} is not available here. ${RERUN_IN_ACTIONS}`;
}

async function checkProject(add, readClient, repo, project, present) {
  if (!project) {
    add('Project access', 'skip', 'Skipped until the project is configured.');
    return;
  }
  if (!readClient) {
    add('Project access', 'skip', unavailable('GH_AW_READ_PROJECT_TOKEN', present));
    return;
  }

  let data;
  try {
    data = await readClient.graphql(PROJECT_QUERY, { owner: project.owner, number: project.number });
  } catch (error) {
    add('Project access', 'fail', `GH_AW_READ_PROJECT_TOKEN cannot read ${project.url}: ${messageOf(error)}`);
    return;
  }
  const board = data?.organization?.projectV2;
  if (!board) {
    add('Project access', 'fail', `GH_AW_READ_PROJECT_TOKEN cannot see ${project.url}. It needs organization Projects: Read.`);
    return;
  }
  add('Project access', 'pass', `GH_AW_READ_PROJECT_TOKEN can read "${board.title}".`);

  const fields = new Map((board.fields?.nodes ?? []).filter((field) => field?.name).map((field) => [field.name, field]));
  const problems = [];
  for (const wanted of PROJECT_FIELDS) {
    const field = fields.get(wanted.name);
    if (!field || field.dataType !== 'SINGLE_SELECT') {
      problems.push(`"${wanted.name}" is missing or not single select`);
      continue;
    }
    const options = new Set((field.options ?? []).map((option) => option.name));
    const missing = wanted.options.filter((option) => !options.has(option.name)).map((option) => option.name);
    if (missing.length > 0) {
      problems.push(`"${wanted.name}" lacks ${missing.join(', ')}`);
    }
  }
  if (problems.length > 0) {
    add('Project fields', 'fail', `${problems.join('; ')}. Run setup with the "project" step.`);
  } else {
    add('Project fields', 'pass', `${PROJECT_FIELDS.map((field) => field.name).join(', ')} are correct.`);
  }

  if (!(board.repositories?.nodes ?? []).some((node) => node?.id === repo.nodeId)) {
    add('Project link', 'warn', `The project is not linked to ${repo.fullName}. Run setup with the "project" step.`);
  }
  if (!(board.views?.nodes ?? []).some((view) => view?.name === NEEDS_ASSIGNMENT_VIEW.name)) {
    add('Project view', 'warn', `View "${NEEDS_ASSIGNMENT_VIEW.name}" is missing. Run setup with the "project" step or create it by hand.`);
  } else {
    add('Project view', 'pass', `"${NEEDS_ASSIGNMENT_VIEW.name}" exists.`);
  }

  try {
    await readClient.request('GET', `/repos/${repo.fullName}/issues?state=all&per_page=1`);
    add('Issue access', 'pass', 'GH_AW_READ_PROJECT_TOKEN can read issues.');
  } catch (error) {
    add('Issue access', 'fail', `GH_AW_READ_PROJECT_TOKEN cannot read issues in ${repo.fullName}: ${messageOf(error)}`);
  }
}

async function checkCopilot(add, agentClient, repo, present) {
  if (!agentClient) {
    add('Copilot coding agent', 'skip', unavailable('GH_AW_AGENT_TOKEN', present));
    return;
  }
  try {
    const data = await agentClient.graphql(ASSIGNABLE_QUERY, { owner: repo.owner, name: repo.name });
    const logins = (data?.repository?.suggestedActors?.nodes ?? []).map((node) => node?.login?.toLowerCase());
    if (logins.some((login) => COPILOT_LOGINS.has(login))) {
      add('Copilot coding agent', 'pass', 'GH_AW_AGENT_TOKEN can assign Copilot in this repository.');
    } else {
      add('Copilot coding agent', 'fail', 'Copilot is not assignable with GH_AW_AGENT_TOKEN. Enable the Copilot coding agent '
        + 'for this repository and make sure the token owner has a Copilot seat and write access.');
    }
  } catch (error) {
    add('Copilot coding agent', 'fail', `GH_AW_AGENT_TOKEN could not query assignable actors: ${messageOf(error)}`);
  }
}

async function checkIssueTypes(add, client, repo) {
  try {
    const data = await client.graphql(ISSUE_TYPES_QUERY, { owner: repo.owner, name: repo.name });
    const available = new Set((data?.repository?.issueTypes?.nodes ?? []).map((type) => type?.name));
    const missing = ISSUE_TYPES.filter((type) => !available.has(type.name)).map((type) => type.name);
    if (missing.length > 0) {
      add('Issue types', 'fail', `Missing: ${missing.join(', ')}. Run setup with the "issue-types" step, or ask an organization owner.`);
    } else {
      add('Issue types', 'pass', `${ISSUE_TYPES.map((type) => type.name).join(', ')} are available.`);
    }
  } catch (error) {
    add('Issue types', 'warn', `Could not read issue types: ${messageOf(error)}`);
  }
}

async function checkCodeowners(add, client, repo, readFile) {
  try {
    const result = await client.request('GET', `/repos/${repo.fullName}/codeowners/errors`);
    const errors = result?.errors ?? [];
    if (errors.length > 0) {
      add('CODEOWNERS', 'fail', errors.slice(0, 3).map((error) => `line ${error.line}: ${error.message ?? error.kind}`).join('; '));
      return;
    }
  } catch (error) {
    if (statusOf(error) === 404) {
      add('CODEOWNERS', 'warn', 'No CODEOWNERS file. Routing comments will say no owning team is configured.');
      return;
    }
    add('CODEOWNERS', 'warn', `Could not validate CODEOWNERS: ${messageOf(error)}`);
  }

  const path = CODEOWNERS_PATHS.find((candidate) => readFile(candidate) !== null);
  const rules = activeCodeownersRules(path ? readFile(path) : '');
  if (rules.length === 0) {
    add('CODEOWNERS', 'warn', 'No active rules. Routing comments will say no owning team is configured.');
  } else if (rules.some((rule) => /@your-org\b|@YOUR[-_]/i.test(rule))) {
    add('CODEOWNERS', 'warn', `${path} still contains placeholder owners.`);
  } else {
    add('CODEOWNERS', 'pass', `${rules.length} active rule(s) in ${path}.`);
  }
}

async function checkEnvironment(add, client, repo) {
  const path = `/repos/${repo.fullName}/environments/factory`;
  let environment;
  try {
    environment = await client.request('GET', path);
  } catch (error) {
    add('Environment', 'warn', statusOf(error) === 404
      ? 'The "factory" environment does not exist. Run setup with the "environment" step.'
      : `Could not read the "factory" environment: ${messageOf(error)}`);
    return;
  }
  if (environment?.deployment_branch_policy?.custom_branch_policies !== true) {
    add('Environment', 'warn', `"factory" lets any branch read its secrets. Run setup with the "environment" step to limit it to ${repo.defaultBranch}.`);
    return;
  }
  try {
    const policies = (await client.request('GET', `${path}/deployment-branch-policies?per_page=100`))?.branch_policies ?? [];
    const others = policies.filter((policy) => policy.name !== repo.defaultBranch || (policy.type ?? 'branch') !== 'branch').map((policy) => policy.name);
    if (!policies.some((policy) => policy.name === repo.defaultBranch)) {
      add('Environment', 'warn', `"factory" does not allow ${repo.defaultBranch}. Run setup with the "environment" step.`);
    } else if (others.length > 0) {
      add('Environment', 'warn', `"factory" also allows ${others.join(', ')}. Limit it to ${repo.defaultBranch}.`);
    } else {
      add('Environment', 'pass', `"factory" is limited to ${repo.defaultBranch}.`);
    }
  } catch (error) {
    add('Environment', 'warn', `Could not read the "factory" branch policies: ${messageOf(error)}`);
  }
}

async function checkBranchProtection(add, client, repo) {
  const branch = encodeURIComponent(repo.defaultBranch);
  try {
    const rules = await client.request('GET', `/repos/${repo.fullName}/rules/branches/${branch}`);
    if ((rules ?? []).some((rule) => rule?.type === 'pull_request')) {
      add('Default branch', 'pass', `${repo.defaultBranch} requires pull requests.`);
      return;
    }
    const details = await client.request('GET', `/repos/${repo.fullName}/branches/${branch}`);
    if (details?.protected) {
      add('Default branch', 'pass', `${repo.defaultBranch} is protected by branch protection.`);
      return;
    }
    add('Default branch', 'warn', `${repo.defaultBranch} does not require pull requests. Run setup with the "ruleset" step.`);
  } catch (error) {
    add('Default branch', 'warn', `Could not read branch rules: ${messageOf(error)}`);
  }
}

export async function runDoctor({
  client,
  readClient = null,
  agentClient = null,
  repo: fullName,
  secrets = { read: null, agent: null, bootstrap: null },
  readFile = defaultReadFile,
  config,
  labels = readLabels(),
}) {
  const checks = [];
  const add = (area, status, message) => checks.push({ area, status, message });

  const project = checkLocalFiles(add, readFile, { config, labels });

  let repo;
  try {
    const data = await client.request('GET', `/repos/${fullName}`);
    repo = {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      nodeId: data.node_id,
      defaultBranch: data.default_branch,
    };
  } catch (error) {
    add('Repository', 'fail', `Could not read ${fullName}: ${messageOf(error)}`);
    return checks;
  }

  await checkLabels(add, client, repo, labels);
  await checkWorkflowState(add, client, repo);
  checkSecrets(add, secrets);
  await checkEnvironment(add, client, repo);
  await checkProject(add, readClient, repo, project, secrets.read);
  await checkCopilot(add, agentClient, repo, secrets.agent);
  await checkIssueTypes(add, client, repo);
  await checkCodeowners(add, client, repo, readFile);
  await checkBranchProtection(add, client, repo);
  return checks;
}

const ICONS = { pass: '✅', warn: '⚠️', fail: '❌', skip: '➖' };

export function renderReport(checks, { repo }) {
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const verdict = failures > 0
    ? `❌ ${failures} problem(s) block the factory.`
    : warnings > 0 ? `⚠️ Ready, with ${warnings} warning(s).` : '✅ Ready.';
  return [
    '## Agentic Software Factory doctor',
    '',
    `Repository: \`${repo}\``,
    '',
    verdict,
    '',
    '| Check | Result | Details |',
    '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.area} | ${ICONS[check.status]} | ${String(check.message).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`),
    '',
  ].join('\n');
}

// Returns true/false when the answer is certain and null when the token could
// not list every place the secret might live (listing needs admin access).
// Factory tokens belong in environments; `exposed` names any that are also
// repository or organization secrets.
async function secretPresence(client, repo) {
  const scoped = new Set();
  const shared = new Set();
  let complete = true;
  const sources = [
    [`/repos/${repo}/environments/factory/secrets?per_page=100`, scoped],
    [`/repos/${repo}/environments/factory-bootstrap/secrets?per_page=100`, scoped],
    [`/repos/${repo}/actions/secrets?per_page=100`, shared],
    [`/repos/${repo}/actions/organization-secrets?per_page=100`, shared],
  ];
  for (const [path, names] of sources) {
    try {
      const result = await client.request('GET', path);
      for (const secret of result?.secrets ?? []) {
        names.add(secret.name);
      }
    } catch (error) {
      if (!(path.includes('/environments/') && statusOf(error) === 404)) {
        complete = false;
      }
    }
  }
  return {
    present: (name) => (scoped.has(name) || shared.has(name) ? true : complete ? false : null),
    exposed: ['GH_AW_READ_PROJECT_TOKEN', 'GH_AW_AGENT_TOKEN', 'ASF_BOOTSTRAP_TOKEN'].filter((name) => shared.has(name)),
  };
}

function detectRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const result = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('Could not detect the repository. Pass --repo owner/name.');
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = { repo: undefined, summary: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--repo' || arg === '--summary') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument "${arg}". Usage: doctor.mjs [--repo owner/name] [--summary <file>]`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = options.repo ?? detectRepository();
  const client = createGhClient();
  const readToken = process.env.GH_AW_READ_PROJECT_TOKEN || '';
  const agentToken = process.env.GH_AW_AGENT_TOKEN || '';

  let secrets;
  if (process.env.GITHUB_ACTIONS === 'true') {
    secrets = {
      read: readToken !== '',
      agent: agentToken !== '',
      bootstrap: process.env.ASF_BOOTSTRAP_TOKEN_PRESENT === 'true',
    };
  } else {
    const { present, exposed } = await secretPresence(client, repo);
    secrets = {
      read: present('GH_AW_READ_PROJECT_TOKEN'),
      agent: present('GH_AW_AGENT_TOKEN'),
      bootstrap: present('ASF_BOOTSTRAP_TOKEN'),
      exposed,
    };
  }

  const checks = await runDoctor({
    client,
    readClient: readToken ? createGhClient({ token: readToken }) : null,
    agentClient: agentToken ? createGhClient({ token: agentToken }) : null,
    repo,
    secrets,
  });
  const report = renderReport(checks, { repo });
  console.log(report);
  if (options.summary) {
    appendFileSync(options.summary, `${report}\n`);
  }
  if (checks.some((check) => check.status === 'fail')) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}
