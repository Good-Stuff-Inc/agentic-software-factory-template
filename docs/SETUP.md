# Setting up the factory

This guide takes a repository created from this template to a working factory.
Plan on about 30 minutes, most of it creating tokens.

| Step | What you do | Who |
|---|---|---|
| [1](#1-create-the-repository) | Create the repository from the template | Anyone with repo-create rights |
| [2](#2-enable-the-copilot-coding-agent) | Enable the Copilot coding agent | Organization owner |
| [3](#3-provision-the-repository-and-board) | Provision labels, board, issue types, environment, ruleset and security | Organization owner |
| [4](#4-create-the-factory-tokens) | Create the two factory tokens and store them as secrets | Repository admin |
| [5](#5-tell-the-factory-about-your-code) | Edit `CODEOWNERS` and `AGENTS.md` | Repository maintainer |
| [6](#6-run-the-doctor) | Run the doctor until every check passes | Repository admin |
| [7](#7-remove-the-setup-token) | Delete and revoke the setup token | Repository admin |
| [8](#8-try-it) | Run intake once and watch a bug route | Anyone with write access |

Until step 4 is done, `issue-enrichment` fails on every new issue in the
repository with an error naming the missing secret. That is intentional. It
fails loudly instead of skipping silently, and it stops on its own once the
secrets exist. GitHub Agentic Workflows also opens an `[aw] … failed` issue for
each failure; close those once the secrets are in place.

## Before you start

- The repository must belong to a GitHub **organization**, not a personal
  account.
- The organization needs GitHub Copilot Business or Enterprise, with Copilot
  usage billed to the organization. The enrichment workflow's inference runs on
  the organization's Copilot entitlement, not an individual's.
- Rulesets, environment branch policies, CodeQL and secret scanning on
  **private** repositories need GitHub Team or Enterprise, and GitHub Advanced
  Security for the scanning features.
  Setup reports a warning, not a failure, when they are unavailable.
- If your organization restricts fine-grained personal access tokens, an owner
  may need to approve each token under **Organization settings → Personal
  access tokens → Pending requests**.

## 1. Create the repository

Click **Use this template → Create a new repository** and choose your
organization as the owner. Make it **private or internal**. A public repository
works, but the factory reads organization project data, and an agent mistake
or a successful prompt injection could post that data where anyone can read it.
On public repositories the enrichment agent never quotes board drafts in its
comments, but treat that as a mitigation, not a boundary.

Generating from a template copies files only. Labels, the project board, secrets
and settings are not copied, which is what step 3 is for.

## 2. Enable the Copilot coding agent

The factory assigns Bug issues to the Copilot coding agent, so the agent must be
available in the new repository.

1. In **Organization settings → Copilot → Coding agent**, allow the coding
   agent for this repository (or for all repositories).
2. Make sure the person who will own `GH_AW_AGENT_TOKEN` in step 4 has a Copilot
   seat.

Agentic workflow inference needs no token of its own. The workflow declares
`copilot-requests: write`, so each run uses its built-in token and usage bills
to your organization's Copilot subscription.

## 3. Provision the repository and board

`setup` creates everything a template cannot copy. It is idempotent: rerunning
it creates only what is missing and never deletes or edits what is already
there.

| Step | What it does |
|---|---|
| `labels` | Creates the labels in [`labels.json`](../.github/factory/labels.json), and updates their color or description if they differ. |
| `project` | Finds or creates the organization project named in [`config.json`](../.github/factory/config.json) (default title `Agentic Software Factory`), links it to the repository, adds the single-select fields `Proposed Type` (Bug, Feature, Chore), `Priority` (P0–P3) and `Complexity` (XS–XL), and adds a **Needs assignment** view. Records the project number in `config.json`. |
| `issue-types` | Creates or enables the organization issue types Bug, Feature and Task. |
| `environment` | Creates the `factory` environment, which holds the factory tokens, and limits it to the default branch. Also limits `factory-bootstrap` if it exists. |
| `ruleset` | Adds a default-branch ruleset: pull requests required with `requiredApprovals` approvals (from someone other than the last pusher, when that is 1 or more), no force pushes or deletion, and Copilot code review on push. Skipped while an earlier step has failed. |
| `security` | Enables secret scanning, push protection, Dependabot alerts and CodeQL default setup. |

Before running it, review [`config.json`](../.github/factory/config.json):

```json
{
  "project": { "owner": "", "number": null, "title": "Agentic Software Factory" },
  "ruleset": { "enabled": true, "requiredApprovals": 1 },
  "security": { "enabled": true }
}
```

- Leave `owner` and `number` empty to have setup create a project called
  `title`. To use an existing board, set `number` to its project number.
  Setup only picks up a same-titled board on its own if that board is already
  linked to this repository, so it never takes over another team's project.
- `requiredApprovals` is how many approvals a pull request needs. At `1` or
  more, whoever pushed last cannot be the approver, so you cannot merge your own
  pull request. If you are trying the factory on your own, set it to `0`.
- Set `ruleset.enabled` or `security.enabled` to `false` if you manage those
  centrally.
- Commit and push your edits to the default branch before running setup. The
  workflow reads the file from there, and setup writes back only
  `project.owner` and `project.number`. An edit that stays on your machine is
  either not applied or not recorded, and the repository ends up configured
  differently from the committed file.

### The setup token

Setup needs more access than the factory does day to day, so it uses its own
short-lived token. Create a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
as an **organization owner**:

| Setting | Value |
|---|---|
| Token name | `asf-bootstrap` |
| Expiration | 7 days |
| Resource owner | Your organization |
| Repository access | Only select repositories → this repository |
| Repository permissions | Actions: Read. Administration: Read and write. Contents: Read and write. Issues: Read and write. Metadata: Read |
| Organization permissions | Projects: Read and write. Issue types: Read and write |

Do not use a classic token here. The `admin:org` scope it would need grants
control of the whole organization.

### Option A: run the Factory setup workflow (recommended)

1. Create an environment for the token under **Settings → Environments → New
   environment**, named `factory-bootstrap`. Under **Deployment branches and
   tags**, choose **Selected branches and tags** and add your default branch.
   If your plan offers **Required reviewers**, add yourself.
2. Store the token as an environment secret named `ASF_BOOTSTRAP_TOKEN` in that
   environment, or:

   ```bash
   gh secret set ASF_BOOTSTRAP_TOKEN --env factory-bootstrap --repo <org>/<repo>
   ```

   Never store it as a repository secret. Anyone with write access can push a
   branch whose workflow reads repository secrets; environment secrets are only
   released to the branches the environment allows.

3. Open **Actions → Factory setup → Run workflow** on the default branch. Tick
   **dry_run** the first time and read the plan in the run summary.
4. Run it again without **dry_run**.

If you added required reviewers to `factory-bootstrap`, every run, the dry run
included, waits at **Waiting** until a reviewer opens it and chooses **Review
deployments → Approve and deploy**.

The workflow commits the project number to `.github/factory/config.json` on the
default branch for you. Pull that commit before working locally. It writes only
`project.owner` and `project.number`, so any other change to `config.json` has to
be on the default branch before you run it.

To run only some steps, list them in **steps**, for example `labels,project`.

### Option B: run setup from your machine

As an organization owner, with the [GitHub CLI](https://cli.github.com/)
signed in with the `project` and `admin:org` scopes:

```bash
gh auth refresh -s project,admin:org
node .github/factory/scripts/setup.mjs --dry-run
node .github/factory/scripts/setup.mjs --commit-config
git checkout -- .github/factory/config.json && git pull
gh auth refresh --remove-scopes admin:org
```

`--commit-config` commits the project number to the default branch through the
API before the ruleset step protects it. It writes only `project.owner` and
`project.number`, so commit and push any other edit to `config.json` first; the
`git checkout` above would discard it. Without `--commit-config`, setup only
updates your local `config.json` and you commit it yourself. Other flags:
`--only <steps>`, `--skip <steps>`, `--repo <org>/<repo>`. The last command
drops `admin:org` from your CLI login again, so later tools you run with it,
including Copilot CLI during intake, do not hold organization admin rights.

### What to check afterwards

The run summary lists every step as created, updated, ok, warn or fail. Fix
every ❌ and run setup again; each step is safe to repeat. While any step has
failed, setup skips the `ruleset` step, because a ruleset that requires pull
requests would block the fix. Warnings tell you what to do by hand. The most
common:

- **Ruleset stricter than you want.** Setup never edits an existing ruleset.
  Loosen it under **Settings → Rules → Rulesets**, for example by lowering the
  required approvals.
- **View created without a sort.** Open the board's **Needs assignment** view
  and sort it by `Priority`, ascending.
- **Ruleset created without Copilot code review.** Your plan or policy does not
  allow it; add it to the ruleset by hand later if it becomes available.
- **Security feature not enabled.** Expected on private repositories without
  GitHub Advanced Security.
- **Environment not limited.** Your plan does not support environment branch
  policies. The factory tokens then have to be repository secrets, which anyone
  with write access can read through a workflow on their own branch. Only do
  that if every writer could be trusted with the tokens themselves.

New boards also get GitHub's default **View 1**, which stays first. Drag the
**Needs assignment** tab to the front (or delete **View 1**) so the backlog is one
click away.

## 4. Create the factory tokens

The built-in `GITHUB_TOKEN` cannot reach organization projects, and GitHub
rejects GitHub App tokens for assigning the Copilot coding agent. The factory
therefore needs two personal access tokens.
[ARCHITECTURE.md](ARCHITECTURE.md#tokens) explains why.

Create both as
[fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new)
with your organization as the resource owner and only this repository selected.
Set an expiration that matches your rotation policy.

### `GH_AW_READ_PROJECT_TOKEN`

Lets the enrichment agent read the board item behind a converted issue.

| Setting | Value |
|---|---|
| Repository permissions | Contents: Read. Issues: Read |
| Organization permissions | Projects: Read |

> **Projects appears twice on the token page.** Choose it under
> **Organization permissions**, not Repository permissions. The repository
> version cannot see an organization board, and this is the most commonly
> missed step in the whole setup.

Organization project access cannot be narrowed to one board: this token can read
every project its owner can see. That is why it is read-only. To limit what it
can expose, create it from a dedicated account that can see only the factory
board.

### `GH_AW_AGENT_TOKEN`

Assigns the Copilot coding agent to Bug issues.

| Setting | Value |
|---|---|
| Repository permissions | Metadata: Read. Actions, Contents, Issues, Pull requests: Read and write |

- It must be a personal access token. GitHub App installation tokens are
  rejected for agent assignment.
- The token owner needs write access to the repository and a Copilot seat.
- Copilot's pull requests count as requested by this person, so they cannot
  approve them. Make sure someone else can review.
- The ruleset stops whoever pushed last from approving, so nobody can push to a
  Copilot branch and approve their own change. Steering Copilot through issue
  text is not a push, though. Agree as a team that whoever wrote or converted an
  issue does not approve the pull request that comes from it, or raise
  `requiredApprovals` to `2`.

The workflow does not reference this secret by name: GitHub Agentic Workflows
picks up a secret called `GH_AW_AGENT_TOKEN` automatically. The name is the
configuration.

### Store them

Store both in the `factory` environment that setup created. Its secrets are only
released to workflows running on the default branch:

```bash
gh secret set GH_AW_READ_PROJECT_TOKEN --env factory --repo <org>/<repo>
gh secret set GH_AW_AGENT_TOKEN --env factory --repo <org>/<repo>
```

Do not store them as repository or organization secrets. A workflow on any
branch can read those, so anyone with write access could take the tokens. The
local doctor run warns when it finds them there; the workflow cannot, because a
secret looks the same to it wherever it is stored. When another repository
adopts the factory, give it its own `factory` environment and secrets.

## 5. Tell the factory about your code

- **[`.github/CODEOWNERS`](../.github/CODEOWNERS).** Enrichment names the owning
  team in its routing comments. Every example rule ships commented out; add
  rules for your paths and teams. GitHub silently ignores owners it cannot
  resolve, and the doctor catches that.
- **[`AGENTS.md`](../AGENTS.md).** The Copilot coding agent reads it. Fill in
  your install, build and test commands so its pull requests arrive tested.
- **[`.github/agents/requirements-agent.md`](../.github/agents/requirements-agent.md)**
  (optional). The intake agent's rules for what becomes a work item. The
  defaults are deliberately conservative.

## 6. Run the doctor

Open **Actions → Factory doctor → Run workflow** on the default branch. It uses
the real secrets, changes nothing, and writes a report to the run summary.

| Area | Checks |
|---|---|
| Configuration, Intake marker, Label allow-list, Enrichment workflow | Files are present and consistent with each other |
| Repository, Labels | Organization-owned; every label exists |
| Secrets | Both factory tokens are set. Locally, also that they are not repository or organization secrets and that the setup token is gone |
| Environment | The `factory` environment exists and only the default branch can use it |
| Project access, fields, link, view | The read token can see the board; fields, options, repository link and view exist |
| Issue access | The read token can read issues |
| Copilot coding agent | The agent token can assign Copilot here |
| Issue types | Bug, Feature and Task are available |
| CODEOWNERS | No syntax errors or unknown owners; no placeholder owners |
| Default branch | Pull requests are required |

Fix each **fail** and rerun until there are none. Warnings are worth reading
but do not stop the factory. Also run it locally, as someone who can administer
the repository, with `node .github/factory/scripts/doctor.mjs`. Only the local
run can list where each secret is stored, so only it warns about a factory token
kept as a repository or organization secret, or a setup token that is still set.
Without the secrets' values it skips the checks that need them.

## 7. Remove the setup token

Once the doctor passes, the setup token has done its job:

1. Delete the `ASF_BOOTSTRAP_TOKEN` secret:
   `gh secret delete ASF_BOOTSTRAP_TOKEN --env factory-bootstrap --repo <org>/<repo>`.
2. Revoke the token under
   [Settings → Personal access tokens](https://github.com/settings/personal-access-tokens).

The local doctor run warns while the secret still exists; the workflow cannot see
the `factory-bootstrap` environment. Create a new token if you ever need to
rerun setup.

## 8. Try it

1. Make sure your GitHub CLI can write to projects: `gh auth refresh -s project`.
2. Open a Copilot session in your clone and ask: *"use meeting-intake on
   `<path to a transcript>`"*. Use a short meeting where somebody describes a
   real defect in this repository.
3. Open the board, review the draft, set `Proposed Type` to `Bug`, and use
   **Convert to issue** to create it in this repository.
4. Within a couple of minutes the issue gets `type:bug`, `agent-triaged`, a
   priority label, the issue type Bug, a routing comment, and **Copilot** under
   **Assignees**. A pull request follows.
5. Open an issue by hand. Enrichment runs, finds no intake marker, and does
   nothing.

## Optional: notify owning teams

By default the routing comment names the owning team without notifying it:
GitHub Agentic Workflows neutralizes team mentions it has not been told to
allow. To let the comment notify specific teams, list them in
[`issue-enrichment.md`](../.github/workflows/issue-enrichment.md):

```yaml
safe-outputs:
  mentions:
    allowed-collaborators: true
    allowed-teams:
      - "your-org/payments-team"
```

Then run `gh aw compile` and commit both `issue-enrichment.md` and
`issue-enrichment.lock.yml`. Convert one test draft to confirm the team receives
the notification.

## Troubleshooting

**`issue-enrichment` fails with "Missing secret".** Step 4 is not finished. The
log prints the exact token settings.

**A run fails with "not allowed to deploy to factory".** The workflow ran on a
branch the environment does not allow. Run it from the default branch. If it
already was, rerun setup with the `environment` step; it adds the default branch
to the environment.

**`issue-enrichment` says a secret is missing but you set it.** It is probably
in the wrong place. The factory tokens belong to the `factory` environment and
the setup token to `factory-bootstrap`, under **Settings → Environments**.

**`issue-enrichment` fails at "Require factory configuration".**
`config.json` on the default branch has no project. Run setup, or commit the
project's `owner` and `number`.

**A converted issue gets no labels.** Enrichment found no intake marker. Only
drafts written by the intake skill carry it, as the first line of the body; if
someone edited that line before converting, the issue is treated as
hand-written. The marker is in
[`asf-spec-marker.txt`](../.github/factory/asf-spec-marker.txt).

**The routing comment says it could not find the project item.** The draft was
not on the configured board, or its `Proposed Type` was empty. Fix the board
item, then rerun the failed workflow run from the Actions tab.

**A Bug is labelled but Copilot is not assigned.** Run the doctor and look at
**Copilot coding agent**. Usually the coding agent is not enabled for the
repository, or the `GH_AW_AGENT_TOKEN` owner has no Copilot seat.

**Intake fails with "Projects v2 access check failed".** Run
`gh auth refresh -s project` and try again.

**Setup stops at the start with "Bad credentials (HTTP 401)".** GitHub rejected
the setup token. With Option A, the `ASF_BOOTSTRAP_TOKEN` secret in the
`factory-bootstrap` environment is mistyped, expired or revoked: store a current
token there and run setup again. With Option B, run `gh auth status`, and unset
`GH_TOKEN` if it holds an old token.

**Setup stops at the start with "Not Found (HTTP 404)".** The setup token cannot
see the repository. Check the repository name, and that the token's resource
owner is your organization and its **Repository access** includes this
repository.

**Setup warns "Could not read the … environment" with HTTP 403.** The setup
token is missing **Actions: Read**. Add it to the token, or create a new one from
the table in [The setup token](#the-setup-token), and run setup again.

**Setup fails with "Could not commit config.json".** The default branch is
already protected. Open a pull request that sets `project.owner` and
`project.number` in `config.json`.

**Setup fails because a field is missing options.** A project field with the
same name already exists. Add the missing options in the board's field settings;
setup never edits existing options because that can clear values on existing
items.

**Setup fails with "already exists ... but is not linked".** Another project in
the organization has the same title. Set `project.number` to share it, or change
`project.title` to create a separate board.

**The Factory setup or doctor job is skipped.** Both only run from the default
branch. Pick it in **Run workflow**.

**Issues titled `[aw] …` appear, labelled `agentic-workflows`.** GitHub Agentic
Workflows opens them itself. `[aw] Issue enrichment and routing failed` links
the failed run; fix the cause, rerun that run, then close the issue.
`[aw] Detection Runs` collects runs where the threat-detection pass flagged
something or could not finish; a failed agent run also lands there. These
issues are opened by `GITHUB_TOKEN`, so they never trigger enrichment
themselves.
