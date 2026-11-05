import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isPipelineIssue, validateRoutingOutput } from '../lib/validate-routing-output.mjs';

const workflow = readFileSync(
  fileURLToPath(new URL('../../workflows/issue-enrichment.md', import.meta.url)),
  'utf8',
);

const bugLabels = JSON.stringify({
  type: 'add_labels',
  labels: [{ name: 'type:bug' }, { name: 'agent-triaged' }],
});

describe('issue enrichment routing', () => {
  it('skips unrelated issues without assuming they have safe outputs', () => {
    expect(isPipelineIssue('A manually filed bug', '<!-- asf-spec: v1 -->')).toBe(false);
    expect(isPipelineIssue('<!-- asf-spec: v1 -->\n\n## Context', '<!-- asf-spec: v1 -->')).toBe(true);
  });

  it('rejects a Bug handoff without an issue number', () => {
    expect(() => validateRoutingOutput([
      bugLabels,
      JSON.stringify({ type: 'assign_to_agent', confidence: 'HIGH', rationale: 'Fix the bug.' }),
    ].join('\n'), 69)).toThrow(/Bug #69.*issue_number/);
  });

  it('rejects missing or misdirected Bug handoffs', () => {
    expect(() => validateRoutingOutput(bugLabels, 69)).toThrow(/Bug #69.*issue_number/);
    expect(() => validateRoutingOutput([
      bugLabels,
      JSON.stringify({ type: 'assign_to_agent', issue_number: 70 }),
    ].join('\n'), 69)).toThrow(/Bug #69.*issue_number/);
  });

  it('accepts a correctly targeted Bug handoff and non-Bug outputs', () => {
    expect(() => validateRoutingOutput([
      bugLabels,
      JSON.stringify({ type: 'assign_to_agent', issue_number: 69 }),
    ].join('\n'), 69)).not.toThrow();
    expect(() => validateRoutingOutput(
      JSON.stringify({ type: 'add_labels', labels: ['type:feature', 'needs-assignment'] }),
      69,
    )).not.toThrow();
    expect(() => validateRoutingOutput('', 69)).not.toThrow();
  });

  it('wires the validator after the agent and names the required safe-output arguments', () => {
    expect(workflow).toContain('post-steps:');
    expect(workflow).toContain('node .github/factory/lib/validate-routing-output.mjs');
    expect(workflow).toContain('issue_number');
    expect(workflow).toContain('safeoutputs-assign_to_agent');
  });
});
