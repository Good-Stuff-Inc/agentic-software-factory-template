import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const factoryRoot = fileURLToPath(new URL('..', import.meta.url));
const script = join(factoryRoot, 'scripts/verify-provenance.mjs');
const marker = readFileSync(join(factoryRoot, 'asf-spec-marker.txt'), 'utf8').split(/\r?\n/, 1)[0];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The script shells out to `gh`, so the only faithful boundary is a real `gh`
// on PATH. A stubbed module would prove the test's idea of the call, not the call.
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n');
const fixtures = JSON.parse(fs.readFileSync(process.env.GH_FIXTURES, 'utf8'));
const key = args.includes('graphql') ? 'graphql' : 'pulls';
if (fixtures[key] === undefined) {
  process.stderr.write('gh: simulated failure\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(fixtures[key]));
`;

function withGh(fixtures: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'verify-provenance-'));
  directories.push(directory);

  const ghPath = join(directory, 'gh');
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);

  const fixturesPath = join(directory, 'fixtures.json');
  const callsPath = join(directory, 'calls.log');
  writeFileSync(fixturesPath, JSON.stringify(fixtures));
  writeFileSync(callsPath, '');

  const run = (sha = 'abc123') => execFileSync(process.execPath, [script, sha], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      GH_FIXTURES: fixturesPath,
      GH_CALLS: callsPath,
      GITHUB_REPOSITORY: 'octo-org/example',
    },
  });

  return { run, calls: () => readFileSync(callsPath, 'utf8') };
}

function issueBody(source = '## Source\n\nRaised by Dan in the planning sync.\n\nAdapter: meeting-intake\nSource ref: transcripts/2026-02-11-planning-sync.vtt') {
  return `${marker}\n\n## Context\n\nSomething.\n\n${source}`;
}

const issueUrl = 'https://github.com/octo-org/example/issues/61';

function intact() {
  return {
    pulls: [{ number: 62, merged_at: '2026-02-12T10:00:00Z', merge_commit_sha: 'abc123' }],
    graphql: {
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: { nodes: [{ number: 61, body: issueBody(), url: issueUrl }] },
          },
        },
      },
    },
  };
}

describe('verify-provenance', () => {
  it('reports the whole chain for a commit whose links are intact', () => {
    const { run } = withGh(intact());

    expect(JSON.parse(run())).toEqual({
      commit: 'abc123',
      pullRequest: 62,
      issue: 61,
      origin: 'intake',
      adapter: 'meeting-intake',
      sourceRef: 'transcripts/2026-02-11-planning-sync.vtt',
    });
  });

  it('asks GitHub about the commit it was given', () => {
    const { run, calls } = withGh(intact());
    run('deadbeef');

    expect(calls()).toContain('deadbeef');
  });

  it('names the commit to pull request hop when no pull request contains the commit', () => {
    const { run } = withGh({ ...intact(), pulls: [] });

    expect(() => run()).toThrow(/commit → pull request/);
  });

  it('names the pull request to issue hop when nothing closes an issue', () => {
    const fixtures = intact();
    fixtures.graphql.data.repository.pullRequest.closingIssuesReferences.nodes = [];

    expect(() => withGh(fixtures).run()).toThrow(/pull request → issue/);
  });

  it('names the issue to source hop when a pipeline issue lost its Source section', () => {
    const fixtures = intact();
    fixtures.graphql.data.repository.pullRequest.closingIssuesReferences.nodes = [
      { number: 61, body: `${marker}\n\n## Context\n\nThe Source section was edited away.`, url: issueUrl },
    ];

    expect(() => withGh(fixtures).run()).toThrow(/issue → source/);
  });

  // A hand-written issue has no intake stamp and is not supposed to. The issue
  // itself is the origin, so the chain is intact rather than broken.
  it('traces a hand-written issue to itself instead of failing', () => {
    const fixtures = intact();
    fixtures.graphql.data.repository.pullRequest.closingIssuesReferences.nodes = [
      { number: 45, body: '## Context\n\nWritten by a person, never went through intake.', url: issueUrl },
    ];

    expect(JSON.parse(withGh(fixtures).run())).toMatchObject({
      issue: 45,
      origin: 'manual',
      adapter: 'manual',
      sourceRef: issueUrl,
    });
  });

  it('rejects a Source section that carries prose but no stamped provenance', () => {
    const fixtures = intact();
    fixtures.graphql.data.repository.pullRequest.closingIssuesReferences.nodes = [
      { number: 61, body: issueBody('## Source\n\nRaised by Dan in the planning sync.'), url: issueUrl },
    ];

    expect(() => withGh(fixtures).run()).toThrow(/Adapter/);
  });

  // A verifier that treats "could not ask" as "nothing to report" is a green
  // check that proves nothing.
  it('fails rather than passing when gh itself cannot answer', () => {
    expect(() => withGh({}).run()).toThrow();
  });
});
