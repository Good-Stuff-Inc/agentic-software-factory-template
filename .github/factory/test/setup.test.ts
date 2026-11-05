import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_FIELDS, type FactoryConfig } from '../lib/config.mjs';
import { parseArgs, RULESET_NAME, renderSummary, rulesetBody, runSetup, selectSteps } from '../scripts/setup.mjs';
import { fakeClient, httpError, orgRepo } from './fake-github.js';

const labels = [
  { name: 'type:bug', color: 'd73a4a', description: 'Existing behaviour is wrong' },
  { name: 'needs-assignment', color: 'fef2c0', description: 'Waiting for a human' },
];

function config(project: Partial<FactoryConfig['project']> = {}): FactoryConfig {
  return {
    project: { owner: '', number: null, title: 'Agentic Software Factory', ...project },
    ruleset: { enabled: true, requiredApprovals: 1 },
    security: { enabled: true },
  };
}

function completeFields() {
  return PROJECT_FIELDS.map((field) => ({
    id: `${field.name}_ID`,
    name: field.name,
    dataType: 'SINGLE_SELECT',
    options: field.options.map((option) => ({ name: option.name })),
  }));
}

function projectDetails({ linked = true, fields = completeFields(), views = ['Needs assignment'] } = {}) {
  return {
    node: {
      repositories: { nodes: linked ? [{ id: 'REPO_ID' }] : [] },
      views: { nodes: views.map((name) => ({ name })) },
      fields: { nodes: fields },
    },
  };
}

function run(client: ReturnType<typeof fakeClient>['client'], steps: string[], overrides: Partial<Parameters<typeof runSetup>[0]> = {}) {
  return runSetup({
    client,
    repo: 'octo-org/example',
    steps,
    config: config(),
    labels,
    writeLocalConfig: vi.fn(),
    log: () => undefined,
    ...overrides,
  });
}

describe('setup arguments', () => {
  it('runs every step in order unless narrowed', () => {
    expect(selectSteps(parseArgs([]))).toEqual(['labels', 'project', 'issue-types', 'environment', 'ruleset', 'security']);
    expect(selectSteps(parseArgs(['--only', 'security,labels']))).toEqual(['labels', 'security']);
    expect(selectSteps(parseArgs(['--skip', 'ruleset']))).not.toContain('ruleset');
  });

  it('rejects unknown steps and malformed repositories', () => {
    expect(() => parseArgs(['--only', 'labels,everything'])).toThrow(/Unknown step "everything"/);
    expect(() => parseArgs(['--repo', 'octo-org/example;rm -rf /'])).toThrow(/owner\/name/);
    expect(() => parseArgs(['--repo'])).toThrow(/needs a value/);
  });
});

describe('labels step', () => {
  it('creates missing labels and corrects drifted ones by their current name', async () => {
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/labels': [{ name: 'Type:Bug', color: 'ffffff', description: 'old' }],
        'POST /repos/octo-org/example/labels': {},
        'PATCH /repos/octo-org/example/labels/Type%3ABug': {},
      },
    });

    const results = await run(client, ['labels']);

    expect(results).toEqual([{ step: 'labels', status: 'created', message: 'Created needs-assignment; updated type:bug.' }]);
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ['PATCH', '/repos/octo-org/example/labels/Type%3ABug', { new_name: 'type:bug', color: 'd73a4a', description: 'Existing behaviour is wrong' }],
      ['POST', '/repos/octo-org/example/labels', labels[1]],
    ]);
  });

  it('changes nothing when labels already match', async () => {
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo, 'GET /repos/octo-org/example/labels': labels },
    });

    expect((await run(client, ['labels']))[0]?.status).toBe('ok');
    expect(writes()).toEqual([]);
  });
});

describe('project step', () => {
  function newProjectClient() {
    return fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /orgs/octo-org/projectsV2/7/fields': [{ id: 101, name: 'Priority' }],
        'POST /orgs/octo-org/projectsV2/7/views': {},
      },
      graphql: {
        organization: { organization: { id: 'ORG_ID', projectsV2: { nodes: [] } } },
        createProjectV2: { createProjectV2: { projectV2: { id: 'PROJECT_ID', number: 7, title: 'Agentic Software Factory', url: 'https://github.com/orgs/octo-org/projects/7' } } },
        node: projectDetails({ fields: [], views: [] }),
        createProjectV2Field: { createProjectV2Field: { projectV2Field: { id: 'F' } } },
      },
    });
  }

  it('creates, records, and fully configures a new project', async () => {
    const { client, calls } = newProjectClient();
    const writeLocalConfig = vi.fn();

    const results = await run(client, ['project'], { writeLocalConfig });

    expect(results.map((result) => result.status)).toEqual(['created', 'updated', 'created', 'created', 'created', 'created']);
    expect(writeLocalConfig).toHaveBeenCalledWith('octo-org', 7);
    const create = calls.find((call) => /createProjectV2\(/.test(call.query ?? ''));
    expect(create?.variables).toEqual({ ownerId: 'ORG_ID', title: 'Agentic Software Factory', repositoryId: 'REPO_ID' });
    const fields = calls.filter((call) => /createProjectV2Field/.test(call.query ?? ''));
    expect(fields.map((call) => call.variables.name)).toEqual(['Proposed Type', 'Priority', 'Complexity']);
    expect(fields[1]?.variables.options).toContainEqual({ name: 'P0', color: 'RED', description: 'Outage, data loss or security incident' });
    const view = calls.find((call) => call.method === 'POST' && call.path?.endsWith('/views'));
    expect(view?.headers).toEqual({ 'X-GitHub-Api-Version': '2026-03-10' });
    expect(view?.body).toEqual({
      name: 'Needs assignment',
      layout: 'table',
      filter: 'is:issue is:open no:assignee label:needs-assignment',
      sort_by: [[101, 'asc']],
    });
  });

  it('plans without writing on a dry run', async () => {
    const { client, writes } = newProjectClient();
    const writeLocalConfig = vi.fn();

    const results = await run(client, ['project'], { dryRun: true, writeLocalConfig });

    expect(results).toEqual([{ step: 'project', status: 'planned', message: expect.stringContaining('Would create project') }]);
    expect(writes()).toEqual([]);
    expect(writeLocalConfig).not.toHaveBeenCalled();
  });

  it('refuses to guess between projects with the same title', async () => {
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo },
      graphql: {
        organization: {
          organization: {
            id: 'ORG_ID',
            projectsV2: { nodes: [3, 9].map((number) => ({ id: `P${number}`, number, title: 'Agentic Software Factory', closed: false })) },
          },
        },
      },
    });

    const [result] = await run(client, ['project']);

    expect(result?.status).toBe('fail');
    expect(result?.message).toMatch(/#3, #9.*Set "project\.number"/);
    expect(writes()).toEqual([]);
  });

  it('does not adopt an unlinked project that only shares the title', async () => {
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo },
      graphql: {
        organization: {
          organization: {
            id: 'ORG_ID',
            projectsV2: { nodes: [{ id: 'P4', number: 4, title: 'Agentic Software Factory', url: 'u', closed: false }] },
          },
        },
        node: projectDetails({ linked: false }),
      },
    });
    const writeLocalConfig = vi.fn();

    for (const dryRun of [true, false]) {
      const [result] = await run(client, ['project'], { dryRun, writeLocalConfig });

      expect(result?.status).toBe('fail');
      expect(result?.message).toMatch(/#4 .*not linked to octo-org\/example.*"project\.number" to 4.*"project\.title"/);
    }
    expect(writes()).toEqual([]);
    expect(writeLocalConfig).not.toHaveBeenCalled();
  });

  it('never creates a replacement when the configured project is missing', async () => {
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo },
      graphql: { organization: { organization: { projectV2: null } } },
    });

    const [result] = await run(client, ['project'], { config: config({ owner: 'octo-org', number: 12 }) });

    expect(result?.status).toBe('fail');
    expect(result?.message).toMatch(/Project #12 was not found/);
    expect(writes()).toEqual([]);
  });

  it('links an existing project and reports missing options instead of editing them', async () => {
    const fields = completeFields();
    fields[1] = { ...fields[1]!, options: [{ name: 'P1' }, { name: 'P2' }] };
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo },
      graphql: {
        organization: { organization: { projectV2: { id: 'PROJECT_ID', number: 7, url: 'https://github.com/orgs/octo-org/projects/7' } } },
        node: projectDetails({ linked: false, fields }),
        linkProjectV2ToRepository: {},
      },
    });

    const results = await run(client, ['project'], { config: config({ owner: 'octo-org', number: 7 }) });

    expect(results.map((result) => result.status)).toEqual(['ok', 'created', 'fail', 'ok']);
    expect(results[2]?.message).toMatch(/"Priority" is missing option\(s\) P0, P3/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.query).toMatch(/linkProjectV2ToRepository/);
  });

  it('falls back to an unsorted view when sorting is rejected', async () => {
    const { client, calls } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /orgs/octo-org/projectsV2/7/fields': [{ id: 101, name: 'Priority' }],
        'POST /orgs/octo-org/projectsV2/7/views': (call: { body: { sort_by?: unknown } }) => {
          if (call.body.sort_by) {
            throw httpError(422);
          }
          return {};
        },
      },
      graphql: {
        organization: { organization: { projectV2: { id: 'PROJECT_ID', number: 7, url: 'u' } } },
        node: projectDetails({ views: [] }),
      },
    });

    const results = await run(client, ['project'], { config: config({ owner: 'octo-org', number: 7 }) });

    expect(results.at(-1)).toEqual({ step: 'project', status: 'warn', message: expect.stringContaining('without a sort') });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('commits the project number to the default branch when asked', async () => {
    const remote = { project: { owner: '', number: null, title: 'Agentic Software Factory' }, security: { enabled: true } };
    const { client, calls } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/contents/.github/factory/config.json': {
          sha: 'SHA', content: Buffer.from(JSON.stringify(remote)).toString('base64'),
        },
        'PUT /repos/octo-org/example/contents/.github/factory/config.json': {},
      },
      graphql: {
        organization: { organization: { projectV2: null, id: 'ORG_ID', projectsV2: { nodes: [{ id: 'PROJECT_ID', number: 7, title: 'Agentic Software Factory', url: 'u', closed: false }] } } },
        node: projectDetails(),
      },
    });

    const results = await run(client, ['project'], { commitConfig: true });

    expect(results[1]).toEqual({ step: 'project', status: 'updated', message: expect.stringContaining('Committed project #7') });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body.sha).toBe('SHA');
    expect(put?.body.branch).toBe('main');
    expect(JSON.parse(Buffer.from(put?.body.content, 'base64').toString('utf8'))).toEqual({
      project: { owner: 'octo-org', number: 7, title: 'Agentic Software Factory' },
      security: { enabled: true },
    });
  });

  it('requires an organization-owned repository', async () => {
    const { client } = fakeClient({
      rest: { 'GET /repos/octo-org/example': { ...orgRepo, owner: { login: 'octocat', type: 'User' } } },
    });

    const [result] = await run(client, ['project']);

    expect(result).toEqual({ step: 'project', status: 'fail', message: expect.stringContaining('organization-owned') });
  });
});

describe('issue types step', () => {
  it('creates missing types and enables disabled ones', async () => {
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /orgs/octo-org/issue-types': [
          { id: 1, name: 'Bug', is_enabled: false },
          { id: 2, name: 'Feature', is_enabled: true },
        ],
        'PUT /orgs/octo-org/issue-types/1': {},
        'POST /orgs/octo-org/issue-types': {},
      },
    });

    const [result] = await run(client, ['issue-types']);

    expect(result).toEqual({ step: 'issue-types', status: 'updated', message: 'enable Bug; create Task.' });
    expect(writes().map((call) => [call.method, call.body])).toEqual([
      ['PUT', { name: 'Bug', is_enabled: true }],
      ['POST', { name: 'Task', description: 'A specific piece of work', color: 'yellow', is_enabled: true }],
    ]);
  });

  it('accepts existing types when the token cannot manage them', async () => {
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /orgs/octo-org/issue-types': () => {
          throw httpError(403);
        },
      },
      graphql: { repository: { repository: { issueTypes: { nodes: [{ name: 'Bug' }, { name: 'Feature' }, { name: 'Task' }] } } } },
    });

    expect((await run(client, ['issue-types']))[0]?.status).toBe('ok');
  });
});

describe('environment step', () => {
  const factoryPath = '/repos/octo-org/example/environments/factory';
  const bootstrapPath = '/repos/octo-org/example/environments/factory-bootstrap';

  it('creates the factory environment limited to the default branch', async () => {
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`PUT ${factoryPath}`]: {},
        [`POST ${factoryPath}/deployment-branch-policies`]: {},
      },
    });

    const results = await run(client, ['environment']);

    expect(results.map((result) => result.status)).toEqual(['created']);
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ['PUT', factoryPath, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }],
      ['POST', `${factoryPath}/deployment-branch-policies`, { name: 'main', type: 'branch' }],
    ]);
  });

  it('restricts an auto-created environment and keeps its reviewers', async () => {
    const unrestricted = {
      deployment_branch_policy: null,
      protection_rules: [
        { type: 'wait_timer', wait_timer: 5 },
        { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 42 } }] },
      ],
    };
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`GET ${factoryPath}`]: unrestricted,
        [`GET ${bootstrapPath}`]: unrestricted,
        [`PUT ${factoryPath}`]: {},
        [`PUT ${bootstrapPath}`]: {},
        [`POST ${factoryPath}/deployment-branch-policies`]: {},
        [`POST ${bootstrapPath}/deployment-branch-policies`]: {},
      },
    });

    const results = await run(client, ['environment']);

    expect(results.map((result) => result.status)).toEqual(['updated', 'updated']);
    expect(writes()[0]?.body).toEqual({
      wait_timer: 5,
      prevent_self_review: true,
      reviewers: [{ type: 'User', id: 42 }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
  });

  it('accepts a restricted environment and flags extra branches', async () => {
    const restricted = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [] };
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`GET ${factoryPath}`]: restricted,
        [`GET ${factoryPath}/deployment-branch-policies`]: { branch_policies: [{ name: 'main', type: 'branch' }] },
        [`GET ${bootstrapPath}`]: restricted,
        [`GET ${bootstrapPath}/deployment-branch-policies`]: { branch_policies: [{ name: 'main', type: 'branch' }, { name: '*', type: 'branch' }] },
      },
    });

    const results = await run(client, ['environment']);

    expect(results.map((result) => result.status)).toEqual(['ok', 'warn']);
    expect(results[1]?.message).toMatch(/also allows \*/);
    expect(writes()).toEqual([]);
  });

  it('plans without writing on a dry run', async () => {
    const { client, writes } = fakeClient({ rest: { 'GET /repos/octo-org/example': orgRepo } });

    expect((await run(client, ['environment'], { dryRun: true })).map((result) => result.status)).toEqual(['planned']);
    expect(writes()).toEqual([]);
  });

  it('names the missing Actions permission when the token cannot read environments', async () => {
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`GET ${factoryPath}`]: () => {
          throw httpError(403, 'Resource not accessible by personal access token');
        },
      },
    });

    const [result] = await run(client, ['environment']);

    expect(result?.status).toBe('warn');
    expect(result?.message).toMatch(/Could not read the "factory" environment.*Actions: Read.*run setup again/);
    expect(writes()).toEqual([]);
  });

  it('does not blame permissions when the environment read fails for another reason', async () => {
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`GET ${factoryPath}`]: () => {
          throw httpError(500, 'Server Error');
        },
      },
    });

    const [result] = await run(client, ['environment']);

    expect(result?.status).toBe('warn');
    expect(result?.message).not.toMatch(/Actions: Read/);
  });

  it('warns when the plan does not support environment branch policies', async () => {
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        [`PUT ${factoryPath}`]: () => {
          throw httpError(422, 'Upgrade to GitHub Team');
        },
      },
    });

    const [result] = await run(client, ['environment']);

    expect(result?.status).toBe('warn');
    expect(result?.message).toMatch(/repository secrets/);
  });
});

describe('ruleset step', () => {
  it('retries without Copilot review when the repository rejects it', async () => {
    const posted: any[] = [];
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/rulesets': [],
        'POST /repos/octo-org/example/rulesets': (call: { body: any }) => {
          posted.push(call.body);
          if (call.body.rules.some((rule: { type: string }) => rule.type === 'copilot_code_review')) {
            throw httpError(422);
          }
          return {};
        },
      },
    });

    const [result] = await run(client, ['ruleset']);

    expect(result?.status).toBe('warn');
    expect(posted).toHaveLength(2);
    expect(posted[1].name).toBe(RULESET_NAME);
    expect(posted[1].conditions).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } });
    expect(posted[1].rules.find((rule: { type: string }) => rule.type === 'pull_request').parameters.required_approving_review_count).toBe(1);
  });

  it('stops the last pusher from approving their own changes', () => {
    const pullRequest = rulesetBody(1).rules.find((rule: { type: string }) => rule.type === 'pull_request');

    expect(pullRequest?.parameters).toMatchObject({ require_last_push_approval: true, dismiss_stale_reviews_on_push: true });
  });

  it('lets a solo user merge their own pull request when no approvals are required', () => {
    const pullRequest = rulesetBody(0).rules.find((rule: { type: string }) => rule.type === 'pull_request');

    expect(pullRequest?.parameters).toMatchObject({ required_approving_review_count: 0, require_last_push_approval: false });
  });

  it('is not applied after an earlier step failed, so a half-finished setup cannot lock the branch', async () => {
    const { client, writes } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/rulesets': [],
        'POST /repos/octo-org/example/rulesets': {},
      },
      graphql: {
        organization: {
          organization: {
            id: 'ORG_ID',
            projectsV2: { nodes: [3, 9].map((number) => ({ id: `P${number}`, number, title: 'Agentic Software Factory', closed: false })) },
          },
        },
      },
    });

    const results = await run(client, ['project', 'ruleset']);

    expect(results.map((result) => [result.step, result.status])).toEqual([['project', 'fail'], ['ruleset', 'skipped']]);
    expect(results[1]?.message).toMatch(/earlier step failed.*run setup again/);
    expect(writes()).toEqual([]);
  });

  it('is still applied after earlier steps that succeeded', async () => {
    const posted: any[] = [];
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/labels': labels,
        'GET /repos/octo-org/example/rulesets': [],
        'POST /repos/octo-org/example/rulesets': (call: { body: any }) => {
          posted.push(call.body);
          return {};
        },
      },
    });

    const results = await run(client, ['labels', 'ruleset']);

    expect(results.map((result) => [result.step, result.status])).toEqual([['labels', 'ok'], ['ruleset', 'created']]);
    expect(posted).toHaveLength(1);
  });

  it('leaves an existing factory ruleset alone', async () => {
    const { client, writes } = fakeClient({
      rest: { 'GET /repos/octo-org/example': orgRepo, 'GET /repos/octo-org/example/rulesets': [{ id: 1, name: RULESET_NAME }] },
    });

    expect((await run(client, ['ruleset']))[0]?.status).toBe('ok');
    expect(writes()).toEqual([]);
  });

  it('warns rather than fails when rulesets are unavailable', async () => {
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/rulesets': [],
        'POST /repos/octo-org/example/rulesets': () => {
          throw httpError(403, 'Upgrade to GitHub Team');
        },
      },
    });

    expect((await run(client, ['ruleset']))[0]?.status).toBe('warn');
  });
});

describe('security step', () => {
  it('enables what it can and warns about the rest', async () => {
    const { client } = fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'PATCH /repos/octo-org/example': {},
        'PUT /repos/octo-org/example/vulnerability-alerts': {},
        'PATCH /repos/octo-org/example/code-scanning/default-setup': () => {
          throw httpError(403, 'Advanced Security must be enabled');
        },
      },
    });

    const results = await run(client, ['security']);

    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'warn']);
  });

  it('respects the config switch', async () => {
    const { client, writes } = fakeClient({ rest: { 'GET /repos/octo-org/example': orgRepo } });

    const results = await run(client, ['security'], { config: { ...config(), security: { enabled: false } } });

    expect(results[0]?.status).toBe('skipped');
    expect(writes()).toEqual([]);
  });
});

describe('repository access', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function rejectRepository(status: number, message: string) {
    return fakeClient({
      rest: {
        'GET /repos/octo-org/example': () => {
          throw httpError(status, message);
        },
      },
    });
  }

  it('names the bootstrap secret when GitHub rejects the token in Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const { client } = rejectRepository(401, 'Bad credentials');

    await expect(run(client, ['labels'])).rejects.toThrow(
      /^Bad credentials \(HTTP 401\)\. .*ASF_BOOTSTRAP_TOKEN secret in the "factory-bootstrap" environment.*docs\/SETUP\.md/,
    );
  });

  it('points at the gh login when GitHub rejects the token locally', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const { client } = rejectRepository(401, 'Bad credentials');

    await expect(run(client, ['labels'])).rejects.toThrow(
      /^Bad credentials \(HTTP 401\)\. .*token that gh is using.*gh auth status.*GH_TOKEN.*docs\/SETUP\.md/,
    );
  });

  it('says when the token cannot see the repository', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const { client } = rejectRepository(404, 'Not Found');

    await expect(run(client, ['labels'])).rejects.toThrow(
      /^Not Found \(HTTP 404\)\. .*cannot read octo-org\/example.*repository access.*docs\/SETUP\.md/,
    );
  });

  it('leaves any other failure as GitHub reported it', async () => {
    const { client } = rejectRepository(500, 'Server Error');

    await expect(run(client, ['labels'])).rejects.toThrow(/^Server Error \(HTTP 500\)$/);
  });
});

describe('setup command', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Runs the real script against a `gh` on PATH that always answers 401, as it
  // does when the bootstrap secret holds a mistyped, expired or revoked token.
  it('explains a rejected token on stderr and in the run summary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'setup-command-'));
    directories.push(directory);
    const gh = join(directory, 'gh');
    writeFileSync(gh, '#!/usr/bin/env node\nprocess.stderr.write("gh: Bad credentials (HTTP 401)\\n");\nprocess.exit(1);\n');
    chmodSync(gh, 0o755);
    const summaryPath = join(directory, 'summary.md');
    writeFileSync(summaryPath, '');

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url)),
      '--repo', 'octo-org/example',
      '--summary', summaryPath,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, GITHUB_ACTIONS: 'true' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Bad credentials \(HTTP 401\)\. .*ASF_BOOTSTRAP_TOKEN/);
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toMatch(/\| repository \| ❌ fail \| Bad credentials \(HTTP 401\)\. .*ASF_BOOTSTRAP_TOKEN/);
    expect(summary).toContain('Setup did not finish');
  });
});

describe('setup summary', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a | b', String.raw`a \| b`],
    [String.raw`a\b`, String.raw`a\\b`],
    [String.raw`a\|b`, String.raw`a\\\|b`],
    [String.raw`a\\|b`, String.raw`a\\\\\|b`],
    ['a\nb\r\nc', 'a b c'],
  ])('escapes summary table-cell message %j', (message, escaped) => {
    const summary = renderSummary([{ step: 'labels', status: 'ok', message }], { repo: 'octo-org/example', dryRun: false });

    expect(summary).toContain(`| labels | ✅ ok | ${escaped} |`);
  });

  it('escapes table cells and points at the next step', () => {
    const summary = renderSummary([{ step: 'labels', status: 'ok', message: 'a | b' }], { repo: 'octo-org/example', dryRun: false });

    expect(summary).toContain('| labels | ✅ ok | a \\| b |');
    expect(summary).toContain('Factory doctor');
  });
});
