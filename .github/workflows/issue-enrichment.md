---
description: >-
  Enriches issues that originated from an Agentic Software Factory intake
  adapter: applies
  labels and a real GitHub issue type based on the board's Proposed Type field,
  notifies the CODEOWNERS owner, and hands Bugs straight to the Copilot coding
  agent while leaving Features for a human to staff. This workflow classifies and
  routes. It never investigates the codebase.
on:
  issues:
    types: [opened]

engine: copilot

# The factory tokens are secrets of this environment, which only the default
# branch can use. See docs/SETUP.md.
environment: factory

permissions:
  contents: read
  issues: read
  copilot-requests: write

network: defaults

tools:
  github:
    # Projects access supplies the converted item's fields.
    toolsets: [context, issues, projects]
    github-token: ${{ secrets.GH_AW_READ_PROJECT_TOKEN }}
  bash: ["cat"]


pre-steps:
  - name: Require factory tokens
    env:
      GH_AW_READ_PROJECT_TOKEN: ${{ secrets.GH_AW_READ_PROJECT_TOKEN }}
      GH_AW_AGENT_TOKEN: ${{ secrets.GH_AW_AGENT_TOKEN }}
    run: |
      missing=0

      if [ -z "${GH_AW_READ_PROJECT_TOKEN}" ]; then
        missing=1
        echo "::error title=Missing secret GH_AW_READ_PROJECT_TOKEN::Required by the agent-facing GitHub MCP server to read the factory project. The built-in GITHUB_TOKEN cannot reach the Projects v2 API."
        echo "  Fine-grained PAT -> Resource owner: your organization | Repository access: this repository"
        echo "    Repository permissions ... Contents: Read, Issues: Read"
        echo "    Organization permissions . Projects: Read"
      fi

      if [ -z "${GH_AW_AGENT_TOKEN}" ]; then
        missing=1
        echo "::error title=Missing secret GH_AW_AGENT_TOKEN::Required to assign the Copilot coding agent to Bug issues. GitHub App installation tokens are rejected for agent assignment, so this must be a PAT."
        echo "  Fine-grained PAT -> Repository access: this repository"
        echo "    Repository permissions ... Metadata: Read | Actions, Contents, Issues, Pull requests: Read and write"
      fi

      if [ "${missing}" -eq 1 ]; then
        echo ""
        echo "See docs/SETUP.md. Failing loudly rather than silently skipping enrichment."
        exit 1
      fi

      echo "All factory tokens are present."

steps:
  - name: Require factory configuration
    run: node .github/factory/lib/config.mjs
  - name: Record repository visibility
    env:
      REPOSITORY_PRIVATE: ${{ github.event.repository.private }}
    run: |
      mkdir -p /tmp/gh-aw
      if [ "$REPOSITORY_PRIVATE" = "true" ]; then echo private; else echo public; fi > /tmp/gh-aw/repository-visibility.txt

post-steps:
  - name: Require a targeted Copilot handoff for Bugs
    env:
      GH_AW_SAFE_OUTPUTS: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
      ISSUE_NUMBER: ${{ github.event.issue.number }}
    run: node .github/factory/lib/validate-routing-output.mjs "$GH_AW_SAFE_OUTPUTS" "$ISSUE_NUMBER"

safe-outputs:
  # Team mentions are neutralized unless the team is listed here. To notify
  # CODEOWNERS teams, follow "Optional: notify owning teams" in docs/SETUP.md.
  mentions:
    allowed-collaborators: true
  add-comment:
    max: 2
  add-labels:
    allowed:
      - "type:bug"
      - "type:feature"
      - "type:chore"
      - "priority:P0"
      - "priority:P1"
      - "priority:P2"
      - "priority:P3"
      - "asf:from-transcript"
      - "needs-assignment"
      - "agent-triaged"
    max: 6
  set-issue-type:
    allowed: ["Bug", "Feature", "Task"]
    max: 1
  # No github-token here on purpose. GH_AW_AGENT_TOKEN is a gh-aw magic secret:
  # when it exists in the repository it is picked up automatically through the
  # fallback chain GH_AW_AGENT_TOKEN || GH_AW_GITHUB_TOKEN || GITHUB_TOKEN.
  # The pre-steps check above is what guarantees it is actually present.
  assign-to-agent:
    name: copilot
    max: 1
---

# Issue enrichment and routing

An issue was just opened in this repository. Decide whether it came from the
Agentic Software Factory intake pipeline and, if it did, enrich and route it.

## Tool naming

Every safe output below is exposed as a tool whose name carries a `safeoutputs-`
prefix: `safeoutputs-add_comment`, `safeoutputs-add_labels`,
`safeoutputs-set_issue_type`, `safeoutputs-assign_to_agent`. The unprefixed
names do not exist. If a call returns `Tool '<name>' does not exist`, that is a
naming mistake — add the prefix and retry. Do not treat it as a missing
capability and do not fall back to the `safeoutputs` command on `PATH`; that CLI
writes for real and has no dry-run, so probing it causes visible damage.

For `safeoutputs-assign_to_agent`, provide the triggering issue's number as
`issue_number` (an integer), not just `rationale` and `confidence`. For example,
for issue #69 call the tool with
`{"issue_number":69,"rationale":"Reproducible Bug ready for a fix","confidence":"HIGH"}`.
The tool can acknowledge a request that lacks `issue_number`, but the safe-output
processor will reject it later. Do not interpret the tool acknowledgment as
proof that Copilot was assigned.

## Step 1 — Check for the pipeline marker. Do this first, and take it seriously.

`issues: opened` fires for **every** issue in this repository, including ones a
human typed by hand. Enriching those would be wrong and noisy.

Read the body of the triggering issue and look for the pipeline marker.

The marker is an HTML comment and cannot be quoted here — the prompt pipeline
strips HTML comments, so it would reach you as an empty line. Get the literal by
running:

```
cat .github/factory/asf-spec-marker.txt
```

Then check whether the issue body contains that exact line. Do not guess it or
reconstruct it from memory.

**If the marker is absent, stop immediately.** Emit no labels, no comment, no
issue type, no agent assignment. Report that the issue was not produced by the
pipeline and end your run. That is a success, not a failure.

The marker is the only reliable signal. Do not infer pipeline origin from the
title, the formatting, the section headings, or the fact that the body "looks
generated". A human who copies the template is still a human.

## Step 2 — Recover the triage signal from the project board

The factory project is configured in this repository. Read it by running:

```
cat .github/factory/config.json
```

Use `project.owner` (an organization) and `project.number`. The project URL is
`https://github.com/orgs/<project.owner>/projects/<project.number>`. If either
value is empty, post a single comment saying the factory project is not
configured, apply only the `asf:from-transcript` label, and stop.

Before recovering fields, make duplicate candidates visible for pipeline issues
that skipped the draft gate. Use `projects_list` to fetch the 100 most recently
updated other drafts from the configured project, and never read any other
project. Also use `search_issues` and `list_issues` to find up to 50 plausible
other open issues and 50 plausible issues closed in the last 90 days in this
repository only, using at most three targeted searches over
the new issue's distinctive concepts. Compare its context, problem/proposal,
reproduction, and acceptance criteria against the substance of those items, not
title similarity alone. These bounds keep API and context cost predictable while
favoring recent, substantively matched work.

Read the issue body and all existing comments, paginating until none remain. If
neither contains the exact heading `## Possible duplicates` and you find
plausible matches, post one short comment headed `## Possible duplicates` with a
Markdown link and one-sentence overlap explanation for each match. Draft items
are not visible to everyone who can read this repository, so when this
repository is public, list only matching issues and never quote, summarize, or
name a draft. Read `/tmp/gh-aw/repository-visibility.txt` with `cat`; treat the
repository as public unless the file says exactly `private`. If the exact
heading already exists or there are no plausible matches, post no duplicate
comment. This check is advisory: never close, merge, edit, remove, or skip
routing an item because of a match. The human gate owns that decision.

A converted draft always has the heading, including when its result was
`None found.` That intentionally suppresses a redundant post-conversion check:
the draft was already checked before the human gate. A direct pipeline issue
without the heading gets the check here.

`## Possible duplicates` is an exact intake-contract heading; do not rename,
rephrase, or change its level.

The draft this issue was converted from carried its triage decision in project
custom fields, because Projects v2 drafts cannot hold labels or issue types.
Converting the draft preserved those fields on the project item.

Using the GitHub `projects` toolset, find the item for this issue on the
configured project and read:

- **`Proposed Type`** — `Bug`, `Feature`, or `Chore`
- **`Priority`** — `P0`–`P3`
- **`Complexity`** — `XS`–`XL`

If you cannot find the project item or `Proposed Type` is empty, do **not**
guess a type from the issue text. Post a single comment explaining exactly what
you looked for and could not find, apply only the `asf:from-transcript` label,
and stop. A human will fix the board. Silently guessing produces a
confidently-mislabelled issue, which is worse than an obviously-stuck one.

## Step 3 — Apply labels and the real issue type

Apply `asf:from-transcript` to every pipeline issue, plus:

| `Proposed Type` | Labels | GitHub issue type |
|-----------------|--------|-------------------|
| `Bug` | `type:bug`, `agent-triaged` | `Bug` |
| `Feature` | `type:feature`, `needs-assignment` | `Feature` |
| `Chore` | `type:chore`, `needs-assignment` | `Task` |

Also apply the matching `priority:*` label for the board's `Priority` value.

Set the GitHub issue type with the `set_issue_type` safe output. This is a real
issue type, not a label — it is the thing the draft could never carry, and
applying it here is the entire reason this workflow exists.

## Step 4 — Notify the owning team

Read `CODEOWNERS` (check `CODEOWNERS`, `.github/CODEOWNERS`, and `docs/`) and
work out which team owns the files this issue concerns. Mention that team in
your routing comment so the work reaches a human who can act on it.

If no `CODEOWNERS` file exists, or no active (uncommented) rule matches the
files this issue concerns, say in the routing comment that no owning team is
configured. Do not guess an owner and do not mention anyone else instead.

## Step 5 — Route

### If `Proposed Type` is `Bug`

1. **Post a short routing comment** that mentions the owning team (or says none
   is configured) and states the
   board's `Priority` and `Complexity`. Do not claim that Copilot has been
   assigned: safe outputs are applied only after this agent finishes.
2. **Hand off.** Call `safeoutputs-assign_to_agent` with
   `issue_number` set to the triggering issue's number and `confidence` and
   `rationale` describing why the Bug is ready. The Copilot coding agent will
   pick it up and open a pull request only if that safe output is accepted.

**Do not investigate the codebase.** Do not open source files looking for the
defect, do not form a root-cause hypothesis, and do not run code to test one.
Locating and fixing the defect is the coding agent's job, and it will read the
repository itself. Your responsibility ends at classifying the issue and handing
it to the right place.

The issue body already carries `## Context`, `## Problem`, and `## Reproduction`
from intake. If the body says a section was missing from the source, leave that
statement alone. It is a signal to the coding agent that it will have to dig,
and overwriting it with a guess would hide that.

### If `Proposed Type` is `Feature` or `Chore`

Post a short routing comment that mentions the owning team (or says none is
configured), states the board's
`Priority` and `Complexity`, and says the item is waiting in the backlog for a
human to assign.

**Do not emit `assign_to_agent`.** Features are deliberately not auto-staffed —
a human decides whether and when new capability gets built. The
`needs-assignment` label is the queue.

## Budget

One routing comment. Never more.
