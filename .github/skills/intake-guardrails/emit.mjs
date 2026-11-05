#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, REQUIRED_FIELDS as requiredFields, resolveProject } from '../../factory/lib/config.mjs';
import { validateIntakeContract } from '../../factory/lib/validate-intake-contract.mjs';

export const MAX_ITEMS = 10;

const projectQuery = `query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      viewerCanUpdate
      fields(first: 100) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const itemQuery = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      project { id }
      content {
        ... on DraftIssue { title body }
      }
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field {
              ... on ProjectV2SingleSelectField { name }
            }
          }
        }
      }
    }
  }
}`;

function sanitizeSingleLine(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeBody(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

function stampProvenance(body, provenance) {
  const lines = `Adapter: ${provenance.adapter}\nSource ref: ${provenance.sourceRef}`;

  if (!/^## Source\s*$/m.test(body)) {
    return `${body}\n\n## Source\n\n${lines}`;
  }

  if (new RegExp(`^Adapter: ${escapeRegExp(provenance.adapter)}$`, 'm').test(body)) {
    return body;
  }

  return `${body}\n\n${lines}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function prepareItems(payload) {
  if (!Array.isArray(payload?.items) || payload.items.length === 0) {
    throw new Error('Intake payload must contain at least one item.');
  }
  if (payload.items.length > MAX_ITEMS) {
    throw new Error(`Intake payload contains ${payload.items.length} items; the per-run maximum is ${MAX_ITEMS}.`);
  }

  return payload.items.map((item) => {
    const sanitized = {
      ...item,
      title: sanitizeSingleLine(item?.title),
      body: sanitizeBody(item?.body),
      fields: Object.fromEntries(
        Object.entries(item?.fields ?? {}).map(([name, value]) => [name, sanitizeSingleLine(value)]),
      ),
      provenance: {
        adapter: sanitizeSingleLine(item?.provenance?.adapter),
        sourceRef: sanitizeSingleLine(item?.provenance?.sourceRef),
      },
    };
    validateIntakeContract(sanitized);
    sanitized.body = stampProvenance(sanitized.body, sanitized.provenance);
    return sanitized;
  });
}

function defaultRunGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh exited with status ${result.status}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('gh returned an invalid JSON response.');
  }
}

function projectPreflight(runGh, target) {
  let response;
  try {
    response = runGh([
      'api',
      'graphql',
      '-f', `query=${projectQuery}`,
      '-F', `owner=${target.owner}`,
      '-F', `number=${target.number}`,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Projects v2 access check failed: ${detail}. Run \`gh auth refresh -s project\` and retry.`);
  }

  const project = response?.data?.organization?.projectV2;
  if (!project?.id || project.viewerCanUpdate !== true) {
    throw new Error(`The active GitHub token cannot update ${target.url}. Run \`gh auth refresh -s project\` and retry.`);
  }

  const fields = new Map(
    (project.fields?.nodes ?? []).filter(Boolean).map((field) => [field.name, field]),
  );
  for (const name of requiredFields) {
    if (!fields.has(name)) {
      throw new Error(`${target.url} is missing required single-select field "${name}". Run the factory setup again.`);
    }
  }

  return { id: project.id, fields };
}

function renderItems(items) {
  return items.map((item, index) => [
    `--- Proposed item ${index + 1} of ${items.length} ---`,
    `Title: ${item.title}`,
    '',
    item.body,
    '',
    `Proposed Type: ${item.fields['Proposed Type']}`,
    `Priority: ${item.fields.Priority}`,
    `Complexity: ${item.fields.Complexity}`,
  ].join('\n')).join('\n\n');
}

function optionId(field, value) {
  const option = field.options?.find((candidate) => candidate.name === value);
  if (!option?.id) {
    throw new Error(`Project field "${field.name}" has no option named "${value}".`);
  }
  return option.id;
}

function validateFieldOptions(items, fields) {
  for (const item of items) {
    for (const name of requiredFields) {
      const field = fields.get(name);
      const allowed = field.options.map((option) => option.name);
      if (!allowed.includes(item.fields[name])) {
        throw new Error(`${name} "${item.fields[name]}" is not a valid option; expected one of ${allowed.join(', ')}.`);
      }
    }
  }
}

function verifyItem(runGh, projectId, item, itemId) {
  const response = runGh([
    'api',
    'graphql',
    '-f', `query=${itemQuery}`,
    '-F', `id=${itemId}`,
  ]);
  const created = response?.data?.node;
  const values = new Map(
    (created?.fieldValues?.nodes ?? [])
      .filter((value) => value?.field?.name)
      .map((value) => [value.field.name, value.name]),
  );

  if (created?.id !== itemId
    || created?.project?.id !== projectId
    || created?.content?.title !== item.title
    || created?.content?.body !== item.body
    || requiredFields.some((name) => values.get(name) !== item.fields[name])) {
    throw new Error('GitHub did not return the complete item after creation.');
  }
}

function rollback(runGh, target, createdIds) {
  const failures = [];
  for (const id of [...createdIds].reverse()) {
    try {
      runGh(['project', 'item-delete', String(target.number), '--owner', target.owner, '--id', id, '--format', 'json']);
    } catch {
      failures.push(id);
    }
  }
  return failures;
}

export async function runIntake(payload, {
  runGh = defaultRunGh,
  log = console.log,
  project: target,
} = {}) {
  const items = prepareItems(payload);
  target ??= resolveProject(loadConfig());
  const project = projectPreflight(runGh, target);
  validateFieldOptions(items, project.fields);
  log(renderItems(items));

  const createdIds = [];
  let currentTitle = items[0].title;
  let abortSignal;
  const markInterrupted = () => {
    abortSignal = 'SIGINT';
  };
  const markTerminated = () => {
    abortSignal = 'SIGTERM';
  };
  process.once('SIGINT', markInterrupted);
  process.once('SIGTERM', markTerminated);
  try {
    for (const item of items) {
      currentTitle = item.title;
      if (abortSignal) {
        throw new Error(`Received ${abortSignal}.`);
      }
      const created = runGh([
        'project',
        'item-create',
        String(target.number),
        '--owner', target.owner,
        '--title', item.title,
        '--body', item.body,
        '--format', 'json',
      ]);
      if (!created?.id) {
        throw new Error('GitHub did not return a project item ID.');
      }
      createdIds.push(created.id);

      for (const name of requiredFields) {
        const field = project.fields.get(name);
        runGh([
          'project',
          'item-edit',
          '--id', created.id,
          '--project-id', project.id,
          '--field-id', field.id,
          '--single-select-option-id', optionId(field, item.fields[name]),
          '--format', 'json',
        ]);
      }
      verifyItem(runGh, project.id, item, created.id);
      if (abortSignal) {
        throw new Error(`Received ${abortSignal}.`);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const rollbackFailures = rollback(runGh, target, createdIds);
    const cleanup = rollbackFailures.length === 0
      ? 'All items created by this run were removed.'
      : `Manual cleanup is required for project item IDs: ${rollbackFailures.join(', ')}.`;
    throw new Error(`Failed to create intake item "${currentTitle}": ${detail} ${cleanup}`);
  } finally {
    process.removeListener('SIGINT', markInterrupted);
    process.removeListener('SIGTERM', markTerminated);
  }

  log(`ASF_INTAKE_VERIFIED ${JSON.stringify({
    project: {
      owner: target.owner,
      number: target.number,
      id: project.id,
      url: target.url,
    },
    items: items.map((item, index) => ({
      id: createdIds[index],
      title: item.title,
      fields: item.fields,
    })),
  })}`);
  return createdIds;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: emit.mjs <intake-payload.json>');
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read intake payload: ${detail}`);
  }

  await runIntake(payload);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
