#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_FILE, readMarker } from './config.mjs';

const marker = readMarker();

function fail(adapter, field) {
  throw new Error(`Intake contract validation failed for adapter "${adapter || '<missing>'}": missing ${field}.`);
}

function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasSection(body, names) {
  return names.some((name) => new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(body));
}

export function validateIntakeContract(item) {
  const adapter = item?.provenance?.adapter;

  if (!isSet(adapter)) {
    fail(adapter, 'provenance field "adapter"');
  }

  if (!isSet(item.provenance.sourceRef)) {
    fail(adapter, 'provenance field "sourceRef"');
  }

  if (!isSet(item.title)) {
    fail(adapter, 'title field');
  }

  if (typeof item.body !== 'string') {
    fail(adapter, 'body field (string)');
  }

  if (item.body.split(/\r?\n/, 1)[0] !== marker) {
    fail(adapter, `body starting with the marker defined in ${MARKER_FILE}`);
  }

  if (!hasSection(item.body, ['Context'])) {
    fail(adapter, 'body section "Context"');
  }

  if (!hasSection(item.body, ['Problem', 'Proposal'])) {
    fail(adapter, 'body section "Problem" or "Proposal"');
  }

  if (!hasSection(item.body, ['Acceptance criteria', 'Criteria'])) {
    fail(adapter, 'body section "Acceptance criteria"');
  }

  // Absence would otherwise read as a clean duplicate check rather than a skipped one.
  if (!hasSection(item.body, ['Possible duplicates'])) {
    fail(adapter, 'body section "Possible duplicates"');
  }

  for (const field of ['Proposed Type', 'Priority', 'Complexity']) {
    if (!isSet(item.fields?.[field])) {
      fail(adapter, `project field "${field}"`);
    }
  }

  if (item.fields['Proposed Type'].trim().toLowerCase() === 'bug'
    && !hasSection(item.body, ['Repro', 'Reproduction', 'Steps to Reproduce'])) {
    fail(adapter, 'body section "Repro"');
  }
}

function readItem() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: validate-intake-contract.mjs <item.json>');
  }

  const resolvedPath = resolve(inputPath);
  try {
    return JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read intake item at ${resolvedPath}: ${message}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateIntakeContract(readItem());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
