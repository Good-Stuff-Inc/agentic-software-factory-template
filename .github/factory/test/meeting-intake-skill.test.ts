import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const skill = readFileSync(
  fileURLToPath(new URL('../../skills/meeting-intake/SKILL.md', import.meta.url)),
  'utf8',
);

describe('meeting-intake skill', () => {
  it('delegates transcript drafts to the shared guarded emitter', () => {
    expect(skill).toContain('name: meeting-intake');
    expect(skill).toContain('description:');
    expect(skill).toContain('.github/agents/requirements-agent.md');
    expect(skill).toContain('.github/skills/intake-guardrails/SKILL.md');
    expect(skill).toContain('node .github/skills/intake-guardrails/emit.mjs <private-dir>/asf-intake.json');
    expect(skill).toContain('mktemp -d');
    expect(skill).not.toContain('allowed-tools:');
    expect(skill).toContain('Do not call `gh project item-create` or `gh project item-edit` directly');
    expect(skill).toContain('never pipe input into the emitter');
    expect(skill).not.toContain('`yes` gate');
    expect(skill).not.toContain('safeoutputs');
  });

  it('preserves the intake contract and duplicate-detection behavior', () => {
    expect(skill).toContain('.github/factory/asf-spec-marker.txt');
    expect(skill).toContain('.github/factory/config.json');
    expect(skill).toContain('"adapter": "meeting-intake"');
    expect(skill).toContain('sourceRef');
    expect(skill).toContain('Proposed Type');
    expect(skill).toContain('Priority');
    expect(skill).toContain('Complexity');
    expect(skill).toContain('## Possible duplicates');
    expect(skill).toContain('## Acceptance criteria');
    expect(skill).toContain('None found.');
    expect(skill).toContain('rather than imply a clean duplicate check');
  });

  it('requires the verified emitter receipt before reporting creation', () => {
    expect(skill).toContain('ASF_INTAKE_VERIFIED');
    expect(skill).toContain('exact project item ID');
    expect(skill).toContain('must not report any draft as created');
  });
});
