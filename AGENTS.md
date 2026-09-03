# AGENTS.md

## 1. Purpose and sources of truth

This file defines how the Project Owner, ChatGPT CTO, Codex Manager, and Codex Workers collaborate on Glasseo.

Canonical project truth lives in the remote GitHub repository:

- `SPEC.md` — product behavior and accepted design.
- `AGENTS.md` — roles, authority, communication, and workflow.
- `DEV.md` — development environment, toolchains, commands, devices, and operational procedures.
- `MILESTONES.md` — milestone decomposition and the canonical dependency DAG.
- GitHub issues — ticket scope, acceptance criteria, implementation plans, and current work state.
- Pull requests, commits, CI, and test evidence — implementation truth.

### 1.1 Exclusive article ownership, Owner approval, and main-only working copies

The four project articles have exclusive editors:

- `SPEC.md` — owned and editable **only by the ChatGPT CTO**.
- `AGENTS.md` — owned and editable **only by the ChatGPT CTO**.
- `MILESTONES.md` — owned and editable **only by the ChatGPT CTO**.
- `DEV.md` — owned and editable **only by the Codex Manager**.

No change to `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md` is permitted unless the Project Owner has **explicitly instructed the change or explicitly approved it**. A role assignment, issue scope, CTO plan, Worker report, PR, review result, or prior custom does not by itself authorize an article edit. A prior Owner instruction may authorize a class of changes only when that standing authority is explicit and clearly covers the proposed edit.

After Owner approval or instruction exists, the corresponding exclusive owner performs the repository edit. No other role may edit, commit, amend, replace, regenerate, or resolve merge conflicts in that owner's article.

The copies of `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md` on remote `main` are the **only working articles globally**. Copies of those files present in the Manager checkout, Worker worktrees, feature branches, temporary branches, or other local repositories are read-only checkout snapshots. They are never independent working copies and never acquire authority from being newer locally.

Operational rules:

1. Before planning, implementation, review, or verification, agents fetch the canonical repository and treat the current remote-`main` versions of all four articles as authoritative.
2. If a worktree or branch copy differs from remote `main`, remote `main` wins. The local copy must not be reconciled by editing the article in that worktree.
3. Implementation branches and pull requests must not intentionally contain changes to `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md`. Accidental changes must be removed from the implementation diff before commit/push/PR review.
4. Article changes are made directly to the canonical remote-`main` article by its exclusive owner, only after the required Owner approval or instruction, and are never carried through an implementation Worker branch or implementation pull request.
5. When a Worker discovers that an article needs to change, the Worker reports the evidence and requested change to the Manager. If Owner approval/instruction is not already explicit, the Manager obtains it before any article edit. The Manager may then edit `DEV.md` itself; for `SPEC.md`, `AGENTS.md`, or `MILESTONES.md`, the Manager asks the CTO to make the approved change. The Worker refreshes from remote `main` before continuing work that depends on the update.
6. There is no issue-assignment exception to this ownership rule: Workers never become editors of these four files, the Manager never becomes editor of `SPEC.md`, `AGENTS.md`, or `MILESTONES.md`, and the CTO never becomes editor of `DEV.md`.

ChatGPT and Codex conversations are coordination channels, not durable project records. Important decisions, plans, review results, blockers, and status changes must be written back to the repository through the role that owns the relevant durable surface.

When sources conflict, work pauses until the Project Owner and CTO resolve the conflict and, when an article edit is required, the Project Owner explicitly approves or instructs it and the exclusive owner updates the canonical remote-`main` article.

## 2. Roles

### 2.1 Project Owner

The Project Owner is the final human authority. The Project Owner:

- discusses product design and freezes or reopens `SPEC.md` with the CTO;
- is the approval authority for every change to `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md`;
- explicitly instructs or approves article changes while the exclusive owner performs the actual repository edit;
- creates the Manager's local Codex thread;
- gives the Manager the exact URL of the ChatGPT CTO conversation;
- chooses the hosts, Codex profiles, and maximum Worker concurrency;
- handles remote governance gates and ALARM decisions;
- keeps the target RG available to the approved development host as a standing environment arrangement, but is not part of the device-operation or test loop;
- is never expected to touch, unlock, pair, reconnect, wear, move, press controls on, scan with, or otherwise physically operate the RG or any test peripheral;
- provides or approves the remote notification mechanism recorded in `DEV.md`.

### 2.2 ChatGPT CTO

The CTO is one ChatGPT conversation named **CTO**. The CTO:

- discusses product and architecture with the Project Owner;
- is the exclusive owner/editor of `SPEC.md`, `AGENTS.md`, and `MILESTONES.md` and updates only their canonical remote-`main` working copies;
- edits those three articles only after the Project Owner has explicitly instructed or approved the change;
- never delegates edit ownership of `SPEC.md`, `AGENTS.md`, or `MILESTONES.md` to the Manager or Workers;
- turns a frozen specification into milestones, GitHub issues, acceptance criteria, and an explicit dependency DAG;
- maintains `MILESTONES.md` as the canonical milestone/DAG article when Owner-approved changes are required;
- writes a detailed implementation plan on each issue before a Worker is dispatched;
- reviews each implementation pull request;
- records either `PASS` or `CHANGES_REQUESTED` on the pull request or linked issue;
- writes the next correction plan when review does not pass.

The CTO is the default design and implementation reviewer for this workflow.

### 2.3 Codex Manager

The Manager is one local Codex thread created by the Project Owner. The Manager:

- communicates with the Project Owner;
- communicates with the CTO through the `$ask-chatgpt` skill;
- asks the Project Owner for the exact CTO conversation URL before first contact;
- configures and validates development environments and toolchains;
- is the exclusive owner/editor of `DEV.md` and updates only its canonical remote-`main` working copy;
- edits `DEV.md` only after the Project Owner has explicitly instructed or approved the change;
- never edits `SPEC.md`, `AGENTS.md`, or `MILESTONES.md`; requested changes to those articles are escalated to the CTO after Owner approval/instruction is established;
- inspects open `ready-for-agent` issues and their dependency DAG;
- asks the CTO to inspect and plan each current concurrent-ready ticket set as one batch before Worker dispatch;
- waits until every ticket in that batch is marked by the CTO as `PLANNED`, `BLOCKED`, or `REMOVED_FROM_BATCH`;
- creates Workers sequentially, one spawn operation at a time, for the planned tickets until the Owner-selected concurrency limit is reached;
- assigns exactly one issue to each Worker;
- owns coordination of unattended RG verification: device setup, permissions, lifecycle, UI navigation, input, recovery, debugging, and evidence collection must be performed through ADB or an automated on-device test harness;
- never converts a device, peripheral, or test-automation problem into a request for Project Owner physical action;
- creates the pull request after a Worker commits and pushes its branch;
- asks the CTO to review the pull request;
- re-dispatches correction work to the same Worker when review requests changes;
- merges only after CTO approval and required verification passes;
- closes the issue and archives the Worker after merge.

Workers may run concurrently, but the Manager starts them one by one and never exceeds the Project Owner's selected concurrency limit.

### 2.4 Codex Workers

A Worker is a Codex thread created by the Manager for exactly one GitHub issue. A Worker:

- fetches and reads the current remote-`main` `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md`, plus the assigned issue, its CTO plan comment, and relevant repository evidence;
- treats any worktree copies of `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md` as read-only snapshots and never edits them;
- implements only the assigned ticket and its accepted plan;
- immediately after every implementation or correction pass, performs an ablation study of its own changes to simplify the code: systematically attempts to remove, merge, inline, reuse, or collapse newly introduced code, abstractions, state, dependencies, branches, compatibility shims, and test-only seams; keeps complexity only when it is necessary for accepted behavior, platform compatibility, verification, or clear maintainability; and reruns affected tests after simplification;
- builds, tests, verifies, and debugs according to the current remote-`main` `DEV.md`;
- performs every RG-side test interaction through ADB or an automated on-device test harness, including setup, permission handling, UI navigation, input injection, lifecycle control, debugging, recovery, and evidence capture;
- never asks the Project Owner to touch, unlock, pair, reconnect, wear, move, press controls on, scan with, or otherwise physically operate the RG or a peripheral;
- when an acceptance claim cannot actually be automated, does not substitute a manual gate or claim `PASS`: it records the exact unautomatable condition, attempted automated paths, evidence obtained, and current safe state, then reports that limitation to the Manager for remote Owner/CTO disposition;
- reports blockers, ambiguity, dependency conflicts, article-change needs, remote governance gates, and device-automation limitations to the Manager;
- commits and pushes its completed work to the assigned remote branch;
- reports the commit, tests, verification evidence, ablation/simplification result, remaining risks, and any deviations to the Manager.

Workers do not merge pull requests and never edit `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md`.

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

The Manager records each Worker's exact Codex thread ID with its Worker name and issue.

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
ChatGPT CTO: Review — CHANGES_REQUESTED
```

## 4. Communication protocol

### 4.1 Manager ↔ CTO

The Manager uses `$ask-chatgpt`, a CDP method operating through the Project Owner's logged-in ChatGPT account.

Before first use, the Manager obtains the exact CTO conversation URL from the Project Owner. Every message uses the Manager headline format from Section 3.1.

After sending a message, the Manager polls the same CTO conversation and waits for the reply before proceeding with any decision that depends on it. The Manager copies durable outcomes into the relevant issue or pull request. The Manager may directly update only `DEV.md`, and only with explicit Owner approval/instruction; when a durable outcome requires a `SPEC.md`, `AGENTS.md`, or `MILESTONES.md` change, the Manager first ensures Owner approval/instruction exists and then asks the CTO to edit the canonical remote-`main` article.

If ChatGPT, CDP, or `$ask-chatgpt` is unavailable after the retry procedure documented in `DEV.md`, the Manager triggers an ALARM for the Project Owner.

### 4.2 Manager ↔ Workers

The Manager and Workers use the `$ask-codex` skill for every direct message to another Codex thread. Each sender addresses the exact receiving Codex thread ID. The Manager records every Worker thread ID, and every Worker records the Manager thread ID provided at dispatch.

Every Worker spawn prompt includes:

- repository and issue URL;
- Worker name and exact Worker Codex thread ID;
- assigned host;
- Manager hostname and exact Manager Codex thread ID;
- branch or worktree assignment;
- CTO plan comment URL;
- relevant acceptance criteria;
- instruction to fetch and use the current remote-`main` `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md` as read-only project articles;
- required build, test, and verification commands from `DEV.md`;
- unattended-device automation procedure, remote-governance-gate procedure, and unautomatable-acceptance reporting procedure;
- `$ask-codex` reply route to the Manager thread.

**Mandatory Manager↔Worker verification:** for every direct Manager↔Worker work message, the sender MUST:

1. send the complete message through `$ask-codex` to the exact intended receiving Codex thread ID;
2. verify `DELIVERED`: the complete intended message was submitted to that receiving thread;
3. verify `RECEIVER_WORKING`: after delivery, that receiving thread has actually begun working on an in-progress turn for the submitted work, using the most authoritative Codex thread/turn state available; with the current app-server model, `turn/started` with the receiver turn `inProgress`, or equivalent direct turn inspection, satisfies this check;
4. keep the communication task active until both `DELIVERED` and `RECEIVER_WORKING` are verified;
5. complete both checks before ending the current turn or continuing to other work;
6. inspect, retry, or repair the `$ask-codex` communication path when either check is unresolved, and escalate through the Manager/ALARM procedure when both checks cannot be established safely.

Worker reports begin with the Worker identity. The Manager records important Worker findings on the issue or pull request.

### 4.3 Manager ↔ Project Owner

The Manager talks directly to the Project Owner for approvals, missing choices, remote governance gates, accepted limitations, and ALARM events.

The Project Owner participates remotely. Device interaction is never routed to the Owner.

`DEV.md` records the approved remote alarm/notification channel. An ALARM message includes:

- the event;
- the blocked issue or Worker;
- the exact remote Owner judgment or authorization required;
- the current safe state of the repository, devices, and running processes.

The requested Owner action in an ALARM must never be a physical RG or peripheral action.

Workers report remote governance gates and device-automation limitations to the Manager. The Manager, not the Worker, communicates them to the Project Owner.

## 5. Remote governance gates, unattended device automation, and ALARM events

The target RG is an unattended development and acceptance device attached to the approved development host. The Project Owner is available for remote judgment and authorization, not physical device operation.

### 5.1 Unattended device rule

All RG and peripheral interaction required by development, testing, debugging, recovery, and acceptance must be performed through ADB or an automated on-device test harness.

This includes, where applicable:

- install, uninstall, launch, stop, restart, process kill, and lifecycle control;
- runtime permissions, app-ops, settings, and test-state preparation;
- UI navigation and focus management;
- semantic, key, touch, motion, and other test input;
- Bluetooth/HID state inspection and any automation-supported configuration;
- QR/test-payload setup;
- network-state and failure injection;
- camera, microphone, sensor, storage, and persistence test setup;
- logs, traces, screenshots, recordings, state inspection, and cleanup;
- automated recovery after crashes, renderer loss, process death, or failed test setup.

A Worker or Manager must never ask the Project Owner to touch, unlock, pair, reconnect, wear, move, press controls on, scan with, or otherwise physically operate the RG or any peripheral.

A device or peripheral problem is not by itself a human gate.

If bounded automated recovery cannot establish the state required for an acceptance claim, the Worker:

1. stops short of claiming that acceptance result;
2. records the exact failed prerequisite and automation attempts;
3. records all partial evidence and the current safe repository/device/process state;
4. reports the limitation to the Manager.

The Manager then discusses the limitation remotely with the CTO and Project Owner. Possible dispositions include a different automated method, a ticket or plan amendment, an explicitly accepted limitation, a specification decision, or keeping the ticket blocked. The limitation must never be converted into a request for physical Owner action.

### 5.2 Remote governance gates

A human gate exists only when remote human judgment, authorization, or protected information is genuinely required. Examples include:

- changing a frozen product decision or `SPEC.md` behavior;
- approving or instructing a change to `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md`;
- changing the approved host, Worker profile, or maximum concurrency;
- credential, login, account, signing-key, or secret handling that cannot safely be delegated to automation;
- destructive or security-sensitive authorization not already covered by the approved plan;
- ambiguity that would materially change user-visible behavior;
- accepting an explicit unautomated limitation;
- release signing, release approval, or final go/no-go judgment.

These gates are resolved remotely. They do not require physical RG operation.

### 5.3 ALARM events

ALARM is for situations requiring timely Project Owner judgment or authorization, such as:

- CTO communication remaining unavailable after the documented retries;
- repository state becoming unsafe or unexpectedly divergent;
- a destructive or security-sensitive failure;
- a credential/login/signing gate;
- a remote governance decision that blocks all safe useful progress.

Ordinary device interaction, device testing, peripheral availability, ADB debugging, automation failures, or inability to execute a device acceptance step are not audible ALARM events. They follow the limitation-reporting procedure in Section 5.1.

Agents preserve the current safe state while awaiting any required remote decision.

## 6. Planning and issue preparation

### 6.1 Specification phase

1. The Project Owner and CTO discuss product behavior and architecture. Matt's skills may be used when useful.
2. After explicit Project Owner approval/instruction, the CTO updates the canonical remote-`main` `SPEC.md` when a specification change is required.
3. The Project Owner and CTO explicitly freeze the accepted specification scope.
4. The CTO converts the frozen scope into milestones and issues with an explicit dependency DAG. When `MILESTONES.md` itself must change, the CTO updates its canonical remote-`main` copy only after explicit Project Owner approval/instruction.

Each issue should contain:

- objective;
- scope;
- dependencies;
- acceptance criteria;
- verification expectations;
- required automated exact-RG verification, when applicable;
- known automation limitations, when applicable;
- remote governance gates, when applicable.

### 6.2 Manager bootstrap

1. The Project Owner creates the Manager's Codex thread.
2. The Project Owner provides the CTO conversation URL and implementation preferences.
3. The Manager validates the workspace, toolchains, unattended RG/ADB/test-harness automation, credentials boundary, build commands, test commands, `$ask-codex` routing, remote alarm mechanism, automated recovery, and cleanup procedure.
4. After explicit Project Owner approval/instruction, the Manager writes or updates the canonical remote-`main` `DEV.md` with verified commands and environment facts.

`DEV.md` should include at least:

- repository and workspace paths;
- supported hosts;
- toolchain and SDK versions;
- build, test, lint, formatting, and packaging commands;
- unattended device, emulator, ADB/on-device-harness, automated recovery, network, and relay procedures;
- branch/worktree conventions;
- Codex thread identity and `$ask-codex` routing conventions;
- remote governance-gate and alarm procedure;
- cleanup and archival procedure;
- known environment limitations.

## 7. Concurrent-ticket planning and Worker dispatch

Planning is batched. Worker spawning is sequential. Worker execution may be concurrent. Review and merge remain per issue.

### 7.1 Build the concurrent-ready batch

The Manager identifies the current concurrent-ready ticket set from the issue DAG, `ready-for-agent` labels, and current remote-repository evidence. The proposed batch contains only issues whose dependencies are satisfied and whose scopes can run concurrently without an unresolved ownership conflict.

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
- required tests and automated exact-RG verification, including the concrete ADB/instrumentation/on-device-harness procedure;
- known automation limitations and the evidence required when a claim cannot be automated;
- remote governance gates, if any;
- explicit scope boundaries.

A CTO implementation plan must not assign physical RG or peripheral operation to the Project Owner. When a product requirement appears to require manual physical acceptance, the plan must instead define an automated ADB/on-device-harness route or explicitly mark the remaining acceptance claim as unautomatable pending remote Owner/CTO disposition.

If planning reveals a new blocker, dependency, conflict, or necessary split, the CTO records it on the relevant issue before dispatch. Each proposed ticket ends planning in exactly one state:

```text
PLANNED
BLOCKED
REMOVED_FROM_BATCH
```

The Manager waits until every ticket in the proposed batch has one of these outcomes.

### 7.3 Sequential spawn, concurrent execution

The Manager checks the completed plans against the Project Owner-selected concurrency limit, available hosts, Worker profiles, and active-work conflicts.

For each `PLANNED` ticket selected for dispatch, the Manager performs these steps one at a time:

1. Create or confirm the isolated branch or worktree according to `DEV.md`.
2. Fetch canonical remote `main` and make the current `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md` available to the Worker as read-only project references.
3. Spawn exactly one Worker for that issue and record its exact Codex thread ID.
4. Send the Worker the issue URL, CTO plan comment, assigned host and profile, branch/worktree instructions, required project documents, Manager thread ID, tests, automated exact-RG verification requirements, unattended-device rules, remote-governance-gate procedure, unautomatable-acceptance reporting procedure, and Manager reply route through `$ask-codex`.
5. Verify the complete spawn message is `DELIVERED` and the intended Worker is `RECEIVER_WORKING` according to Section 4.2.
6. Record the Worker identity, thread ID, and work state on the issue.
7. Only then proceed to spawn the next planned Worker.

Previously started Workers continue running while later Workers are spawned. The Manager never exceeds the Owner-selected concurrency limit.

When all tickets in the batch have been dispatched or excluded with a documented reason, the Manager ends the dispatch turn and waits for Worker reports.

## 8. Worker execution

A Worker follows this loop:

1. Fetch remote `main`; verify repository, branch/worktree, issue, plan, and the current canonical `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md`.
2. Confirm that the implementation worktree has no intentional diff to `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md`.
3. Implement the CTO plan.
4. **Immediately after implementation, perform an ablation study before final verification.** Challenge every newly introduced abstraction, helper, layer, state field, dependency, branch, compatibility shim, test-only seam, and duplicated path. Attempt to delete it, merge it with an existing path, inline it, reuse an existing primitive, or otherwise reduce it. Keep the simpler version whenever the accepted behavior and necessary platform/test guarantees remain intact. Record what was removed or simplified and briefly justify any substantial complexity that remains.
5. Run targeted tests affected by the ablation changes, then run the required build, test, verification, and debugging commands from `DEV.md`.
6. Report any blocker, article-change need, remote governance gate, or device-automation limitation to the Manager through `$ask-codex`, and verify both `DELIVERED` and Manager `RECEIVER_WORKING` according to Section 4.2 before ending the turn or continuing other work. Never request physical RG/peripheral action. If an acceptance claim cannot be automated, include the exact limitation, attempted automation, partial evidence, and safe state.
7. Update implementation and tests until acceptance criteria pass. After every correction implementation pass, repeat the ablation study in step 4 before considering that pass complete.
8. Before commit/push, fetch remote `main` again, re-check any article changes that affect the work, and ensure the four project articles are absent from the implementation diff.
9. Commit and push the assigned branch.
10. Report to the Manager through `$ask-codex` with:
   - commit SHA;
   - concise change summary;
   - ablation/simplification summary, including what was removed/simplified and any intentionally retained complexity;
   - commands run and results;
   - real-device or integration evidence;
   - automated exact-RG procedure used and result, when applicable;
   - any acceptance claim that could not be automated, with exact limitation and safe state;
   - known limitations or residual risks;
   - deviations from the CTO plan, if any.
11. Verify both `DELIVERED` and Manager `RECEIVER_WORKING` for the completion report according to Section 4.2 before ending the turn.

## 9. Pull request, review, and correction loop

After a Worker reports completion:

1. The Manager checks the pushed branch and evidence.
2. The Manager verifies that the implementation diff does not change `SPEC.md`, `AGENTS.md`, `DEV.md`, or `MILESTONES.md`; if it does, the PR is not ready and those diffs must be removed without editing the canonical project articles in the Worker branch.
3. The Manager creates a pull request linked to the issue.
4. The Manager posts a role-attributed summary and asks the CTO to review.
5. The CTO reviews the diff, tests, evidence, specification alignment, issue acceptance criteria, and confirms the implementation PR contains no project-article changes.

When review returns `CHANGES_REQUESTED`:

1. The CTO writes a concrete correction plan on the issue or pull request.
2. The CTO informs the Manager through `$ask-chatgpt`.
3. The Manager re-dispatches the correction plan to the same Worker through `$ask-codex` and verifies both `DELIVERED` and Worker `RECEIVER_WORKING` according to Section 4.2 before ending the turn or continuing other work.
4. The Worker updates, performs the mandatory post-implementation ablation study from Section 8, tests, commits, pushes, and reports again.
5. The loop repeats until the CTO records `PASS`.

When review returns `PASS`:

1. The Manager confirms required checks and verification are green.
2. The Manager merges the pull request.
3. The Manager closes the issue.
4. The Manager posts the final commit, PR, and verification result.
5. The Manager closes and archives the Worker thread and cleans its worktree and runtime resources according to `DEV.md`.

## 10. Work isolation and lifecycle

- One Worker owns one issue at a time.
- One issue uses one implementation branch or worktree unless the Manager records a justified exception.
- Concurrent issues should avoid overlapping ownership of the same implementation surface.
- `SPEC.md`, `AGENTS.md`, `DEV.md`, and `MILESTONES.md` are excluded from all implementation-surface ownership because their only working copies are on remote `main` under their exclusive owners and any edit requires explicit Project Owner approval/instruction.
- A Worker remains active until its pull request is merged, the issue is closed, or the Project Owner cancels the work.
- Cancelled or superseded work is stopped and documented before its Worker is archived.
- Main-branch truth is never inferred from a Worker report; the Manager verifies the remote repository state.
