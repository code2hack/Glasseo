# AGENTS.md

## 1. Purpose and sources of truth

This file defines how the Project Owner, ChatGPT CTO, Codex Manager, and Codex Workers collaborate on Glasseo.

Canonical project truth lives in the remote GitHub repository:

- `SPEC.md` — product behavior and accepted design.
- `AGENTS.md` — roles, authority, communication, and workflow.
- `DEV.md` — development environment, toolchains, commands, devices, and operational procedures.
- GitHub issues — milestones, ticket scope, dependency DAG, acceptance criteria, and current work state.
- Pull requests, commits, CI, and test evidence — implementation truth.

ChatGPT conversations and tmux messages are coordination channels, not durable project records. Important decisions, plans, review results, blockers, and status changes must be written back to the repository.

When sources conflict, work pauses until the Project Owner and CTO resolve the conflict and update the relevant canonical document or issue.

## 2. Roles

### 2.1 Project Owner

The Project Owner is the final human authority. The Project Owner:

- discusses product design and freezes or reopens `SPEC.md` with the CTO;
- creates the Manager's local tmux session;
- gives the Manager the exact URL of the ChatGPT CTO conversation;
- chooses the hosts, tmux locations, Codex profiles, and maximum Worker concurrency;
- approves the Manager's execution schedule;
- handles human gates and ALARM events;
- provides or approves the alarm mechanism recorded in `DEV.md`.

### 2.2 ChatGPT CTO

The CTO is one ChatGPT conversation named **CTO**. The CTO:

- discusses product and architecture with the Project Owner;
- writes and maintains `SPEC.md` and `AGENTS.md`;
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
- writes and maintains `DEV.md`;
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

- reads `SPEC.md`, `AGENTS.md`, `DEV.md`, the assigned issue, its CTO plan comment, and relevant repository evidence;
- implements only the assigned ticket and its accepted plan;
- builds, tests, verifies, and debugs according to `DEV.md`;
- reports blockers, ambiguity, dependency conflicts, and human gates to the Manager;
- commits and pushes its completed work to the assigned remote branch;
- reports the commit, tests, verification evidence, remaining risks, and any deviations to the Manager.

Workers do not merge pull requests. Governance documents are read-only to Workers unless their issue explicitly assigns a governance change.

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

After sending a message, the Manager polls the same CTO conversation and waits for the reply before proceeding with any decision that depends on it. The Manager copies durable outcomes into `SPEC.md`, `AGENTS.md`, the relevant issue, or the pull request.

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
2. The CTO updates `SPEC.md`.
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
4. The Manager writes or updates `DEV.md` with verified commands and environment facts.

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
2. Spawn exactly one Worker for that issue.
3. Provide the Worker with the issue URL, CTO plan comment, assigned host and profile, branch/worktree instructions, required project documents, Manager tmux coordinates, tests, verification requirements, and reporting/human-gate procedure.
4. Confirm the Worker started correctly.
5. Record the Worker identity and work state on the issue.
6. Only then proceed to spawn the next planned Worker.

Previously started Workers continue running while later Workers are spawned. The Manager never exceeds the approved concurrency limit.

When all tickets in the batch have been dispatched or excluded with a documented reason, the Manager ends the dispatch turn and waits for Worker reports.

## 8. Worker execution

A Worker follows this loop:

1. Verify repository, branch/worktree, issue, plan, and `DEV.md`.
2. Implement the CTO plan.
3. Run required build, test, verification, and debugging commands.
4. Report any blocker or human gate to the Manager.
5. Update implementation and tests until acceptance criteria pass.
6. Commit and push the assigned branch.
7. Report to the Manager with:
   - commit SHA;
   - concise change summary;
   - commands run and results;
   - real-device or integration evidence;
   - known limitations or residual risks;
   - deviations from the CTO plan, if any.

## 9. Pull request, review, and correction loop

After a Worker reports completion:

1. The Manager checks the pushed branch and evidence.
2. The Manager creates a pull request linked to the issue.
3. The Manager posts a role-attributed summary and asks the CTO to review.
4. The CTO reviews the diff, tests, evidence, specification alignment, and issue acceptance criteria.

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
- A Worker remains active until its pull request is merged, the issue is closed, or the Project Owner cancels the work.
- Cancelled or superseded work is stopped and documented before its Worker is archived.
- Main-branch truth is never inferred from a Worker report; the Manager verifies the remote repository state.
