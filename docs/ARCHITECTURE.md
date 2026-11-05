# How the factory works

Read this before changing the factory. Several choices look arbitrary until you
hit the constraint behind them.

## The intake contract

Every intake adapter produces the same artifact, and nothing after the human
gate knows which adapter produced it.

| Part | What it holds |
|---|---|
| Marker | The line in [`asf-spec-marker.txt`](../.github/factory/asf-spec-marker.txt) as the first line of the body. Enrichment tells factory issues from hand-written ones by this and nothing else. |
| Body | Context, problem or proposal, reproduction for bugs, acceptance criteria. What the work is, never how to do it. |
| Possible duplicates | Links to substantively similar board drafts, open issues, and issues closed in the last 90 days, or `None found.` Required, so a missing check never reads as a clean one. Advisory only. |
| Project fields | `Proposed Type`, `Priority`, `Complexity`. The triage decision lives on the board item. |
| Provenance | Adapter plus source reference, stamped under `## Source` by the emitter. Adapters supply it; they never hand-write it. |

Adapters never write to GitHub directly. They hand a JSON payload to the shared
emitter, [`intake-guardrails/emit.mjs`](../.github/skills/intake-guardrails/emit.mjs),
which:

- validates every item against the contract,
- caps a batch at 10 items,
- passes untrusted text as process arguments, never through a shell,
- writes drafts to the configured project,
- reads every item back, and rolls the whole batch back if anything does not
  match.

The emitter enforces integrity, not consent. Consent is the human gate.

## From issue to merge

1. **Sort.** `issue-enrichment` runs on every new issue and first checks for
   the marker. No marker, no action.
2. **Route on proposed type.** A Bug gets labels, a real issue type and a
   routing comment, then goes straight to the Copilot coding agent. A Feature
   or Chore gets labels and `needs-assignment`, then stops. New scope is a
   product decision, so the factory will not make it for you.
3. **Build.** The coding agent plans, implements, writes a regression test and
   iterates in its own environment. A person can unassign it and write the
   change instead; nothing downstream cares who typed it.
4. **Propose.** A pull request opens, linked to the issue and through it to the
   original source.
5. **Verify.** CI, Copilot code review, CodeQL and secret scanning run before a
   person spends attention on it.
6. **Gate.** The ruleset requires a pull request and approval. The agent cannot
   merge its own work.
7. **Land.** Provenance survives the whole way.
   [`verify-provenance.mjs`](../.github/factory/scripts/verify-provenance.mjs)
   walks a commit back to its pull request, the issue it closes, and the
   `## Source` stamp, and prints JSON:

   ```
   { "commit": "1257c0a", "pullRequest": 63, "issue": 45,
     "origin": "intake", "adapter": "meeting-intake", "sourceRef": "standup.vtt" }
   ```

   A hand-written issue counts as traceable too, with origin `manual`. Anything
   else exits non-zero and names the hop that broke. It never reports an
   unknown origin as a pass.

Why Bugs and Features differ: a bug is a known-good system behaving wrongly, so
the target state is defined and an agent can drive at it. A feature is a product
decision, and product decisions are not delegated to a workflow trigger.

Enrichment deliberately does not investigate the code. It classifies and
routes. Locating a defect is the coding agent's job, and a second agent guessing
at a root cause first would either duplicate that work or anchor it on a
location nobody reviewed.

## Why it is built this way

### Drafts are deliberately impoverished

A Projects draft issue holds a title, a body, assignees and project field
values. It cannot hold labels, milestones, issue types or comments, and creating
one sends no notifications.

So `Proposed Type` is a project field, not an issue type: a project field is the
only carrier that survives the draft boundary. The real issue type is applied
later by enrichment, once a real issue exists.

### The human gate is a dialog that asks one question

**Convert to issue** asks for a target repository and nothing else. It cannot
set labels or an issue type. Everything else has to be applied after
conversion, which is why enrichment exists as a separate step.

### Conversion looks exactly like a person typing an issue

Converting a draft fires an ordinary `issues: opened` event, the same as a
person filing an issue by hand. The event carries nothing that tells them
apart, so the factory uses a marker: an HTML comment on the first line of every
draft body. Enrichment does nothing unless it finds it. Without the marker,
every hand-written issue would be labelled, typed and assigned to an agent.

The marker lives only in
[`asf-spec-marker.txt`](../.github/factory/asf-spec-marker.txt), and both
agents read that file at runtime instead of being shown the marker. The
indirection matters: GitHub Agentic Workflows strips HTML comments when it
assembles a prompt, so a marker quoted in the prompt reaches the agent as an
empty line. The producer would then omit it and the consumer would look for
nothing, failing silently at both ends. If you change the marker, change it in
that file.

If the factory ever appears to do nothing, check the marker first.

## Tokens

| Credential | Used by | Why |
|---|---|---|
| Built-in `GITHUB_TOKEN` | Enrichment inference, labels, comments, issue type | Declares `copilot-requests: write`, so Copilot inference bills to the organization with no stored token. |
| `GH_AW_READ_PROJECT_TOKEN` | Enrichment's GitHub tools | `GITHUB_TOKEN` is scoped to the repository and cannot reach organization projects at all. No `permissions:` entry changes that. |
| `GH_AW_AGENT_TOKEN` | Assigning the Copilot coding agent | Agent assignment requires a personal access token; GitHub App tokens are rejected. |
| `ASF_BOOTSTRAP_TOKEN` | Factory setup only | Creating projects, issue types and rulesets needs administrative access the factory never needs again. Delete it after setup. |
| Your own `gh` login | Intake | Intake runs in your session and writes drafts with your credentials, so drafts are attributable to a person. |

The stored tokens are environment secrets, not repository secrets. An environment
limited to the default branch keeps them away from workflows that someone with
write access pushes on another branch.

The read token is read-only because organization project access cannot be
narrowed to a single board. Board writes happen only at intake, through the
emitter, as the person running it.

## Guardrails

- **Safe outputs.** The enrichment agent has read-only tools. Its writes are
  requests (labels, issue type, comments, agent assignment) that GitHub Agentic
  Workflows validates and applies after the agent finishes. Labels are limited
  to an allow-list that a test keeps equal to
  [`labels.json`](../.github/factory/labels.json).
- **Routing check.** A post-step,
  [`validate-routing-output.mjs`](../.github/factory/lib/validate-routing-output.mjs),
  fails the run if the agent labelled a factory issue `type:bug` without a
  Copilot handoff naming that same issue. A routing comment alone is never
  treated as a completed handoff.
- **Fail loudly.** Missing tokens or missing configuration stop the workflow
  with an error naming the fix, instead of skipping enrichment silently.
- **Untrusted input.** Transcripts and issue bodies are treated as data. The
  agents are told not to follow instructions in them, and the emitter never
  passes their text through a shell.

## Adding an adapter

An adapter is anything that turns a signal into contract-shaped items: a
support-ticket cluster, an alert, a spec, a chat thread. To add one:

1. Decide where its human gate sits. If a person reviews afterwards, emit
   drafts and let **Convert to issue** be the gate.
2. Produce items in the emitter's JSON shape and write them only through
   `emit.mjs`. Supply `adapter` and `sourceRef` so provenance is stamped.
3. Validate the payload with
   [`validate-intake-contract.mjs`](../.github/factory/lib/validate-intake-contract.mjs)
   before showing it to a person.

Nothing after the gate changes. Enrichment, routing and review already handle
anything that satisfies the contract.

## Known limitations

- **Deployment is out of scope.** The factory ends at an approved, merged pull
  request. Everything up to merge is reversible and reviewable in a diff;
  deployment is neither, and extending an agentic pipeline past merge is a
  separate risk conversation.
- **No board-event trigger.** `projects_v2_item` is an organization webhook,
  not an Actions trigger, so nothing can react to a card moving between
  columns. Drive automation from issue events instead.
- **The gate is manual.** Nothing moves while nobody looks at the board, and
  drafts send no notifications.
- **Duplicate detection is advisory.** Running intake twice creates new drafts,
  with links to the earlier ones. A reviewer decides.
- **No feedback loop.** Nothing measures whether proposed `Priority` and
  `Complexity` were right.
- **One repository per setup.** Several repositories can share one board, but
  each needs its own setup run and secrets.
- **Cost is not modelled.** Every enrichment run and coding-agent session
  spends Copilot usage.
- **Agent roles are instructed, not sandboxed.** "Classify, do not
  investigate" is a prompt rule. Only the safe-output allow-lists are enforced
  mechanically. The routing check fails a run that skipped the Copilot handoff
  but does not hold back its other outputs.
