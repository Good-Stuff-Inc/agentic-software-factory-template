#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE,
  ISSUE_TYPES,
  isValidOwner,
  isValidProjectNumber,
  loadConfig,
  NEEDS_ASSIGNMENT_VIEW,
  PROJECT_FIELDS,
  readLabels,
  writeProjectToConfig,
} from '../lib/config.mjs';
import { createGhClient, messageOf, paginate, statusOf } from '../lib/gh.mjs';

export const STEPS = ['labels', 'project', 'issue-types', 'environment', 'ruleset', 'security'];
export const ENVIRONMENT_NAME = 'factory';
export const BOOTSTRAP_ENVIRONMENT_NAME = 'factory-bootstrap';
export const RULESET_NAME = 'Agentic Software Factory: protect default branch';
const VIEWS_API_VERSION = '2026-03-10';

const USAGE = `Usage: setup.mjs [--repo owner/name] [--only step,...] [--skip step,...]
                 [--dry-run] [--commit-config] [--summary <file>]
Steps: ${STEPS.join(', ')}`;

function parseStepList(value, flag) {
  const steps = (value ?? '').split(',').map((step) => step.trim()).filter(Boolean);
  if (steps.length === 0) {
    throw new Error(`${flag} needs a comma-separated list of steps.\n${USAGE}`);
  }
  for (const step of steps) {
    if (!STEPS.includes(step)) {
      throw new Error(`Unknown step "${step}" in ${flag}.\n${USAGE}`);
    }
  }
  return steps;
}

export function parseArgs(argv) {
  const options = { repo: undefined, only: undefined, skip: [], dryRun: false, commitConfig: false, summary: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.\n${USAGE}`);
      }
      index += 1;
      return value;
    };
    if (arg === '--repo') {
      options.repo = next();
    } else if (arg === '--only') {
      options.only = parseStepList(next(), '--only');
    } else if (arg === '--skip') {
      options.skip = parseStepList(next(), '--skip');
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--commit-config') {
      options.commitConfig = true;
    } else if (arg === '--summary') {
      options.summary = next();
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }
  if (options.repo !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.repo)) {
    throw new Error(`--repo must look like owner/name, got "${options.repo}".`);
  }
  return options;
}

export function selectSteps({ only, skip = [] }) {
  return STEPS.filter((step) => (!only || only.includes(step)) && !skip.includes(step));
}

const SETUP_TOKEN_DOCS = 'See "The setup token" in docs/SETUP.md.';

// A rejected first request almost always means the setup token is wrong, so say
// which token it is and where it lives instead of printing GitHub's bare status.
function describeRepositoryError(error, fullName) {
  const status = statusOf(error);
  const message = messageOf(error);
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  if (status === 401) {
    return inActions
      ? `${message}. GitHub rejected the ASF_BOOTSTRAP_TOKEN secret in the "factory-bootstrap" environment; `
        + `it may be mistyped, expired or revoked. Store a current token there and run setup again. ${SETUP_TOKEN_DOCS}`
      : `${message}. GitHub rejected the token that gh is using. Run "gh auth status" to check it, `
        + `and unset GH_TOKEN if it holds an old token. ${SETUP_TOKEN_DOCS}`;
  }
  if (status === 404) {
    const token = inActions ? 'The ASF_BOOTSTRAP_TOKEN secret' : 'The token that gh is using';
    return `${message}. ${token} cannot read ${fullName}. Check the repository name and that the token's repository access includes it. ${SETUP_TOKEN_DOCS}`;
  }
  return message;
}

async function loadRepository(client, fullName) {
  let repo;
  try {
    repo = await client.request('GET', `/repos/${fullName}`);
  } catch (error) {
    throw new Error(describeRepositoryError(error, fullName), { cause: error });
  }
  return {
    owner: repo.owner.login,
    ownerType: repo.owner.type,
    name: repo.name,
    fullName: repo.full_name,
    nodeId: repo.node_id,
    defaultBranch: repo.default_branch,
  };
}

async function setupLabels(ctx) {
  const existing = await paginate(ctx.client, `/repos/${ctx.repo.fullName}/labels`);
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const created = [];
  const updated = [];

  for (const label of ctx.labels) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) {
      created.push(label.name);
      if (!ctx.dryRun) {
        await ctx.client.request('POST', `/repos/${ctx.repo.fullName}/labels`, { body: label });
      }
    } else if (current.name !== label.name
      || current.color.toLowerCase() !== label.color.toLowerCase()
      || (current.description ?? '') !== label.description) {
      updated.push(label.name);
      if (!ctx.dryRun) {
        await ctx.client.request('PATCH', `/repos/${ctx.repo.fullName}/labels/${encodeURIComponent(current.name)}`, {
          body: { new_name: label.name, color: label.color, description: label.description },
        });
      }
    }
  }

  if (created.length === 0 && updated.length === 0) {
    return [{ status: 'ok', message: `All ${ctx.labels.length} labels are present and current.` }];
  }
  const parts = [];
  if (created.length > 0) {
    parts.push(`${ctx.dryRun ? 'create' : 'created'} ${created.join(', ')}`);
  }
  if (updated.length > 0) {
    parts.push(`${ctx.dryRun ? 'update' : 'updated'} ${updated.join(', ')}`);
  }
  const text = parts.join('; ');
  return [{
    status: ctx.dryRun ? 'planned' : created.length > 0 ? 'created' : 'updated',
    message: ctx.dryRun ? `Would ${text}.` : `${text[0].toUpperCase()}${text.slice(1)}.`,
  }];
}

const PROJECT_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) { id number title url closed }
  }
}`;

const PROJECT_SEARCH_QUERY = `query($owner: String!, $title: String!) {
  organization(login: $owner) {
    id
    projectsV2(first: 100, query: $title) { nodes { id number title url closed } }
  }
}`;

const PROJECT_LINKS_QUERY = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2 { repositories(first: 100) { nodes { id } } } }
}`;

const PROJECT_DETAILS_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      repositories(first: 100) { nodes { id } }
      views(first: 50) { nodes { name } }
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { name } }
        }
      }
    }
  }
}`;

const CREATE_PROJECT = `mutation($ownerId: ID!, $title: String!, $repositoryId: ID!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
    projectV2 { id number title url }
  }
}`;

const LINK_PROJECT = `mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
    repository { id }
  }
}`;

const CREATE_FIELD = `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;

async function findProject(ctx, owner) {
  const { number, title } = ctx.config.project;

  if (number !== null) {
    if (!isValidProjectNumber(number)) {
      throw new Error(`"project.number" in ${CONFIG_FILE} must be a positive integer or null.`);
    }
    const data = await ctx.client.graphql(PROJECT_QUERY, { owner, number });
    const project = data?.organization?.projectV2;
    if (!project) {
      throw new Error(`Project #${number} was not found in ${owner}, or the token cannot read it. `
        + `Fix "project.number" in ${CONFIG_FILE} (or set it to null to find or create "${title}").`);
    }
    return { project, created: false };
  }

  const data = await ctx.client.graphql(PROJECT_SEARCH_QUERY, { owner, title });
  const matches = (data?.organization?.projectsV2?.nodes ?? [])
    .filter((project) => project && !project.closed && project.title === title);
  if (matches.length > 1) {
    throw new Error(`${matches.length} open projects in ${owner} are titled "${title}" `
      + `(${matches.map((project) => `#${project.number}`).join(', ')}). Set "project.number" in ${CONFIG_FILE}.`);
  }
  if (matches.length === 1) {
    const [match] = matches;
    const linked = await ctx.client.graphql(PROJECT_LINKS_QUERY, { id: match.id });
    if (!(linked?.node?.repositories?.nodes ?? []).some((repository) => repository?.id === ctx.repo.nodeId)) {
      // A same-titled project may belong to another team, so only resume one this repository already uses.
      throw new Error(`Project #${match.number} ("${title}") already exists in ${owner} but is not linked to ${ctx.repo.fullName}. `
        + `To share it, set "project.number" to ${match.number} in ${CONFIG_FILE}. To create a separate project, change "project.title".`);
    }
    return { project: match, created: false };
  }
  if (ctx.dryRun) {
    return { project: null, created: true };
  }
  const result = await ctx.client.graphql(CREATE_PROJECT, {
    ownerId: data.organization.id,
    title,
    repositoryId: ctx.repo.nodeId,
  });
  return { project: result.createProjectV2.projectV2, created: true };
}

async function commitConfig(ctx, owner, number) {
  const path = `/repos/${ctx.repo.fullName}/contents/${CONFIG_FILE}`;
  const file = await ctx.client.request('GET', `${path}?ref=${encodeURIComponent(ctx.repo.defaultBranch)}`);
  const remote = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (remote?.project?.owner === owner && remote?.project?.number === number) {
    return { status: 'ok', message: `${CONFIG_FILE} on ${ctx.repo.defaultBranch} already names project #${number}.` };
  }
  remote.project = { ...remote.project, owner, number };
  try {
    await ctx.client.request('PUT', path, {
      body: {
        message: `Configure factory project #${number}`,
        content: Buffer.from(`${JSON.stringify(remote, null, 2)}\n`).toString('base64'),
        sha: file.sha,
        branch: ctx.repo.defaultBranch,
      },
    });
  } catch (error) {
    return {
      status: 'fail',
      message: `Could not commit ${CONFIG_FILE}: ${messageOf(error)}. Open a pull request that sets `
        + `"project": { "owner": "${owner}", "number": ${number} } in ${CONFIG_FILE}.`,
    };
  }
  return { status: 'updated', message: `Committed project #${number} to ${CONFIG_FILE} on ${ctx.repo.defaultBranch}.` };
}

async function persistProject(ctx, owner, number) {
  const results = [];
  const { project } = ctx.config;
  if (project.owner !== owner || project.number !== number) {
    if (ctx.dryRun) {
      return [{ status: 'planned', message: `Would record project ${owner}#${number} in ${CONFIG_FILE}.` }];
    }
    ctx.writeLocalConfig(owner, number);
    project.owner = owner;
    project.number = number;
    if (!ctx.commitConfig) {
      results.push({
        status: 'updated',
        message: `Recorded project ${owner}#${number} in ${CONFIG_FILE}. Commit it to the default branch.`,
      });
    }
  }
  if (ctx.commitConfig) {
    results.push(await commitConfig(ctx, owner, number));
  }
  return results;
}

async function ensureView(ctx, owner, number, views) {
  if (views.includes(NEEDS_ASSIGNMENT_VIEW.name)) {
    return { status: 'ok', message: `View "${NEEDS_ASSIGNMENT_VIEW.name}" exists.` };
  }
  const manual = `Create it by hand: new table view "${NEEDS_ASSIGNMENT_VIEW.name}", filter `
    + `"${NEEDS_ASSIGNMENT_VIEW.filter}", sorted by ${NEEDS_ASSIGNMENT_VIEW.sortField} ascending.`;
  if (ctx.dryRun) {
    return { status: 'planned', message: `Would create view "${NEEDS_ASSIGNMENT_VIEW.name}".` };
  }

  const headers = { 'X-GitHub-Api-Version': VIEWS_API_VERSION };
  const base = { name: NEEDS_ASSIGNMENT_VIEW.name, layout: 'table', filter: NEEDS_ASSIGNMENT_VIEW.filter };
  try {
    const fields = await ctx.client.request('GET', `/orgs/${owner}/projectsV2/${number}/fields?per_page=100`, { headers });
    const priority = (Array.isArray(fields) ? fields : []).find((field) => field.name === NEEDS_ASSIGNMENT_VIEW.sortField);
    const path = `/orgs/${owner}/projectsV2/${number}/views`;
    if (priority?.id) {
      try {
        await ctx.client.request('POST', path, { headers, body: { ...base, sort_by: [[priority.id, 'asc']] } });
        return { status: 'created', message: `Created view "${NEEDS_ASSIGNMENT_VIEW.name}".` };
      } catch (error) {
        if (statusOf(error) !== 422) {
          throw error;
        }
      }
    }
    await ctx.client.request('POST', path, { headers, body: base });
    return {
      status: 'warn',
      message: `Created view "${NEEDS_ASSIGNMENT_VIEW.name}" without a sort. Sort it by ${NEEDS_ASSIGNMENT_VIEW.sortField} ascending by hand.`,
    };
  } catch (error) {
    return { status: 'warn', message: `Could not create view "${NEEDS_ASSIGNMENT_VIEW.name}": ${messageOf(error)}. ${manual}` };
  }
}

async function ensureFields(ctx, projectId, fields) {
  const results = [];
  const byName = new Map(fields.filter((field) => field?.name).map((field) => [field.name, field]));
  for (const wanted of PROJECT_FIELDS) {
    const current = byName.get(wanted.name);
    if (!current) {
      if (!ctx.dryRun) {
        await ctx.client.graphql(CREATE_FIELD, { projectId, name: wanted.name, options: wanted.options });
      }
      results.push({ status: ctx.dryRun ? 'planned' : 'created', message: `${ctx.dryRun ? 'Would create' : 'Created'} field "${wanted.name}".` });
      continue;
    }
    if (current.dataType !== 'SINGLE_SELECT') {
      results.push({ status: 'fail', message: `Field "${wanted.name}" exists but is ${current.dataType}, not single select. Rename or delete it, then rerun setup.` });
      continue;
    }
    const names = new Set((current.options ?? []).map((option) => option.name));
    const missing = wanted.options.filter((option) => !names.has(option.name)).map((option) => option.name);
    if (missing.length > 0) {
      results.push({
        status: 'fail',
        message: `Field "${wanted.name}" is missing option(s) ${missing.join(', ')}. Add them in the project's field settings; `
          + 'setup never edits existing options because that can clear values on existing items.',
      });
    }
  }
  if (results.length === 0) {
    results.push({ status: 'ok', message: `Fields ${PROJECT_FIELDS.map((field) => field.name).join(', ')} are present with every option.` });
  }
  return results;
}

async function setupProject(ctx) {
  if (ctx.repo.ownerType !== 'Organization') {
    return [{ status: 'fail', message: `${ctx.repo.owner} is a user account. The factory needs an organization-owned repository.` }];
  }
  const owner = ctx.config.project.owner || ctx.repo.owner;
  if (!isValidOwner(owner)) {
    return [{ status: 'fail', message: `"project.owner" in ${CONFIG_FILE} is not a valid organization login.` }];
  }
  if (owner.toLowerCase() !== ctx.repo.owner.toLowerCase()) {
    return [{ status: 'fail', message: `"project.owner" is ${owner} but the repository belongs to ${ctx.repo.owner}. A project can only link repositories from its own organization.` }];
  }

  const { project, created } = await findProject(ctx, ctx.repo.owner);
  if (!project) {
    return [{ status: 'planned', message: `Would create project "${ctx.config.project.title}" in ${ctx.repo.owner}, link it, and add its fields and view.` }];
  }

  const results = [{
    status: created ? 'created' : 'ok',
    message: `${created ? 'Created' : 'Using'} project #${project.number}: ${project.url}`,
  }];
  results.push(...await persistProject(ctx, ctx.repo.owner, project.number));

  const details = (await ctx.client.graphql(PROJECT_DETAILS_QUERY, { id: project.id }))?.node ?? {};
  const linked = (details.repositories?.nodes ?? []).some((repository) => repository?.id === ctx.repo.nodeId);
  if (!linked) {
    if (!ctx.dryRun) {
      await ctx.client.graphql(LINK_PROJECT, { projectId: project.id, repositoryId: ctx.repo.nodeId });
    }
    results.push({ status: ctx.dryRun ? 'planned' : 'created', message: `${ctx.dryRun ? 'Would link' : 'Linked'} the project to ${ctx.repo.fullName}.` });
  }

  results.push(...await ensureFields(ctx, project.id, details.fields?.nodes ?? []));
  const views = (details.views?.nodes ?? []).map((view) => view?.name);
  results.push(await ensureView(ctx, ctx.repo.owner, project.number, views));
  return results;
}

const REPOSITORY_ISSUE_TYPES = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { issueTypes(first: 50) { nodes { name } } }
}`;

async function setupIssueTypes(ctx) {
  if (ctx.repo.ownerType !== 'Organization') {
    return [{ status: 'fail', message: 'Issue types are an organization feature; the repository must be organization-owned.' }];
  }
  let existing;
  try {
    existing = await ctx.client.request('GET', `/orgs/${ctx.repo.owner}/issue-types`);
  } catch (error) {
    const data = await ctx.client.graphql(REPOSITORY_ISSUE_TYPES, { owner: ctx.repo.owner, name: ctx.repo.name });
    const available = new Set((data?.repository?.issueTypes?.nodes ?? []).map((type) => type?.name));
    const missing = ISSUE_TYPES.filter((type) => !available.has(type.name)).map((type) => type.name);
    if (missing.length === 0) {
      return [{ status: 'ok', message: `Issue types ${ISSUE_TYPES.map((type) => type.name).join(', ')} are available.` }];
    }
    return [{
      status: 'fail',
      message: `Issue type(s) ${missing.join(', ')} are not available and the token cannot manage organization issue types `
        + `(${messageOf(error)}). Ask an organization owner to create or enable them under Settings → Issue types.`,
    }];
  }

  const byName = new Map((existing ?? []).map((type) => [type.name.toLowerCase(), type]));
  const changes = [];
  for (const wanted of ISSUE_TYPES) {
    const current = byName.get(wanted.name.toLowerCase());
    if (!current) {
      changes.push(`create ${wanted.name}`);
      if (!ctx.dryRun) {
        await ctx.client.request('POST', `/orgs/${ctx.repo.owner}/issue-types`, { body: { ...wanted, is_enabled: true } });
      }
    } else if (current.is_enabled === false) {
      changes.push(`enable ${current.name}`);
      if (!ctx.dryRun) {
        await ctx.client.request('PUT', `/orgs/${ctx.repo.owner}/issue-types/${current.id}`, {
          body: { name: current.name, is_enabled: true },
        });
      }
    }
  }
  if (changes.length === 0) {
    return [{ status: 'ok', message: `Issue types ${ISSUE_TYPES.map((type) => type.name).join(', ')} are enabled.` }];
  }
  return [{ status: ctx.dryRun ? 'planned' : 'updated', message: `${ctx.dryRun ? 'Would ' : ''}${changes.join('; ')}.` }];
}

const RESTRICTED_BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

// Repository secrets reach workflows on every branch, so the factory tokens live
// in environments that only the default branch can deploy to.
async function ensureEnvironment(ctx, name, { create }) {
  const path = `/repos/${ctx.repo.fullName}/environments/${encodeURIComponent(name)}`;
  const branch = ctx.repo.defaultBranch;
  let existing = null;
  try {
    existing = await ctx.client.request('GET', path);
  } catch (error) {
    if (statusOf(error) !== 404) {
      const hint = statusOf(error) === 403
        ? ' A fine-grained token needs "Actions: Read" to read environments. Add it, then run setup again.'
        : '';
      return { status: 'warn', message: `Could not read the "${name}" environment: ${messageOf(error)}.${hint}` };
    }
  }
  if (!existing && !create) {
    return null;
  }

  const restricted = existing?.deployment_branch_policy?.custom_branch_policies === true;
  let policies = [];
  if (restricted) {
    policies = (await ctx.client.request('GET', `${path}/deployment-branch-policies?per_page=100`))?.branch_policies ?? [];
  }
  const isDefault = (policy) => policy.name === branch && (policy.type ?? 'branch') === 'branch';
  const others = policies.filter((policy) => !isDefault(policy)).map((policy) => policy.name);
  const othersNote = others.length > 0
    ? ` It also allows ${others.join(', ')}; remove those so only ${branch} can read its secrets.`
    : '';
  if (restricted && policies.some(isDefault)) {
    return others.length > 0
      ? { status: 'warn', message: `Environment "${name}" is limited to ${branch}.${othersNote}` }
      : { status: 'ok', message: `Environment "${name}" is limited to ${branch}.` };
  }

  const action = existing ? `restrict environment "${name}" to ${branch}` : `create environment "${name}", limited to ${branch}`;
  if (ctx.dryRun) {
    return { status: 'planned', message: `Would ${action}.` };
  }
  try {
    if (!restricted) {
      const rules = existing?.protection_rules ?? [];
      const timer = rules.find((rule) => rule.type === 'wait_timer');
      const review = rules.find((rule) => rule.type === 'required_reviewers');
      await ctx.client.request('PUT', path, {
        body: {
          ...(timer ? { wait_timer: timer.wait_timer } : {}),
          ...(review ? {
            prevent_self_review: review.prevent_self_review === true,
            reviewers: (review.reviewers ?? []).map((entry) => ({ type: entry.type, id: entry.reviewer?.id })),
          } : {}),
          deployment_branch_policy: RESTRICTED_BRANCH_POLICY,
        },
      });
    }
    await ctx.client.request('POST', `${path}/deployment-branch-policies`, { body: { name: branch, type: 'branch' } });
  } catch (error) {
    return {
      status: 'warn',
      message: `Could not ${action} (${messageOf(error)}). Environment branch policies on private repositories need GitHub Team or Enterprise. `
        + 'Without them the factory tokens must be repository secrets, which every writer can read.',
    };
  }
  const verb = existing ? 'Restricted' : 'Created';
  return { status: existing ? 'updated' : 'created', message: `${verb} environment "${name}", limited to ${branch}.${othersNote}` };
}

async function setupEnvironment(ctx) {
  const results = [await ensureEnvironment(ctx, ENVIRONMENT_NAME, { create: true })];
  results.push(await ensureEnvironment(ctx, BOOTSTRAP_ENVIRONMENT_NAME, { create: false }));
  return results.filter(Boolean);
}

export function rulesetBody(requiredApprovals, { copilotReview = true } = {}) {
  const rules = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: requiredApprovals,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: requiredApprovals > 0,
        required_review_thread_resolution: false,
      },
    },
  ];
  if (copilotReview) {
    rules.push({ type: 'copilot_code_review', parameters: { review_on_push: true, review_draft_pull_requests: false } });
  }
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules,
  };
}

async function setupRuleset(ctx) {
  if (!ctx.config.ruleset.enabled) {
    return [{ status: 'skipped', message: `Disabled by "ruleset.enabled" in ${CONFIG_FILE}.` }];
  }
  const path = `/repos/${ctx.repo.fullName}/rulesets`;
  let rulesets;
  try {
    rulesets = await paginate(ctx.client, `${path}?includes_parents=false`);
  } catch (error) {
    return [{ status: 'warn', message: `Could not read rulesets (${messageOf(error)}). Rulesets on private repositories need GitHub Team or Enterprise.` }];
  }
  if (rulesets.some((ruleset) => ruleset.name === RULESET_NAME)) {
    return [{ status: 'ok', message: `Ruleset "${RULESET_NAME}" exists (left unchanged).` }];
  }
  if (ctx.dryRun) {
    return [{ status: 'planned', message: `Would create ruleset "${RULESET_NAME}".` }];
  }
  const approvals = ctx.config.ruleset.requiredApprovals;
  try {
    await ctx.client.request('POST', path, { body: rulesetBody(approvals) });
    return [{ status: 'created', message: `Created ruleset "${RULESET_NAME}" with Copilot code review.` }];
  } catch (error) {
    if (statusOf(error) !== 422) {
      return [{ status: 'warn', message: `Could not create ruleset (${messageOf(error)}). Rulesets on private repositories need GitHub Team or Enterprise.` }];
    }
  }
  try {
    await ctx.client.request('POST', path, { body: rulesetBody(approvals, { copilotReview: false }) });
    return [{
      status: 'warn',
      message: `Created ruleset "${RULESET_NAME}" without automatic Copilot code review, which this repository rejected. Enable it in the ruleset by hand if your plan supports it.`,
    }];
  } catch (error) {
    return [{ status: 'warn', message: `Could not create ruleset: ${messageOf(error)}.` }];
  }
}

async function setupSecurity(ctx) {
  if (!ctx.config.security.enabled) {
    return [{ status: 'skipped', message: `Disabled by "security.enabled" in ${CONFIG_FILE}.` }];
  }
  if (ctx.dryRun) {
    return [{ status: 'planned', message: 'Would enable secret scanning, push protection, Dependabot alerts and CodeQL default setup.' }];
  }
  const attempts = [
    ['Secret scanning and push protection', () => ctx.client.request('PATCH', `/repos/${ctx.repo.fullName}`, {
      body: {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      },
    })],
    ['Dependabot alerts', () => ctx.client.request('PUT', `/repos/${ctx.repo.fullName}/vulnerability-alerts`)],
    ['CodeQL default setup', () => ctx.client.request('PATCH', `/repos/${ctx.repo.fullName}/code-scanning/default-setup`, {
      body: { state: 'configured' },
    })],
  ];
  const results = [];
  for (const [name, attempt] of attempts) {
    try {
      await attempt();
      results.push({ status: 'ok', message: `${name} enabled.` });
    } catch (error) {
      results.push({ status: 'warn', message: `${name} not enabled: ${messageOf(error)}. Private repositories may need GitHub Advanced Security.` });
    }
  }
  return results;
}

const HANDLERS = {
  labels: setupLabels,
  project: setupProject,
  'issue-types': setupIssueTypes,
  environment: setupEnvironment,
  ruleset: setupRuleset,
  security: setupSecurity,
};

export async function runSetup({
  client,
  repo,
  steps = STEPS,
  config = loadConfig(),
  labels = readLabels(),
  dryRun = false,
  commitConfig: shouldCommit = false,
  writeLocalConfig = writeProjectToConfig,
  log = console.log,
}) {
  const ctx = {
    client,
    repo: await loadRepository(client, repo),
    config,
    labels,
    dryRun,
    commitConfig: shouldCommit,
    writeLocalConfig,
  };
  const results = [];
  for (const step of steps) {
    log(`→ ${step}`);
    let stepResults;
    if (step === 'ruleset' && results.some((result) => result.status === 'fail')) {
      // The ruleset requires pull requests on the default branch, which would block
      // the direct commit that a failed step may ask the user to make.
      stepResults = [{
        status: 'skipped',
        message: 'Not applied because an earlier step failed. The ruleset would require pull requests on the default branch '
          + 'before you can fix that step. Fix the ❌ rows and run setup again.',
      }];
    } else {
      try {
        stepResults = await HANDLERS[step](ctx);
      } catch (error) {
        stepResults = [{ status: 'fail', message: messageOf(error) }];
      }
    }
    for (const result of stepResults) {
      results.push({ step, ...result });
      log(`  ${ICONS[result.status] ?? ''} ${result.message}`);
    }
  }
  return results;
}

const ICONS = {
  ok: '✅',
  created: '🆕',
  updated: '🔄',
  planned: '📝',
  skipped: '⏭️',
  warn: '⚠️',
  fail: '❌',
};

function escapeCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderSummary(results, { repo, dryRun }) {
  const lines = [
    `## Agentic Software Factory setup${dryRun ? ' (dry run)' : ''}`,
    '',
    `Repository: \`${repo}\``,
    '',
    '| Step | Result | Details |',
    '| --- | --- | --- |',
    ...results.map((result) => `| ${result.step} | ${ICONS[result.status]} ${result.status} | ${escapeCell(result.message)} |`),
    '',
  ];
  const failed = results.some((result) => result.status === 'fail');
  lines.push(failed
    ? 'Setup did not finish. Fix the ❌ rows and run it again; every step is safe to repeat.'
    : 'Next: add the factory secrets, run the **Factory doctor** workflow, then delete `ASF_BOOTSTRAP_TOKEN`. See docs/SETUP.md.');
  return `${lines.join('\n')}\n`;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const repo = options.repo ?? detectRepository();
  let results;
  try {
    results = await runSetup({
      client: createGhClient(),
      repo,
      steps: selectSteps(options),
      dryRun: options.dryRun,
      commitConfig: options.commitConfig,
    });
  } catch (error) {
    // Without this the Actions run page shows a red job and an empty summary.
    if (options.summary) {
      appendFileSync(options.summary, renderSummary([{ step: 'repository', status: 'fail', message: messageOf(error) }], { repo, dryRun: options.dryRun }));
    }
    throw error;
  }
  const summary = renderSummary(results, { repo, dryRun: options.dryRun });
  console.log(`\n${summary}`);
  if (options.summary) {
    appendFileSync(options.summary, summary);
  }
  if (results.some((result) => result.status === 'fail')) {
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
