# Glasseo Specification

## 1. Product

Glasseo is a standalone Android client for Rokid glasses with a 480×640 HUD. It connects to existing Paseo daemons through Paseo Relay and provides a glasses-first interface for reading and interacting with existing Paseo agents.

Glasseo is intentionally focused: projects, workspaces, and agents are created and managed by ordinary Paseo clients; Glasseo discovers and uses that existing host state.

Target integration: current Paseo 0.7.x protocol and Paseo Relay. Glasseo follows Paseo's existing client/server and security behavior.

### 1.1 Authoritative Rokid Glasses sources

Glasseo targets the consumer Rokid Glasses / RG / `glasses` device family running YodaOS-Sprite. The following URLs are pinned as the primary Rokid sources for device, SDK, user-control, and hardware-integration evidence:

- Rokid Open Platform — canonical developer entry for YodaOS-Sprite, CXR-S, and Rokid Glasses bare-metal development:
  `https://open.rokid.com/?lang=cn`
- Official CXR-S glasses-side SDK documentation for standalone applications running on YodaOS-Sprite:
  `https://custom.rokid.com/prod/rokid_web/57e35cd3ae294d16b1b8fc8dcbb1b7c7/pc/us/3fe1c87b945245bf8b6c50393f4da7b6.html`
- Official Rokid Maven repository for published Android/CXR SDK artifacts:
  `https://maven.rokid.com/repository/maven-public/`
- Official consumer Rokid Glasses FAQ, including current two-finger display-off and volume gestures:
  `https://global.rokid.com/pages/faq`
- Official Rokid Glasses Academy index:
  `https://global.rokid.com/blogs/academy-glasses`
- Official Rokid Glasses button and touch-control guide:
  `https://global.rokid.com/blogs/academy-glasses/2-3-button-touch-controls`
- Official Rokid Glasses AI-assistant guide, including touch and configurable two-finger interaction behavior:
  `https://global.rokid.com/blogs/academy-glasses/3-4-other-ai-features`

The Open Platform URL is the canonical directory when a deep `custom.rokid.com` document ID changes. Glass3, Sprite Enterprise, Rokid AR-series, or other Rokid product-family documentation is not authoritative for Glasseo's RG input behavior unless equivalence is proven on the target firmware.

### 1.2 Canonical controls and physical input sources

Glasseo has exactly seven semantic controls:

```text
PRIMARY
SECONDARY
COMMAND
LEFT
RIGHT
UP
DOWN
```

The intended built-in Rokid Glasses physical mappings are fixed and are not user-remappable:

| Glasseo control | Intended built-in Rokid Glasses operation |
|---|---|
| `PRIMARY` | one-finger tap/touch on the touchpad |
| `SECONDARY` | two-finger tap/touch on the touchpad |
| `COMMAND` | physical/function button |
| `UP` | one-finger swipe touchpad backward |
| `DOWN` | one-finger swipe touchpad forward |
| `LEFT` | two-finger swipe touchpad backward |
| `RIGHT` | two-finger swipe touchpad forward |

These are product-level physical bindings, not claims about specific Android keycodes. Glasseo targets the consumer Rokid RG / `glasses` firmware family; Glass3, Sprite Enterprise, or other Rokid product documentation must not be used as authoritative evidence for these mappings unless equivalence is proven on the target firmware.

Issue #3 must qualify every built-in operation on the exact target RG firmware at three layers:

1. raw Linux input (`getevent`) to identify the physical event stream;
2. foreground Android delivery (`dispatchKeyEvent`/equivalent) while Glasseo consumes the event;
3. YodaOS system handling, including any app-visible ordered broadcasts or officially supported interception channel, to determine whether conflicting native behavior can be suppressed safely.

Each built-in semantic control must end #3 in one of these capability states:

```text
AVAILABLE_SAFE
AVAILABLE_WITH_SUPPRESSION
UNAVAILABLE_BUILTIN
```

A built-in mapping is usable only when Glasseo can recognize the intended physical operation deterministically and prevent an unacceptable conflicting native action. If YodaOS consumes a gesture before an ordinary app can use it, or its native action cannot be safely suppressed, that semantic control is marked `UNAVAILABLE_BUILTIN`. Glasseo must not silently substitute a different built-in gesture.

The built-in RG input surface is therefore allowed to expose only a safe subset of the seven semantic controls on firmware where full exclusivity is impossible.

Bluetooth HID is the full-control fallback and an additional input source. Issue #3 must also pair and qualify a real Bluetooth HID device on the target glasses and prove that seven distinct HID inputs can be mapped to all seven Glasseo semantic controls, including reliable down/up timing for the short/long/double classifications used by Glasseo. If the built-in RG surface is incomplete, a qualified HID mapping must still provide the complete seven-control interaction model.

Built-in and HID sources may operate together. Physical events from either source are normalized into the same semantic-control state machine, and one physical operation must produce exactly one Glasseo interaction. Source disconnect, focus loss, or cancellation must not synthesize an action.

## 2. Paseo model

Glasseo uses Paseo's own hierarchy and terminology:

```text
Host
└── Project
    └── Workspace
        └── Agent
            └── Timeline
```

A host is identified by `serverId`. An agent page is identified by `(serverId, agentId)`.

Glasseo connects concurrently to all paired hosts, fetches their project/workspace/agent directories, and builds one Agent page for every eligible agent.

Eligible agents are all non-archived, non-internal agents, including resumable `closed` agents. Pages are ordered globally by Paseo directory recency (`updated_at` descending) across all connected hosts. Refreshing the directory preserves the currently viewed `(serverId, agentId)` when it still exists.

Startup restores the last viewed Agent when it still exists; otherwise it opens the most recent Agent. When no eligible Agent exists, Glasseo opens Config.

## 3. Top-level navigation

Glasseo has two top-level destinations:

```text
Agent pages
└── Timeline ↔ Draft

Config
```

Each Agent page defaults to Timeline.

### Timeline

- `LEFT` — previous Agent page.
- `RIGHT` — next Agent page.
- single `COMMAND` — open this Agent's Draft.
- long `COMMAND` — open Config.

Agent page navigation wraps at both ends.

### Draft

- single `COMMAND` in Draft Edit mode — return to the same Agent Timeline.
- `LEFT` / `RIGHT` in Draft Edit mode — cycle Draft areas.

### Config

- single `COMMAND` — return to the exact Agent Timeline that opened Config.
- if Config was opened because no Agent exists, single `COMMAND` has no destination until an Agent is available or selected.

## 4. Agent Timeline

Timeline is a read-only view of the selected Paseo Agent.

### Header

Line 1:

```text
hostname · project / [workspace /] agent
```

The workspace segment may be omitted when it adds no useful distinction.

Line 2 shows available runtime metadata compactly:

```text
model · effort · permission · usage
```

Fields are shown only when available from Paseo/provider state. `effort` maps to the provider's thinking/reasoning option. Usage uses Paseo provider usage windows, such as weekly remaining percentage.

### Timeline body

The remaining HUD is the agent timeline.

Glasseo follows Paseo's timeline model:

- bootstrap from the latest projected timeline tail;
- receive live updates through `agent_stream`;
- load older projected pages when the user reaches the history start;
- reconcile gaps and reconnects using authoritative timeline fetches;
- preserve the viewport while the user is reading history.

### Timeline controls

| Control | Action |
|---|---|
| `LEFT` | previous Agent |
| `RIGHT` | next Agent |
| `UP` | scroll upward; hold for continuous scrolling |
| `DOWN` | scroll downward; hold for continuous scrolling |
| single `PRIMARY` | toggle following live output |
| long `PRIMARY` | jump to latest content and follow |
| single `SECONDARY` | no action |
| double `SECONDARY` | hide HUD |
| single `COMMAND` | open Draft |
| long `COMMAND` | open Config |

When the HUD is hidden, the next recognized control wakes it and is consumed.

## 5. Draft

Each Agent owns an independent local Draft. Draft content is client-side Glasseo state and is submitted through ordinary Paseo operations.

The Draft contains up to three vertically arranged editable areas:

1. **Request** — present only when the Agent has an actionable Paseo permission/question request.
2. **Text** — always present.
3. **Images** — present only when one or more images are attached.

`LEFT` and `RIGHT` cycle through the currently available areas. `UP` and `DOWN` move only inside the active area and stop at that area's boundaries. Each area remembers its own cursor.

The default Draft state is **Edit mode**.

### 5.1 Draft units and cursor

The cursor is a thin box around the active Draft unit.

Draft units are:

- Request: one selectable request option/action or editable request field unit;
- Text: Vim-like word/punctuation units;
- Images: one attached image.

### 5.2 Request area

Paseo pending permission/question requests are rendered as structured controls.

- `UP` / `DOWN` — move among request units.
- single `PRIMARY` on an option — select/cancel it according to the request's single- or multi-select semantics.
- selected options are highlighted.
- free-text request fields, when present, remain inside the Request area and use text-like editing.

Local request answers are keyed by the Paseo request ID and are discarded when that request is no longer pending.

While an actionable request is pending, the action-wheel down action is `Respond` only when the required response is complete; otherwise it is disabled.

### 5.3 Text area

Text is tokenized into words and punctuation units.

- `UP` / `DOWN` — previous/next text unit, analogous to Vim `b` / `w` movement.
- single `PRIMARY` — start selection at the current unit. The thin cursor becomes a shallow filled selection block.
- while selecting, `UP` / `DOWN` expand or contract selection.
- single `PRIMARY` while selecting — copy selection and leave selection.
- single `SECONDARY` while selecting — cut selection and leave selection.
- single `SECONDARY` without selection — delete the current unit using `dw`-like semantics.

Voice and Morse can be entered only while Text is the active Draft area.

### 5.4 Images area

- `UP` / `DOWN` — move among attached images.
- single `PRIMARY` — select/cancel the current image.
- selected images are highlighted.
- if one or more images are selected, single `SECONDARY` deletes them immediately.
- leaving the Images area clears image selection.

The Images area does not exist while the Draft contains no images. Photo remains available from the action wheel; the first captured image creates the Images area.

## 6. Draft action wheel

Long `COMMAND` in Draft Edit mode opens a four-direction head-posture action wheel:

```text
                 Photo

        Voice             Morse

      Respond / Send / Steer / Interrupt
```

- head-up — Photo.
- head-left — Voice; enabled only when Text is active.
- head-right — Morse; enabled only when Text is active.
- head-down — contextual primary agent action.

The down action is resolved from the latest Paseo Agent/request state:

| State | Action |
|---|---|
| actionable request + complete response | `Respond` |
| actionable request + incomplete response | disabled |
| Agent `running` + non-empty Draft | `Steer` |
| Agent `running` + empty Draft | `Interrupt` |
| Agent `idle` or resumable `closed` + non-empty Draft | `Send` |
| Agent idle + empty Draft | disabled |

A request takes priority over ordinary Send/Steer/Interrupt until it is resolved.

The wheel does not reinterpret an action after opening: if the latest local Agent/request state makes the displayed action invalid before release, the selection is cancelled.

### Action results

- successful `Respond`, `Send`, or `Steer` clears the submitted local content and returns to Timeline;
- failed/rejected operations retain the Draft and remain in Draft;
- `Interrupt` returns to Timeline without changing the Draft;
- while submission is unresolved, Draft editing is temporarily locked and a compact pending state is shown.

## 7. Photo mode

Photo replaces the HUD with the camera preview.

| Control | Action |
|---|---|
| `LEFT` | zoom out |
| `RIGHT` | zoom in |
| single `PRIMARY` | capture photo |
| single `COMMAND` | exit immediately to Draft Edit |

Multiple photos may be captured in one Photo session. Each successful capture is stored locally and appended to the Draft image attachments. No separate server-side photo staging layer is used.

On Send/Steer, Glasseo submits Draft text plus encoded images using Paseo's existing message shape. Generic file attachments are outside the initial Glasseo scope.

## 8. Voice mode

Voice can be entered only when Text is active.

Glasseo uses Paseo's existing dictation stream protocol. The provisional transcript is displayed immediately before the original cursor position and surrounded by an expanded thin cursor box, representing one uncommitted unit.

| Control | Action |
|---|---|
| single `PRIMARY` | finish current dictation; commit final transcript into local Draft; begin a new provisional slice |
| single `SECONDARY` | discard current provisional transcript and begin a new slice |
| single `COMMAND` | exit to Draft Edit and discard the current provisional transcript |

Committed transcript text becomes ordinary Draft text. Provisional transcript text is not part of the persisted Draft.

## 9. Morse mode

Morse can be entered only when Text is active.

Morse inserts at the original Text cursor position. An uncommitted letter buffer is displayed inside an expanded thin cursor. The current dot/dash buffer appears at the tail of that buffer until it decodes to a character or is rejected.

### Timing

Morse uses standard relative timing with base unit `T`:

- dot press: less than `2T`;
- dash press: at least `2T`;
- character boundary: `3T` silence;
- word/draft-unit commit: `7T` silence.

Initial target: `T = 200 ms`; the value may be tuned from real-device testing without changing the state model.

### Controls

- short `PRIMARY` — dot.
- long `PRIMARY` — dash.
- single `SECONDARY`:
  1. clear the current dot/dash buffer when non-empty;
  2. otherwise delete the latest uncommitted letter when the letter buffer is non-empty;
  3. otherwise perform normal `dw` deletion on the current Text unit.
- single `COMMAND` — exit to Draft Edit and discard uncommitted Morse state.

After `7T` silence, the current decoded letter/word buffer is committed to the Draft and a new Draft unit begins.

### Completion

When the buffered word reaches at least four letters, Glasseo performs local deterministic completion from a basic dictionary and shows candidates below the buffer.

- `DOWN` clears any current dot/dash buffer and enters candidate selection.
- repeated `DOWN` moves to the next candidate without wrapping.
- `UP` leaves candidate selection and returns to the letter buffer.
- single `PRIMARY` commits the selected candidate and returns to Morse typing at the next insertion position.

Completion is local and does not use an LLM.

## 10. Config

Config is opened by long `COMMAND` from Timeline. It is a vertically navigated list with three top-level sections:

1. Workspaces
2. Hosts
3. HID Keys

`UP` / `DOWN` move the Config cursor. single `PRIMARY` activates the current row. single `COMMAND` returns to the Timeline that opened Config.

### 10.1 Workspaces

Workspaces mirrors existing state from all currently connected Paseo hosts:

```text
Host
└── Project
    └── Workspace
        └── Agent
```

Rows are foldable. A redundant Workspace level may be collapsed when a Project has only one ordinary workspace.

Single `PRIMARY` on an Agent immediately opens that Agent's Timeline.

Glasseo does not need project/workspace/agent creation for this flow; the list is populated from Paseo `projects.list`, `workspaces.list`, and `agents.list`/directory updates.

### 10.2 Hosts

Hosts shows every paired host plus:

```text
+ Add new host
```

Single `PRIMARY` on a host expands/collapses its details.

`+ Add new host` opens the camera QR scanner. QR scanning is the host-add flow. Glasseo accepts the standard Paseo relay connection offer containing `serverId`, daemon public key, relay endpoint, and TLS setting, then connects through Paseo Relay using Paseo's existing E2EE protocol.

All paired hosts may remain connected concurrently.

Removing a host removes its local connection profile and immediately cleans all host-scoped Glasseo state, including its Agent pages, cached directory/timeline data, Drafts, and captured Draft images.

### 10.3 HID Keys

HID Keys configures Bluetooth HID key events as mappings to Glasseo's seven semantic controls:

```text
PRIMARY
SECONDARY
COMMAND
LEFT
RIGHT
UP
DOWN
```

Issue #3 establishes that the target glasses and at least one real Bluetooth HID device can deliver seven distinct usable HID inputs and that those inputs can drive the complete semantic-control state machine. This section does not own basic HID feasibility.

Single `PRIMARY` on a semantic-control row starts capture; the next eligible HID key event becomes that control's HID binding. One physical HID key maps to one Glasseo control and duplicate HID bindings are rejected. A reset action clears HID bindings.

Supported built-in Rokid mappings from Section 1.2 remain fixed and cannot be remapped in Config. HID mappings coexist with the built-in safe subset and may provide any semantic controls that are unavailable from the built-in RG input surface. Physical events from either source are first mapped to the seven semantic controls; short/long/double classification happens after mapping.

## 11. Local state and recovery

Glasseo persists local UI/input state independently for each `(serverId, agentId)`:

- unsent text Draft;
- attached Draft images;
- active Draft area;
- per-area cursor positions;
- request selections keyed by the still-pending Paseo request ID;
- last viewed Agent;
- Config fold state;
- paired host profiles;
- HID bindings.

Transient interaction state is not restored after process death/restart:

- open action wheel;
- camera preview;
- provisional Voice transcript/audio;
- uncommitted Morse buffers/candidates;
- active text or image selection.

Paseo remains authoritative for projects, workspaces, agents, agent status, active turns, pending permissions/questions, accepted messages, and timeline history.

## 12. Connectivity and security

Host pairing and transport follow Paseo directly:

1. scan a standard Paseo pairing QR;
2. parse the standard relay connection offer;
3. open the Paseo Relay client WebSocket for that `serverId`;
4. perform Paseo's normal relay E2EE handshake with the daemon public key;
5. speak the ordinary Paseo WebSocket protocol.

Glasseo adds no separate authentication, gateway, relay, or server-side service.

## 13. Initial implementation boundary

The initial Glasseo client needs only the Paseo surfaces required by this specification:

- host pairing and relay connection lifecycle;
- project/workspace/agent directory reads and updates;
- agent snapshot reads;
- projected timeline fetch/pagination and `agent_stream`;
- local Draft storage;
- `sendAgentMessage` for Send/Steer and image submission;
- agent cancellation for Interrupt;
- permission/question response;
- Paseo dictation streaming;
- provider usage metadata when available.

Hardware-facing behavior is owned by the Android app: built-in Rokid input qualification and safe-subset mapping, Bluetooth HID mapping, press-duration classification, head posture, Camera2, microphone capture, and HUD lifecycle.