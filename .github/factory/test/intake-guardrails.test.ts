import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { MAX_ITEMS, prepareItems, runIntake } from '../../skills/intake-guardrails/emit.mjs';

const marker = readFileSync(
  fileURLToPath(new URL('../asf-spec-marker.txt', import.meta.url)),
  'utf8',
).split(/\r?\n/, 1)[0];

const project = { owner: 'octo-org', number: 7, url: 'https://github.com/orgs/octo-org/projects/7' };

function validItem(title = 'Export reports as CSV') {
  return {
    title,
    body: `${marker}

## Context

Customers need report exports.

## Proposal

Add a CSV export.

## Criteria

Exports contain every row.

## Possible duplicates

None found.`,
    fields: { 'Proposed Type': 'Feature', Priority: 'P2', Complexity: 'M' },
    provenance: { adapter: 'meeting-transcript', sourceRef: 'meeting-123' },
  };
}

function projectResponse() {
  return {
    data: {
      organization: {
        projectV2: {
          id: 'PROJECT_ID',
          viewerCanUpdate: true,
          fields: {
            nodes: [
              { id: 'TYPE_ID', name: 'Proposed Type', options: [{ id: 'FEATURE_ID', name: 'Feature' }] },
              {
                id: 'PRIORITY_ID',
                name: 'Priority',
                options: ['P0', 'P1', 'P2', 'P3'].map((name) => ({ id: `${name}_ID`, name })),
              },
              { id: 'COMPLEXITY_ID', name: 'Complexity', options: [{ id: 'M_ID', name: 'M' }] },
            ],
          },
        },
      },
    },
  };
}

function successfulGh(item = validItem()) {
  // Echo back what the emitter actually sent, so the mock cannot drift from the write path.
  let written = { title: item.title, body: item.body };

  return vi.fn((args: string[]) => {
    if (args[0] === 'api' && args.some((arg) => arg.includes('viewerCanUpdate'))) {
      return projectResponse();
    }
    if (args[1] === 'item-create') {
      written = {
        title: args[args.indexOf('--title') + 1] ?? '',
        body: args[args.indexOf('--body') + 1] ?? '',
      };
      return { id: 'ITEM_ID' };
    }
    if (args[1] === 'item-edit') {
      return { id: 'ITEM_ID' };
    }
    if (args[0] === 'api') {
      return {
        data: {
          node: {
            id: 'ITEM_ID',
            project: { id: 'PROJECT_ID' },
            content: { title: written.title, body: written.body },
            fieldValues: {
              nodes: Object.entries(item.fields).map(([name, value]) => ({
                name: value,
                field: { name },
              })),
            },
          },
        },
      };
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  });
}

describe('intake guardrails', () => {
  it('stamps provenance into the body so no adapter can drop it', () => {
    const [prepared] = prepareItems({ items: [validItem()] });
    expect(prepared).toBeDefined();

    expect(prepared?.body).toContain('## Source');
    expect(prepared?.body).toContain('Adapter: meeting-transcript');
    expect(prepared?.body).toContain('Source ref: meeting-123');
  });

  it('keeps an adapter-written source section and adds the machine-readable pair once', () => {
    const item = validItem();
    item.body += '\n\n## Source\n\nTranscript: notes.md, raised by Sam.';

    const [prepared] = prepareItems({ items: [item] });
    expect(prepared).toBeDefined();

    expect(prepared?.body).toContain('Transcript: notes.md, raised by Sam.');
    expect(prepared?.body.match(/^## Source$/gm)).toHaveLength(1);
    expect(prepared?.body.match(/^Adapter: meeting-transcript$/gm)).toHaveLength(1);
  });

  it('rejects more than ten items', () => {
    expect(() => prepareItems({
      items: Array.from({ length: MAX_ITEMS + 1 }, (_, index) => validItem(`Item ${index}`)),
    })).toThrow(/per-run maximum is 10/);
  });

  it('checks Projects v2 access with an actionable failure', async () => {
    const runGh = vi.fn(() => {
      throw new Error('insufficient scopes');
    });

    await expect(runIntake({ items: [validItem()] }, {
      runGh,
      project,
    })).rejects.toThrow(/gh auth refresh -s project/);
  });

  it('names the configured project when a required field is missing', async () => {
    const runGh = vi.fn(() => ({
      data: { organization: { projectV2: { id: 'PROJECT_ID', viewerCanUpdate: true, fields: { nodes: [] } } } },
    }));

    await expect(runIntake({ items: [validItem()] }, {
      runGh,
      project,
    })).rejects.toThrow('https://github.com/orgs/octo-org/projects/7 is missing required single-select field "Proposed Type"');
  });

  it('rejects malformed items before any write', async () => {
    const runGh = successfulGh();
    const { title: _title, ...item } = validItem();

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
    })).rejects.toThrow(/missing title field/);

    expect(runGh).not.toHaveBeenCalled();
  });

  it('rejects invalid project field options before rendering or writing', async () => {
    const item = validItem();
    item.fields.Priority = 'P5';
    const runGh = successfulGh(item);
    const log = vi.fn();

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
      log,
    })).rejects.toThrow('Priority "P5" is not a valid option; expected one of P0, P1, P2, P3.');

    expect(log).not.toHaveBeenCalled();
    expect(runGh.mock.calls.some(([args]) => args[1] === 'item-create')).toBe(false);
  });

  it('reports the sanitized items it writes', async () => {
    const item = validItem('Export\u0007 reports');
    const runGh = successfulGh({ ...item, title: 'Export reports' });
    const log = vi.fn();

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
      log,
    })).resolves.toEqual(['ITEM_ID']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Title: Export reports'));
    const create = runGh.mock.calls.find(([args]) => args[1] === 'item-create')?.[0];
    expect(create).toContain('Export reports');
  });

  it('emits a machine-readable receipt containing every verified project item ID', async () => {
    const item = validItem();
    const runGh = successfulGh(item);
    const log = vi.fn();

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
      log,
    })).resolves.toEqual(['ITEM_ID']);

    expect(log).toHaveBeenLastCalledWith(`ASF_INTAKE_VERIFIED ${JSON.stringify({
      project: {
        owner: 'octo-org',
        number: 7,
        id: 'PROJECT_ID',
        url: 'https://github.com/orgs/octo-org/projects/7',
      },
      items: [
        {
          id: 'ITEM_ID',
          title: 'Export reports as CSV',
          fields: {
            'Proposed Type': 'Feature',
            Priority: 'P2',
            Complexity: 'M',
          },
        },
      ],
    })}`);
  });

  it('passes untrusted content as arguments and verifies the completed item', async () => {
    const item = validItem('Export $(touch /tmp/not-run) reports');
    const runGh = successfulGh(item);

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
      log: () => undefined,
    })).resolves.toEqual(['ITEM_ID']);

    const create = runGh.mock.calls.find(([args]) => args[1] === 'item-create')?.[0];
    expect(create).toContain(item.title);
    expect(runGh.mock.calls.filter(([args]) => args[1] === 'item-edit')).toHaveLength(3);
    expect(runGh.mock.calls.some(([args]) => args[0] === 'api' && args.some((arg) => arg === 'id=ITEM_ID'))).toBe(true);
  });

  it('rolls back and names an item whose write does not land', async () => {
    const item = validItem();
    const runGh = successfulGh(item);
    runGh.mockImplementationOnce(() => projectResponse())
      .mockImplementationOnce(() => ({ id: 'ITEM_ID' }))
      .mockImplementationOnce(() => {
        throw new Error('field update failed');
      })
      .mockImplementationOnce(() => ({ id: 'ITEM_ID' }));

    await expect(runIntake({ items: [item] }, {
      runGh,
      project,
      log: () => undefined,
    })).rejects.toThrow(/Failed to create intake item "Export reports as CSV".*All items created by this run were removed/);

    expect(runGh.mock.calls.at(-1)?.[0]).toEqual([
      'project', 'item-delete', '7', '--owner', 'octo-org', '--id', 'ITEM_ID', '--format', 'json',
    ]);
  });
});
