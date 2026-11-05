import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const factoryRoot = fileURLToPath(new URL('..', import.meta.url));
const script = join(factoryRoot, 'lib/validate-intake-contract.mjs');
const marker = readFileSync(join(factoryRoot, 'asf-spec-marker.txt'), 'utf8').split(/\r?\n/, 1)[0];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validate(item: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'intake-contract-'));
  directories.push(directory);
  const path = join(directory, 'item.json');
  writeFileSync(path, JSON.stringify(item));

  return () => execFileSync(process.execPath, [script, path], { encoding: 'utf8', stdio: 'pipe' });
}

function validItem() {
  return {
    title: 'Quote CSV export fields that contain commas',
    body: `${marker}

## Context

Context.

## Problem

Problem.

## Repro

Reproduction.

## Criteria

Criteria.

## Possible duplicates

None found.`,
    fields: { 'Proposed Type': 'Bug', Priority: 'P1', Complexity: 'S' },
    provenance: { adapter: 'meeting-transcript', sourceRef: 'meeting-123' },
  };
}

describe('validate-intake-contract', () => {
  it('accepts a compliant intake item', () => {
    expect(validate(validItem())).not.toThrow();
  });

  it('rejects a body without the possible duplicates section', () => {
    const item = validItem();
    item.body = item.body.replace(/\n\n## Possible duplicates\n\nNone found\.$/, '');

    expect(validate(item)).toThrow(
      /adapter "meeting-transcript": missing body section "Possible duplicates"/,
    );
  });

  it('accepts a duplicates section that lists matches', () => {
    const item = validItem();
    item.body = item.body.replace(
      'None found.',
      '- #10 — same quoting defect on the same code path.',
    );

    expect(validate(item)).not.toThrow();
  });

  it('reports the adapter and missing project field', () => {
    const item = validItem();
    item.fields.Priority = ' ';

    expect(validate(item)).toThrow(/adapter "meeting-transcript": missing project field "Priority"/);
  });

  it('rejects a missing title', () => {
    const { title: _title, ...item } = validItem();

    expect(validate(item)).toThrow(/adapter "meeting-transcript": missing title field/);
  });

  it('rejects a marker that is not the first body line', () => {
    const item = validItem();
    item.body = `\n${item.body}`;

    expect(validate(item)).toThrow(/missing body starting with the marker defined in .github\/factory\/asf-spec-marker\.txt/);
  });

  it('accepts the "Acceptance criteria" heading the requirements agent prescribes', () => {
    const item = validItem();
    item.body = item.body.replace('## Criteria', '## Acceptance criteria');

    expect(validate(item)).not.toThrow();
  });

  it('reports a missing criteria section', () => {
    const item = validItem();
    item.body = item.body.replace('## Criteria\n\nCriteria.', '');

    expect(validate(item)).toThrow(/adapter "meeting-transcript": missing body section "Acceptance criteria"/);
  });

  it('requires reproduction for bugs', () => {
    const item = validItem();
    item.body = item.body.replace('## Repro\n\nReproduction.\n\n', '');
    expect(validate(item)).toThrow(/adapter "meeting-transcript": missing body section "Repro"/);
  });

  it('requires source provenance for every item', () => {
    const feature = validItem();
    feature.fields['Proposed Type'] = 'Feature';
    const withoutSourceRef = { ...feature, provenance: { adapter: feature.provenance.adapter } };
    expect(validate(withoutSourceRef)).toThrow(/adapter "meeting-transcript": missing provenance field "sourceRef"/);
  });
});
