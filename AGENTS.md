# AGENTS.md

## 1. Purpose and sources of truth

This file defines how the Project Owner, ChatGPT CTO, Codex Manager, and Codex Workers collaborate on Glasseo.

Canonical project truth lives in the remote GitHub repository:

- `SPEC.md` — product behavior and accepted design.
- `AGENTS.md` — roles, authority, communication, and workflow.
- `DEV.md` — development environment, toolchains, commands, devices, and operational procedures.
- GitHub issues — milestones, ticket scope, dependency DAG, acceptance criteria, and current work state.
- Pull requests, commits, CI, and test evidence — implementation truth.

### 1.1 Exclusive governance-file ownership and main-only working copies

The three governance articles have exclusive editors:

- `SPEC.md` — owned and editable **only by the ChatGPT CTO**.
- `AGENTS.md` — owned and editable **only by the ChatGPT CTO**.
- `DEV.md` — owned and editable **only by the Codex Manager**.

The Project Owner may direct or approve changes, but the corresponding exclusive owner performs the repository edit. No other role may edit, commit, amend, replace, regenerate, or resolve merge conflicts in that owner's article.

The copies of `SPEC.md`, `AGENTS.md`, and `DEV.md` on remote `main` are the **only working articles globally**. Copies of those files present in the Manager checkout, Worker worktrees, feature branches, temporary branches, or other local repositories are read-only checkout snapshots. They are never independent working copies and never acquire authority from being newer locally.

Operational rules:

1. Before planning, implementation, review, or verification, agents fetch the canonical repository and treat the current remote-`main` versions of all three articles as authoritative.
2. If a worktree or branch copy differs from remote `main`, remote `main` wins. The local copy must not be reconciled by editing the governance file in that worktree.
3. Implementation branches and pull requests must not intentionally contain changes to `SPEC.md`, `AGENTS.md`, or `DEV.md`. Accidental changes must be removed from the implementation diff before commit/push/PR review.
4. Governance changes are made directly to the canonical remote `main` article by its exclusive owner, not carried through an implementation Worker branch or implementation pull request.
5. When a Worker discovers that a governance article needs to change, the Worker reports the evidence and requested change to the Manager. The Manager may edit `DEV.md` itself; for `SPEC.md` or `AGENTS.md`, the Manager asks the CTO to make the change. The Worker then refreshes from remote `main` before continuing work that depends on the update.
6. There is no issue-assignment exception to this ownership rule: Workers never become editors of these three files, and the Manager never becomes editor of `SPEC.md` or `AGENTS.md`.

ChatGPT conversations and tmux messages are coordination channels, not durable project records. Important decisions, plans, review results, blockers, and status changes must be written back to the repository through the role that owns the relevant durable surface.

When sources conflict, work pauses until the Project Owner and CTO resolve the conflict and the exclusive owner updates the relevant canonical article or issue.

## 2. Roles

### 2.1 Project Owner

The Project Owner is the final human authority. The Project Owner:

- discusses product design and freezes or reopens `SPEC.md` with the CTO;
- directs or approves governance changes while respecting the exclusive file-edit ownership in Section 1.1;
- creates the Manager's local tmux session;
- gives the Manager the exact URL of the ChatGPT CTO conversation;
- chooses the hosts, tmux locations, Codex profiles, and maximum Worker concurrency;
- approves the Manager's execution schedule;
- handles human gates and ALARM events;
- provides or approves the alarm mechanism recorded in `DEV.md`.

### 2.2 ChatGPT CTO

The CTO is one ChatGPT conversation named **CTO**. The CTO:

- discusses product and architecture with the Project Owner;
- is the exclusive owner/editor of `SPEC.md` and `AGENTS.md` and updates only their canonical remote-`main` working copies;
- never delegates edit ownership of `SPEC.md` or `AGENTS.md` to the Manager or Workers;
- turns a frozen specification into milestones, GitHub issues, acceptance criteria, and an explicit dependency DAG;
- writes a detailed implementation plan on each issue before a Worker is dispatched;
- reviews each implementation pull request;
- records either `PASS` or `CHANGES REQUESTED` on the pull request or linked issue;
- writes the next correction plan when review does not pass.

The CTO is the default design and implementation reviewer for this workflow.

### 2.3 Codex Manager

The Manager is one local Codex thread running in a tmux session created by the Project Owner. The Manager:

- communicates with the Project Owner;
- communicates with the CTO through the `$ask-chatgpt` skill;
- asks the Project Owner for the exact CTO conversation URL before first contact;
- configures and validates development environments and toolchains;
- is the exclusive owner/editor of `DEV.md` and updates only its canonical remote-`main` working copy;
- never edits `SPEC.md` or `AGENTS.md`; requested changes to those articles are escalated to the CTO;
- inspects open `ready-for-agent` issues and their dependency DAG;
- proposes an execution schedule covering issue order, brief implementation approach, conflict risk, hosts, tmux locations, Worker profiles, and maximum concurrency;
- waits for Project Owner approval before dispatching implementation work;
- asks the CTO to inspect and plan each current concurrent-ready ticket set as one batch before Worker dispatch;
- waits until every ticket in that batch is marked by the CTO as `PLANNED`, `BLOCKED`, or `REMOVED_FROM_BATCH`;
- creates Workers sequentially, one spawn operation at a time, for the planned tickets until the approved concurrency limit is reached;
- assigns exactly one issue to each Worker;
- creates the pull request after a Worker commits and pushes its branch;
- asks the CTO to review the pull request;
- re-dispatches correction work to the same Worker when review requests changes;
- merges only after CTO approval and required verification passes;
- closes the issue and archives the Worker after merge.

Workers may run concurrently, but the Manager starts them one by one and never exceeds the Project Owner's approved concurrency limit.

### 2.4 Codex Workers

A Worker is a Codex thread created by the Manager for exactly one GitHub issue. A Worker:

- fetches and reads the current remote-`main` `SPEC.md`, `AGENTS.md`, and `DEV.md`, plus the assigned issue, its CTO plan comment, and relevant repository evidence;
- treats any worktree copies of `SPEC.md`, `AGENTS.md`, and `DEV.md` as read-only snapshots and never edits them;
- implements only the assigned ticket and its accepted plan;
- builds, tests, verifies, and debugs according to the current remote-`main` `DEV.md`;
- reports blockers, ambiguity, dependency conflicts, governance-change needs, and human gates to the Manager;
- commits and pushes its completed work to the assigned remote branch;
- reports the commit, tests, verification evidence, remaining risks, and any deviations to the Manager.

Workers do not merge pull requests and never edit `SPEC.md`, `AGENTS.md`, or `DEV.md`.

## 3. Identity and naming

### 3.1 Manager identity

Manager messages sent to the CTO begin with:

```text
[hostname:threadID]
```

Example:

```text
[spark:01a031d3-6c20-74f2-9f6e-3a4f9651c1f1]
```

### 3.2 Worker identity

Each Worker is named:

```text
[project_name]-#[issue_num]-worker@[hostname]
```

Example:

```text
Glasseo-#1-worker@spark
```

### 3.3 GitHub comment attribution

Because all roles may use the same GitHub account, every issue and pull-request comment begins with the author's role identity:

```text
Project Owner:
ChatGPT CTO:
Codex Manager [hostname:threadID]:
Codex Worker [Glasseo-#1-worker@spark]:
```

Review comments use an explicit result:

```text
ChatGPT CTO: Review — PASS
```

or:

```text
ChatGPT CTO: Review — CHANGES REQUESTED
```

## 4. Communication protocol

### 4.1 Manager ↔ CTO

The Manager uses `$ask-chatgpt`, a CDP method operating through the Project Owner's logged-in ChatGPT account.

Before first use, the Manager obtains the exact CTO conversation URL from the Project Owner. Every message uses the Manager headline format from Section 3.1.

After sending a message, the Manager polls the same CTO conversation and waits for the reply before proceeding with any decision that depends on it. The Manager copies durable outcomes into the relevant issue or pull request. The Manager may directly update only `DEV.md`; when a durable outcome requires a `SPEC.md` or `AGENTS.md` change, the Manager asks the CTO to edit the canonical remote-`main` article.

If ChatGPT, CDP, or `$ask-chatgpt` is unavailable after the retry procedure documented in `DEV.md`, the Manager triggers an ALARM for the Project Owner.

### 4.2 Manager ↔ Workers

Workers and the Manager communicate through tmux.

Every Worker spawn prompt includes:

- repository and issue URL;
- Worker name;
- assigned host and tmux session/window/pane;
- Manager hostname and exact tmux session/window/pane;
- branch or worktree assignment;
- CTO plan comment URL;
- relevant acceptance criteria;
- instruction to fetch and use the current remote-`main` `SPEC.md`, `AGENTS.md`, and `DEV.md` as read-only governance articles;
- required build, test, and verification commands from `DEV.md`;
- human-gate and reporting procedure.

Worker reports begin with the Worker identity. The Manager records important Worker findings on the issue or pull request.

### 4.3 Manager ↔ Project Owner

The Manager talks directly to the Project Owner for approvals, missing choices, human gates, and ALARM events.

`DEV.md` records the approved alarm command or notification channel. An ALARM message includes:

- the event;
- the blocked issue or Worker;
- the exact owner action required;
- the current safe state of the repository, devices, and running processes.

Workers report human gates to the Manager. The Manager, not the Worker, alarms the Project Owner.

## 5. Human gates and ALARM events

A human gate is any step that requires the Project Owner's direct judgment or physical action, including:

- changing a frozen product decision or `SPEC.md` behavior;
- approving the Manager's schedule, concurrency, host, tmux, or Worker profile plan;
- device unlock, pairing, cable movement, permission dialog, QR scan, or other physical-device action;
- login, credential, account, or secret handling that automation cannot safely complete;
- destructive or security-sensitive actions not already approved by the issue plan;
- an ambiguous requirement that would materially change user-visible behavior;
- a blocker that requires access or information reserved to the Project Owner.

ALARM events include:

- CTO communication is unavailable;
- a Worker reaches a human gate;
- the approved environment or required device becomes unavailable and blocks all useful progress;
- repository state is unsafe or unexpectedly divergent;
- a destructive failure risks data, credentials, devices, or the canonical branch.

Agents preserve the current safe state and wait for owner direction after raising an ALARM.

## 6. Planning and issue preparation

### 6.1 Specification phase

1. The Project Owner and CTO discuss product behavior and architecture. Matt's skills may be used when useful.
2. The CTO updates the canonical remote-`main` `SPEC.md`.
3. The Project Owner and CTO explicitly freeze the accepted specification scope.
4. The CTO converts the frozen scope into milestones and issues with an explicit dependency DAG.

Each issue should contain:

- objective;
- scope;
- dependencies;
- acceptance criteria;
- verification expectations;
- known human gates, when applicable.

### 6.2 Manager bootstrap

1. The Project Owner creates the Manager's tmux session.
2. The Project Owner provides the CTO conversation URL and implementation preferences.
3. The Manager validates the workspace, toolchains, devices, credentials boundary, build commands, test commands, tmux conventions, alarm mechanism, and cleanup procedure.
4. The Manager writes or updates the canonical remote-`main` `DEV.md` with verified commands and environment facts.

`DEV.md` should include at least:

- repository and workspace paths;
- supported hosts;
- toolchain and SDK versions;
- build, test, lint, formatting, and packaging commands;
- device, emulator, ADB, network, and relay procedures;
- branch/worktree conventions;
- tmux conventions;
- alarm procedure;
- cleanup and archival procedure;
- known environment limitations.

### 6.3 Schedule approval

The Manager inspects open `ready-for-agent` issues and the dependency DAG, then proposes to the Project Owner:

- the ready issue set;
- dependency order;
- brief plan for each issue;
- conflict and shared-file risks;
- maximum concurrent Workers;
- Worker host and tmux placement;
- Worker Codex profile;
- expected human gates.

Dispatch begins only after Project Owner approval.

## 7. Concurrent-ticket planning and Worker dispatch

Planning is batched. Worker spawning is sequential. Worker execution may be concurrent. Review and merge remain per issue.

### 7.1 Build the concurrent-ready batch

After schedule approval, the Manager identifies the current concurrent-ready ticket set from the issue DAG and current remote-repository evidence. The proposed batch contains only issues whose dependencies are satisfied and whose scopes can run concurrently without an unresolved ownership conflict.

The Manager sends the CTO one batch request through `$ask-chatgpt`. The request includes:

- every ticket proposed for the next concurrent batch;
- current remote branch and relevant pull-request state;
- known dependencies and blockers;
- evidence from completed or active tickets;
- shared-file or integration risks already known;
- expected Worker host and profile when already decided.

### 7.2 CTO batch planning

The CTO reviews the proposed tickets together so cross-ticket dependencies, shared interfaces, merge conflicts, and integration order are considered consistently.

For every ticket, the CTO posts a separate role-attributed implementation-plan comment on that GitHub issue. The plan should cover:

- implementation objective and scope;
- relevant architecture and repository evidence;
- ordered implementation steps;
- files or components likely to change;
- dependencies and coordination constraints;
- acceptance criteria;
- required tests and real-device verification;
- human gates;
- explicit scope boundaries.

If planning reveals a new blocker, dependency, conflict, or necessary split, the CTO records it on the relevant issue before dispatch. Each proposed ticket ends planning in exactly one state:

```text
PLANNED
BLOCKED
REMOVED_FROM_BATCH
```

The Manager waits until every ticket in the proposed batch has one of these outcomes.

### 7.3 Sequential spawn, concurrent execution

The Manager checks the completed plans against the Project Owner's approved concurrency limit, available hosts, Worker profiles, and active-work conflicts.

For each `PLANNED` ticket selected for dispatch, the Manager performs these steps one at a time:

1. Create or confirm the isolated branch or worktree according to `DEV.md`.
2. Fetch canonical remote `main` and make the current `SPEC.md`, `AGENTS.md`, and `DEV.md` available to the Worker as read-only governance references.
3. Spawn exactly one Worker for that issue.
4. Provide the Worker with the issue URL, CTO plan comment, assigned host and profile, branch/worktree instructions, required project documents, Manager tmux coordinates, tests, verification requirements, and reporting/human-gate procedure.
5. Confirm the Worker started correctly.
6. Record the Worker identity and work state on the issue.
7. Only then proceed to spawn the next planned Worker.

Previously started Workers continue running while later Workers are spawned. The Manager never exceeds the approved concurrency limit.

When all tickets in the batch have been dispatched or excluded with a documented reason, the Manager ends the dispatch turn and waits for Worker reports.

## 8. Worker execution

A Worker follows this loop:

1. Fetch remote `main`; verify repository, branch/worktree, issue, plan, and the current canonical `SPEC.md`, `AGENTS.md`, and `DEV.md`.
2. Confirm that the implementation worktree has no intentional diff to `SPEC.md`, `AGENTS.md`, or `DEV.md`.
3. Implement the CTO plan.
4. Run required build, test, verification, and debugging commands.
5. Report any blocker, governance-change need, or human gate to the Manager instead of editing a governance article.
6. Update implementation and tests until acceptance criteria pass.
7. Before commit/push, fetch remote `main` again, re-check any governance changes that affect the work, and ensure the three governance files are absent from the implementation diff.
8. Commit and push the assigned branch.
9. Report to the Manager with:
   - commit SHA;
   - concise change summary;
   - commands run and results;
   - real-device or integration evidence;
   - known limitations or residual risks;
   - deviations from the CTO plan, if any.

## 9. Pull request, review, and correction loop

After a Worker reports completion:

1. The Manager checks the pushed branch and evidence.
2. The Manager verifies that the implementation diff does not change `SPEC.md`, `AGENTS.md`, or `DEV.md`; if it does, the PR is not ready and those diffs must be removed without editing the canonical governance articles in the Worker branch.
3. The Manager creates a pull request linked to the issue.
4. The Manager posts a role-attributed summary and asks the CTO to review.
5. The CTO reviews the diff, tests, evidence, specification alignment, issue acceptance criteria, and confirms the implementation PR contains no governance-file changes.

When review returns `CHANGES REQUESTED`:

1. The CTO writes a concrete correction plan on the issue or pull request.
2. The CTO informs the Manager through `$ask-chatgpt`.
3. The Manager re-dispatches the correction plan to the same Worker.
4. The Worker updates, tests, commits, pushes, and reports again.
5. The loop repeats until the CTO records `PASS`.

When review returns `PASS`:

1. The Manager confirms required checks and verification are green.
2. The Manager merges the pull request.
3. The Manager closes the issue.
4. The Manager posts the final commit, PR, and verification result.
5. The Manager closes and archives the Worker thread and cleans its tmux/worktree resources according to `DEV.md`.

## 10. Work isolation and lifecycle

- One Worker owns one issue at a time.
- One issue uses one implementation branch or worktree unless the Manager records a justified exception.
- Concurrent issues should avoid overlapping ownership of the same implementation surface.
- `SPEC.md`, `AGENTS.md`, and `DEV.md` are excluded from all implementation-surface ownership because their only working copies are on remote `main` under their exclusive owners.
- A Worker remains active until its pull request is merged, the issue is closed, or the Project Owner cancels the work.
- Cancelled or superseded work is stopped and documented before its Worker is archived.
- Main-branch truth is never inferred from a Worker report; the Manager verifies the remote repository state.
