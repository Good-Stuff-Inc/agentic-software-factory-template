#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMarker } from '../lib/config.mjs';

const marker = readMarker();

const CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 10) {
        nodes { number body url }
      }
    }
  }
}`;

function fail(hop, detail) {
  throw new Error(`Provenance chain broken at ${hop}: ${detail}`);
}

function defaultRunGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh exited with status ${result.status}`);
  }
  return result.stdout;
}

function parseJson(raw, what) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Unable to parse the ${what} response from gh.`);
  }
}

export function resolveRepository(runGh = defaultRunGh, env = process.env) {
  const slug = env.GITHUB_REPOSITORY
    || parseJson(runGh(['repo', 'view', '--json', 'nameWithOwner']), 'repository').nameWithOwner;
  const [owner, name] = String(slug || '').split('/');

  if (!owner || !name) {
    throw new Error('Unable to determine the repository. Pass --repo owner/name.');
  }

  return { owner, name };
}

export function parseProvenance(body, issue) {
  const text = String(body || '');

  // The marker is the same signal issue enrichment checks. Without it the
  // issue was written by a human, and the issue itself is the origin.
  if (!text.includes(marker)) {
    return { origin: 'manual', adapter: 'manual', sourceRef: issue.url };
  }

  const heading = /^##\s+Source\s*$/m.exec(text);

  if (!heading) {
    fail('issue → source', `issue #${issue.number} carries the intake marker but has no "## Source" section.`);
  }

  const section = text.slice(heading.index + heading[0].length).split(/^##\s+/m)[0];
  const adapter = /^Adapter:\s*(\S.*)$/m.exec(section);
  const sourceRef = /^Source ref:\s*(\S.*)$/m.exec(section);

  if (!adapter || !sourceRef) {
    fail(
      'source → stamp',
      `the "## Source" section on issue #${issue.number} is missing its "Adapter:" or "Source ref:" line. `
      + 'The intake emitter stamps both, so a pipeline issue without them was edited or predates stamping.',
    );
  }

  return { origin: 'intake', adapter: adapter[1].trim(), sourceRef: sourceRef[1].trim() };
}

function findPullRequest(runGh, repository, commit) {
  const pulls = parseJson(
    runGh(['api', `repos/${repository.owner}/${repository.name}/commits/${commit}/pulls`]),
    'pull request',
  );

  if (!Array.isArray(pulls) || pulls.length === 0) {
    fail('commit → pull request', `no pull request contains commit ${commit}.`);
  }

  const merged = pulls.filter((pull) => pull?.merged_at);

  return merged.find((pull) => pull.merge_commit_sha === commit) ?? merged[0] ?? pulls[0];
}

function findClosingIssue(runGh, repository, pullRequest) {
  const response = parseJson(runGh([
    'api', 'graphql',
    '-f', `query=${CLOSING_ISSUES_QUERY}`,
    '-F', `owner=${repository.owner}`,
    '-F', `name=${repository.name}`,
    '-F', `number=${pullRequest}`,
  ]), 'closing issue');

  const nodes = response?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes;

  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail(
      'pull request → issue',
      `pull request #${pullRequest} closes no issue, so the change has no recorded reason.`,
    );
  }

  return nodes[0];
}

export function traceProvenance(commit, { runGh = defaultRunGh, repository } = {}) {
  if (!commit) {
    throw new Error('Usage: verify-provenance.mjs <commit-sha> [--repo owner/name]');
  }

  const target = repository ?? resolveRepository(runGh);
  const pullRequest = findPullRequest(runGh, target, commit);
  const issue = findClosingIssue(runGh, target, pullRequest.number);

  return {
    commit,
    pullRequest: pullRequest.number,
    issue: issue.number,
    ...parseProvenance(issue.body, issue),
  };
}

function parseArgs(argv) {
  const repoIndex = argv.indexOf('--repo');
  const slug = repoIndex === -1 ? undefined : argv[repoIndex + 1];
  const valueIndex = repoIndex === -1 ? -1 : repoIndex + 1;
  const commit = argv.find((value, index) => !value.startsWith('--') && index !== valueIndex);

  if (repoIndex !== -1 && !slug) {
    throw new Error('--repo needs a value, as owner/name.');
  }

  const [owner, name] = (slug ?? '').split('/');

  return { commit, repository: owner && name ? { owner, name } : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { commit, repository } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(traceProvenance(commit, { repository }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
