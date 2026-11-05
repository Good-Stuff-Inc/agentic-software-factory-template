import { describe, expect, it } from 'vitest';

import { PROJECT_FIELDS, type FactoryConfig, type FactoryLabel } from '../lib/config.mjs';
import { activeCodeownersRules, renderReport, runDoctor, type DoctorCheck } from '../scripts/doctor.mjs';
import { fakeClient, httpError, orgRepo } from './fake-github.js';

const labels: FactoryLabel[] = [
  { name: 'type:bug', color: 'd73a4a', description: 'Existing behaviour is wrong' },
  { name: 'needs-assignment', color: 'fef2c0', description: 'Waiting for a human' },
];

const workflow = `---
safe-outputs:
  add-labels:
    allowed:
      - "type:bug"
      - "needs-assignment"
---
`;

const configured: FactoryConfig = {
  project: { owner: 'octo-org', number: 7, title: 'Agentic Software Factory' },
  ruleset: { enabled: true, requiredApprovals: 1 },
  security: { enabled: true },
};

function board(overrides: Record<string, unknown> = {}) {
  return {
    organization: {
      projectV2: {
        title: 'Agentic Software Factory',
        repositories: { nodes: [{ id: 'REPO_ID' }] },
        views: { nodes: [{ name: 'Needs assignment' }] },
        fields: {
          nodes: PROJECT_FIELDS.map((field) => ({
            name: field.name,
            dataType: 'SINGLE_SELECT',
            options: field.options.map((option) => ({ name: option.name })),
          })),
        },
        ...overrides,
      },
    },
  };
}

function healthy({
  rest = {},
  read = {},
  agent = {},
  files = {},
}: {
  rest?: Record<string, unknown>;
  read?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  files?: Record<string, string | null>;
} = {}) {
  const fileMap: Record<string, string | null> = {
    '.github/workflows/issue-enrichment.md': workflow,
    '.github/workflows/issue-enrichment.lock.yml': 'compiled',
    '.github/CODEOWNERS': '# Owners\n/src/ @octo-org/payments\n',
    ...files,
  };
  return {
    client: fakeClient({
      rest: {
        'GET /repos/octo-org/example': orgRepo,
        'GET /repos/octo-org/example/labels': labels,
        'GET /repos/octo-org/example/actions/workflows/issue-enrichment.lock.yml': { state: 'active' },
        'GET /repos/octo-org/example/codeowners/errors': { errors: [] },
        'GET /repos/octo-org/example/rules/branches/main': [{ type: 'pull_request' }],
        'GET /repos/octo-org/example/environments/factory': { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
        'GET /repos/octo-org/example/environments/factory/deployment-branch-policies': { branch_policies: [{ name: 'main', type: 'branch' }] },
        ...rest,
      },
      graphql: {
        repository: { repository: { issueTypes: { nodes: [{ name: 'Bug' }, { name: 'Feature' }, { name: 'Task' }] } } },
      },
    }).client,
    readClient: fakeClient({
      rest: { 'GET /repos/octo-org/example/issues': [], ...read },
      graphql: { organization: board() },
    }).client,
    agentClient: fakeClient({
      graphql: { repository: { repository: { suggestedActors: { nodes: [{ login: 'octocat' }, { login: 'copilot-swe-agent' }] } } }, ...agent },
    }).client,
    readFile: (path: string) => fileMap[path] ?? null,
  };
}

function doctor(options: ReturnType<typeof healthy>, overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return runDoctor({
    ...options,
    repo: 'octo-org/example',
    secrets: { read: true, agent: true, bootstrap: false },
    config: configured,
    labels,
    ...overrides,
  });
}

function find(checks: DoctorCheck[], area: string) {
  return checks.filter((check) => check.area === area);
}

describe('factory doctor', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a | b', String.raw`a \| b`],
    [String.raw`a\b`, String.raw`a\\b`],
    [String.raw`a\|b`, String.raw`a\\\|b`],
    [String.raw`a\\|b`, String.raw`a\\\\\|b`],
    ['a\nb\r\nc', 'a b c'],
  ])('escapes report table-cell message %j', (message, escaped) => {
    const report = renderReport([{ area: 'Rendering', status: 'pass', message }], { repo: 'octo-org/example' });

    expect(report).toContain(`| Rendering | ✅ | ${escaped} |`);
  });

  it('passes a fully configured repository', async () => {
    const checks = await doctor(healthy());

    expect(checks.filter((check) => check.status !== 'pass')).toEqual([]);
    expect(checks.map((check) => check.area)).toEqual(expect.arrayContaining([
      'Configuration', 'Labels', 'Secrets', 'Environment', 'Project access', 'Project fields', 'Copilot coding agent', 'Issue types', 'CODEOWNERS', 'Default branch',
    ]));
    expect(renderReport(checks, { repo: 'octo-org/example' })).toContain('✅ Ready.');
  });

  it('fails until the project is configured and skips project checks', async () => {
    const checks = await doctor(healthy(), {
      config: { ...configured, project: { owner: '', number: null, title: 'Agentic Software Factory' } },
    });

    expect(find(checks, 'Configuration')[0]?.status).toBe('fail');
    expect(find(checks, 'Project access')[0]).toEqual({ area: 'Project access', status: 'skip', message: expect.any(String) });
    expect(renderReport(checks, { repo: 'octo-org/example' })).toContain('❌ 1 problem(s) block the factory.');
  });

  it('separates missing labels from drifted ones', async () => {
    const missing = await doctor(healthy({ rest: { 'GET /repos/octo-org/example/labels': [labels[0]] } }));
    const drifted = await doctor(healthy({ rest: { 'GET /repos/octo-org/example/labels': [labels[0], { ...labels[1], color: '000000' }] } }));

    expect(find(missing, 'Labels')[0]).toEqual({ area: 'Labels', status: 'fail', message: expect.stringContaining('Missing: needs-assignment') });
    expect(find(drifted, 'Labels')[0]?.status).toBe('warn');
  });

  it('fails when the label allow-list and labels.json disagree', async () => {
    const checks = await doctor(healthy({ files: { '.github/workflows/issue-enrichment.md': workflow.replace('      - "needs-assignment"\n', '      - "asf:extra"\n') } }));

    expect(find(checks, 'Label allow-list')[0]?.message).toMatch(/not allowed: needs-assignment; not in labels\.json: asf:extra/);
  });

  it('fails when the compiled workflow is missing or disabled', async () => {
    const checks = await doctor(healthy({
      files: { '.github/workflows/issue-enrichment.lock.yml': null },
      rest: { 'GET /repos/octo-org/example/actions/workflows/issue-enrichment.lock.yml': { state: 'disabled_manually' } },
    }));

    expect(find(checks, 'Enrichment workflow').map((check) => check.status)).toEqual(['fail', 'fail']);
  });

  it('reports secrets as missing, unknown, or left behind', async () => {
    const checks = await doctor(healthy(), {
      secrets: { read: false, agent: null, bootstrap: true },
      readClient: null,
      agentClient: null,
    });

    expect(find(checks, 'Secrets').map((check) => check.status)).toEqual(['fail', 'warn', 'warn']);
    expect(find(checks, 'Secrets')[2]?.message).toMatch(/ASF_BOOTSTRAP_TOKEN is still set/);
    expect(find(checks, 'Project access')[0]).toEqual({
      area: 'Project access', status: 'skip', message: 'Skipped until GH_AW_READ_PROJECT_TOKEN is set.',
    });
    expect(find(checks, 'Copilot coding agent')[0]).toEqual({
      area: 'Copilot coding agent', status: 'skip', message: expect.stringContaining('Run the "Factory doctor" workflow'),
    });
  });

  it('warns when the factory environment is missing or open to other branches', async () => {
    const missing = await doctor(healthy({ rest: {
      'GET /repos/octo-org/example/environments/factory': () => {
        throw httpError(404);
      },
    } }));
    const open = await doctor(healthy({ rest: { 'GET /repos/octo-org/example/environments/factory': { deployment_branch_policy: null } } }));
    const extra = await doctor(healthy({
      rest: {
        'GET /repos/octo-org/example/environments/factory/deployment-branch-policies': {
          branch_policies: [{ name: 'main', type: 'branch' }, { name: 'feature/*', type: 'branch' }],
        },
      },
    }));

    expect(find(missing, 'Environment')[0]).toEqual({ area: 'Environment', status: 'warn', message: expect.stringContaining('Run setup with the "environment" step') });
    expect(find(open, 'Environment')[0]).toEqual({ area: 'Environment', status: 'warn', message: expect.stringContaining('any branch') });
    expect(find(extra, 'Environment')[0]?.message).toMatch(/feature\/\*/);
  });

  it('warns about factory tokens stored where every branch can read them', async () => {
    const checks = await doctor(healthy(), { secrets: { read: true, agent: true, bootstrap: false, exposed: ['GH_AW_AGENT_TOKEN'] } });

    expect(find(checks, 'Secrets').map((check) => check.status)).toEqual(['pass', 'pass', 'warn']);
    expect(find(checks, 'Secrets')[2]?.message).toMatch(/GH_AW_AGENT_TOKEN is a repository or organization secret.*"factory" environment/);
  });

  it('fails when the read token cannot see the project or its fields are incomplete', async () => {
    const hidden = healthy();
    hidden.readClient = fakeClient({ graphql: { organization: { organization: { projectV2: null } } } }).client;
    const incomplete = healthy();
    incomplete.readClient = fakeClient({
      rest: { 'GET /repos/octo-org/example/issues': [] },
      graphql: { organization: board({ fields: { nodes: [] }, repositories: { nodes: [] }, views: { nodes: [] } }) },
    }).client;

    const hiddenChecks = await doctor(hidden);
    const incompleteChecks = await doctor(incomplete);

    expect(find(hiddenChecks, 'Project access')[0]?.message).toMatch(/Projects: Read/);
    expect(find(incompleteChecks, 'Project fields')[0]?.status).toBe('fail');
    expect(find(incompleteChecks, 'Project link')[0]?.status).toBe('warn');
    expect(find(incompleteChecks, 'Project view')[0]?.status).toBe('warn');
  });

  it('fails when Copilot cannot be assigned with the agent token', async () => {
    const options = healthy();
    options.agentClient = fakeClient({ graphql: { repository: { repository: { suggestedActors: { nodes: [{ login: 'octocat' }] } } } } }).client;

    const checks = await doctor(options);

    expect(find(checks, 'Copilot coding agent')[0]).toEqual({
      area: 'Copilot coding agent', status: 'fail', message: expect.stringContaining('Enable the Copilot coding agent'),
    });
  });

  it('warns about missing, empty, or placeholder CODEOWNERS', async () => {
    const missing = await doctor(healthy({
      rest: { 'GET /repos/octo-org/example/codeowners/errors': () => { throw httpError(404); } },
    }));
    const empty = await doctor(healthy({ files: { '.github/CODEOWNERS': '# /src/ @octo-org/payments\n' } }));
    const placeholder = await doctor(healthy({ files: { '.github/CODEOWNERS': '/src/ @your-org/your-team\n' } }));

    expect(find(missing, 'CODEOWNERS')[0]?.message).toMatch(/No CODEOWNERS file/);
    expect(find(empty, 'CODEOWNERS')[0]?.message).toMatch(/No active rules/);
    expect(find(placeholder, 'CODEOWNERS')[0]?.message).toMatch(/placeholder owners/);
  });

  it('accepts classic branch protection and warns about an unprotected default branch', async () => {
    const classic = await doctor(healthy({
      rest: { 'GET /repos/octo-org/example/rules/branches/main': [], 'GET /repos/octo-org/example/branches/main': { protected: true } },
    }));
    const open = await doctor(healthy({
      rest: { 'GET /repos/octo-org/example/rules/branches/main': [], 'GET /repos/octo-org/example/branches/main': { protected: false } },
    }));

    expect(find(classic, 'Default branch')[0]?.status).toBe('pass');
    expect(find(open, 'Default branch')[0]?.status).toBe('warn');
  });

  it('stops after local checks when the repository cannot be read', async () => {
    const options = healthy({ rest: { 'GET /repos/octo-org/example': () => { throw httpError(404); } } });

    const checks = await doctor(options);

    expect(checks.at(-1)).toEqual({ area: 'Repository', status: 'fail', message: expect.stringContaining('Could not read octo-org/example') });
    expect(find(checks, 'Labels')).toEqual([]);
  });

  it('ignores comments and blank lines in CODEOWNERS', () => {
    expect(activeCodeownersRules('# heading\n\n  /docs/ @octo-org/docs  \n#/src/ @x\n')).toEqual(['/docs/ @octo-org/docs']);
    expect(activeCodeownersRules(null)).toEqual([]);
  });
});
