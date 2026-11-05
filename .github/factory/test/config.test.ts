import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadConfig,
  parseAllowedLabels,
  readLabels,
  readMarker,
  resolveProject,
  writeProjectToConfig,
} from '../lib/config.mjs';

const workflow = readFileSync(
  fileURLToPath(new URL('../../workflows/issue-enrichment.md', import.meta.url)),
  'utf8',
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(name: string, content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-config-'));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

describe('factory configuration', () => {
  it('gives an actionable error until the project is configured', () => {
    const config = loadConfig(tempFile('config.json', JSON.stringify({ project: { owner: '', number: null } })));

    expect(() => resolveProject(config)).toThrow(/not configured.*project\.owner.*project\.number.*docs\/SETUP\.md/s);
  });

  it('resolves a configured project to its organization URL', () => {
    const config = loadConfig(tempFile('config.json', JSON.stringify({ project: { owner: 'octo-org', number: 7 } })));

    expect(resolveProject(config)).toEqual({ owner: 'octo-org', number: 7, url: 'https://github.com/orgs/octo-org/projects/7' });
  });

  it.each([
    [{ owner: 'octo org', number: 7 }],
    [{ owner: 'octo-org', number: 0 }],
    [{ owner: 'octo-org', number: '7' }],
  ])('rejects an invalid project %j', (project) => {
    const config = loadConfig(tempFile('config.json', JSON.stringify({ project })));

    expect(() => resolveProject(config)).toThrow(/not configured/);
  });

  it('defaults optional settings so older config files keep working', () => {
    const config = loadConfig(tempFile('config.json', '{}'));

    expect(config).toEqual({
      project: { owner: '', number: null, title: 'Agentic Software Factory' },
      ruleset: { enabled: true, requiredApprovals: 1 },
      security: { enabled: true },
    });
  });

  it('records the project without dropping other settings', () => {
    const path = tempFile('config.json', JSON.stringify({ project: { owner: '', number: null, title: 'Board' }, security: { enabled: false } }));

    writeProjectToConfig('octo-org', 7, path);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      project: { owner: 'octo-org', number: 7, title: 'Board' },
      security: { enabled: false },
    });
  });

  it('rejects a marker file without a versioned marker line', () => {
    expect(readMarker()).toMatch(/^<!-- asf-spec: v\d+ -->$/);
    expect(() => readMarker(tempFile('marker.txt', 'asf-spec v1\n'))).toThrow(/must start with a marker line/);
  });

  it('keeps the enrichment label allow-list identical to labels.json', () => {
    const names = readLabels().map((label) => label.name).sort();

    expect(parseAllowedLabels(workflow).sort()).toEqual(names);
  });

  it('reads the allow-list from add-labels only', () => {
    const markdown = `---
safe-outputs:
  add-comment:
    max: 2
  add-labels:
    allowed:
      - "type:bug"
      - needs-assignment
    max: 6
  set-issue-type:
    allowed: ["Bug"]
---
# Prompt`;

    expect(parseAllowedLabels(markdown)).toEqual(['type:bug', 'needs-assignment']);
  });
});
