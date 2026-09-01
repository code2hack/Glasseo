# Glasseo Development Contract

## 1. Status and authority

This document is the verified development contract for Glasseo. It is governed by
`SPEC.md`, `AGENTS.md`, GitHub issue #1, and the CTO architecture decision recorded on
issue #1 on 2026-09-01.

As of 2026-09-02, issue #1 is closed with CTO `PASS` and issue #2 has established the
Android/TypeScript scaffold described here. Issues #3–#22 remain outside this scaffold;
their product and hardware behavior is not implied by the #2 compatibility probe.

## 2. Repository, host, and approved resources

| Item | Approved value | Verification |
|---|---|---|
| Canonical repository | `https://github.com/code2hack/Glasseo` | `gh repo view code2hack/Glasseo` |
| Manager workspace | `/home/code2hack/Projects/Glasseo` | clean `main` checkout on `u4090` |
| Development host | `u4090` | Ubuntu 22.04, Linux x86_64 |
| Manager tmux | `Glasseo:0.0` | active and owner-approved |
| Worker placement | separate `Glasseo` tmux windows and isolated worktrees on `u4090` | owner-approved |
| Worker profile | current default Codex profile | owner-approved |
| Maximum concurrent Workers | 4 | owner-approved; spawning remains sequential |
| Target device | Rokid `RG-glasses`, serial `1906092617103125` | authorized USB ADB device |
| Device use | install, run, logs, and hardware verification | owner-approved |

Only `u4090` is currently approved. Adding another host, device, profile, tmux layout, or
higher concurrency is a Project Owner gate.

## 3. Architecture boundary

Glasseo uses a single-Activity native Kotlin shell with a bundled local WebView app.

The native Android shell owns:

- built-in Rokid and Bluetooth HID event capture;
- mapping to the seven semantic controls and short/long/double classification;
- HUD and process/activity lifecycle;
- head-sensor acquisition;
- Camera2 preview/capture and QR scanning;
- microphone capture through `AudioRecord`;
- app-private media files; and
- a narrow typed bridge to the local WebView.

The bundled WebView app owns:

- all Glasseo product UI and deterministic state transitions;
- Agent pager, Timeline, Config, Draft, action wheel, Voice, and Morse state;
- local structured UI state;
- the Paseo TypeScript client/protocol/relay runtime; and
- protocol-facing caches and reconciliation.

Use plain TypeScript, HTML, and CSS. Do not introduce Expo, React Native, Compose, an
NDK dependency, a Glasseo server, a custom relay, a custom wire protocol, or a Kotlin
port of Paseo protocol/crypto in the baseline.

The WebView loads bundled assets from a local HTTPS app-assets origin through
`WebViewAssetLoader`. It must block arbitrary navigation. Privileged native messaging
must use a narrow, typed, local-origin-only AndroidX WebKit message boundary rather than
an unrestricted JavaScript interface.

Product reducers must remain testable without Android hardware. Android facilities sit
behind adapters and emit normalized semantic events.

## 4. Pinned toolchains

### 4.1 Android

The scaffold uses these exact baseline pins:

| Component | Pin | Current host state |
|---|---:|---|
| JDK | 17 | OpenJDK `17.0.20` verified |
| `minSdk` | 32 | target device is API 32 |
| `compileSdk` | 36 | installed |
| `targetSdk` | 35 | deliberate first-release compatibility target |
| Android Gradle Plugin | `9.0.1` | verified by scaffold builds |
| Gradle wrapper | `9.1.0` | committed with distribution checksum; no system Gradle required |
| Android Build Tools | `36.0.0` | installed |
| Kotlin | AGP 9 built-in Kotlin (KGP runtime `2.2.10`) | verified by scaffold builds |
| NDK | none | installed NDK is not a baseline dependency |

Do not apply `org.jetbrains.kotlin.android`; AGP 9 built-in Kotlin is enabled by default.
The official AGP 9.0.1 compatibility matrix requires Gradle 9.1.0, Build Tools 36.0.0,
and JDK 17 and supports API 36.1.

Host Android SDK:

```text
/home/code2hack/Android/Sdk
```

Verified installed packages include platform-tools `37.0.0`, platforms 35 and 36,
Build Tools 35.0.0/36.0.0/36.1.0, emulator `37.1.11`, and an Android 36 x86_64 system
image. A second system SDK root exists at `/opt/android-sdk`, and local `adb`/`fastboot`
wrappers resolve to platform-tools 37.0.0 under
`/home/code2hack/.local/share/android-platform-tools`.

The host already has the approved scaffold closure cached locally: Gradle wrapper
distribution 9.1.0, AGP 9.0.1 artifacts, and Kotlin 2.2.10 runtime artifacts. This is a
full command-line Android/Rokid development toolchain. A standalone `gradle` executable or
Android Studio installation is not required because Glasseo must use its committed Gradle
wrapper. The physical Rokid device, not the emulator, is the acceptance target.

### 4.2 TypeScript build runtime

Glasseo pins Node `22.23.1` and npm `10.9.8`. They are installed under NVM with the
local alias `glasseo`:

```bash
. "$HOME/.nvm/nvm.sh"
nvm use glasseo
node --version
npm --version
```

Expected results are `v22.23.1` and `10.9.8`. Node 24 may also exist on the host, but it
is not the Glasseo build runtime. The scaffold pins esbuild `0.28.2`, TypeScript `5.9.2`,
ESLint `10.9.1`, typescript-eslint `8.69.0`, Prettier `3.6.2`, and tsx `4.20.5` exactly in
the committed npm lockfile. AndroidX WebKit is pinned to `1.17.0`.

## 5. Paseo runtime and version policy

Pin the published packages exactly, with no caret or tilde ranges:

```text
@getpaseo/client   0.7.0
@getpaseo/protocol 0.7.0
@getpaseo/relay    0.7.0
```

Commit the npm lockfile. The audited upstream release is Paseo tag `v0.7.0`, commit
`c56638ea8c2852d722a87e700abf3c966ded617e`. Upstream `main` was
`95575ad05a4b50fb6d8d49ef22f419c7eaf19632` when issue #1 was verified; it is research
evidence, never a moving build dependency.

Exactly one Glasseo-owned adapter may import
`@getpaseo/client/internal/daemon-client`. All application code depends on Glasseo-owned
interfaces. Instantiate the existing client identity `clientType = "mobile"`; do not add
a `glasses` client type.

The TypeScript runtime owns wire validation, request correlation, relay E2EE, and protocol
compatibility. Reuse `DaemonClient` operations for Send/Steer (`activeTurnBehavior`),
cancellation, permission response, dictation streaming, and selective timeline
subscriptions. Native Kotlin must not duplicate them.

Glasseo supports only the standard Paseo Relay connection path: parse the ordinary
pairing offer, use its relay endpoint and daemon public key, establish Paseo's existing
Curve25519 + XSalsa20-Poly1305 E2EE channel, and speak the ordinary WebSocket protocol.
Secure randomness is mandatory; there is no insecure fallback.

Advertise only implemented capabilities. Prefer selective Agent timeline delivery and
subscribe the viewed Agent instead of continuously streaming every Agent. Host-local
state keys use `serverId`; Agent-local keys use `(serverId, agentId)`.

A future Paseo 0.7.x change is deliberate: update all exact pins together, rerun protocol,
relay, and real-device compatibility tests, record the tested daemon range, and obtain CTO
review.

## 6. Build, test, lint, formatting, packaging, and CI contract

The scaffold provides these non-interactive entry points, verified on `u4090` with JDK 17,
Node 22.23.1, npm 10.9.8, and the Android SDK path from Section 4:

```bash
. "$HOME/.nvm/nvm.sh"
nvm use
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
./gradlew assembleDebug
./gradlew test
./gradlew lintDebug
./gradlew connectedDebugAndroidTest
./gradlew assembleRelease
```

Command ownership:

- `npm run build` bundles the local WebView application into Android assets.
- `npm run typecheck` checks TypeScript without emitting.
- `npm test` runs deterministic product reducer, adapter, and protocol-boundary tests.
- `npm run lint` and `npm run format:check` are non-mutating CI checks.
- `./gradlew test` runs JVM-side native unit tests.
- `./gradlew connectedDebugAndroidTest` runs instrumentation and WebView qualification on
  the approved device.
- `assembleDebug` and `assembleRelease` must depend on the WebView asset build and produce
  reproducible APK paths under `app/build/outputs/apk/`.

`.github/workflows/ci.yml` runs npm install/build/typecheck/test/lint/format, Gradle unit
tests/lint, and debug/release assembly from a clean checkout and uploads APK artifacts.
Real-device checks remain Manager-run because GitHub-hosted CI has no Rokid device.

No current command result should be represented as passing until #2 provides the files.

## 7. Rokid device and ADB procedures

Set the target explicitly in every device command:

```bash
export GLASSEO_DEVICE_SERIAL=1906092617103125
adb -s "$GLASSEO_DEVICE_SERIAL" get-state
adb -s "$GLASSEO_DEVICE_SERIAL" shell getprop ro.product.model
adb -s "$GLASSEO_DEVICE_SERIAL" shell getprop ro.build.version.sdk
```

For ordinary single-device operations on this host, the qualified helper automatically
selects an authorized Rokid and fails closed when none is present:

```bash
rokid-adb get-state
rokid-adb shell getprop ro.build.fingerprint
rokid-adb logcat -d -t 200
```

Use the explicit serial form in recorded acceptance evidence so each result remains bound
to the target device.

Verified device facts:

| Fact | Value |
|---|---|
| Manufacturer/model | Rokid `RG-glasses` |
| Android | 12 / API 32 |
| ABI | `arm64-v8a`, `armeabi-v7a`, `armeabi` |
| HUD | physical 480x640, density 240, runtime override 204 |
| Camera/microphone | advertised by PackageManager |
| Bluetooth/BLE | advertised by PackageManager |
| Head sensors | accelerometer, compass, gyroscope advertised |
| Storage | approximately 17 GiB available when checked |
| System WebView | `com.android.webview` `95.0.4638.74` |

Prior same-host/same-device evidence under `/home/code2hack/dsh-glasses/docs/evidence/`
confirms that this machine has already built, installed, launched, inspected, and debugged
a local-asset WebView APK on the glasses. It also qualifies the dynamic Game Rotation Vector
(sensor type 15) and gyroscope (type 4) sources and the synthetic framework input plumbing.
That evidence is reusable environment knowledge, not Glasseo feature acceptance: genuine
physical Rokid control mappings and Glasseo's Paseo/WebView behavior still require the
ticket-specific gates below.

After issue #2 establishes package/application IDs, use:

```bash
./gradlew assembleDebug
adb -s "$GLASSEO_DEVICE_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$GLASSEO_DEVICE_SERIAL" shell am force-stop com.code2hack.glasseo
adb -s "$GLASSEO_DEVICE_SERIAL" shell monkey -p com.code2hack.glasseo 1
adb -s "$GLASSEO_DEVICE_SERIAL" logcat -c
adb -s "$GLASSEO_DEVICE_SERIAL" logcat Glasseo:D AndroidRuntime:E '*:S'
```

Issue #2 owns the final application ID and launch component; if it differs from
`com.code2hack.glasseo`, update this document in the same change.

Issue #2 retained application ID `com.code2hack.glasseo` and launch component
`com.code2hack.glasseo/.MainActivity`. The stable bounded diagnostic tag is `Glasseo`.

### 7.1 Required WebView gate in issue #2

The installed WebView is old enough that version inspection is insufficient. Before #2
passes, an instrumentation/smoke screen on the physical Rokid must exercise and record:

- WebSocket text and binary frames with `ArrayBuffer` round trips;
- `TextEncoder` and `TextDecoder`;
- `crypto.getRandomValues` with the Paseo relay crypto path;
- Promise scheduling;
- IndexedDB or the selected local structured-state storage;
- local HTTPS app-assets origin loading and blocked remote navigation; and
- native message bridge origin restrictions.

Failure of secure randomness is a blocker. A narrow native `SecureRandom` bridge may be
planned and tested; predictable or downgraded randomness is forbidden.

On 2026-09-02, `connectedDebugAndroidTest` passed these probes on serial
`1906092617103125` with System WebView `95.0.4638.74`: HTTPS app-assets origin,
non-ASCII `TextEncoder`/`TextDecoder`, Promise microtask ordering, IndexedDB write/close/
reopen/read/delete, `crypto.getRandomValues`, the pinned Paseo Relay key-generation/export
path, valid-TLS WSS text and binary `ArrayBuffer` echo, blocked remote main-frame
navigation, and an absent privileged bridge in an untrusted data-origin frame.

The default diagnostic probe tries `wss://echo.websocket.org` and Postman's documented
`wss://ws.postman-echo.com/raw`; a `wss` query parameter can select one controlled
valid-TLS endpoint. The external services were intermittently reachable from this device,
so passing still requires one exact text and binary echo rather than endpoint reachability.
No TLS bypass, cleartext WebSocket, mixed-content relaxation, or unrestricted JavaScript
interface was used. Paseo Relay 0.7.0's published `import` export points at omitted source
files, so the esbuild scaffold selects its published `node` condition, which resolves the
browser-safe compiled distribution exercised by the device probe.

### 7.2 Camera, microphone, HID, QR, network, and Relay

- Device operations are automation-first. Use ADB for install/uninstall, launch/stop,
  permission grants/revocations, app-ops, input injection, settings/UI automation, state
  inspection, and evidence capture whenever the target firmware exposes a reliable path.
  An Android permission dialog is not a human gate when the same permission can be applied
  and verified through ADB. For the baseline package, declared runtime permissions may be
  managed with commands such as
  `adb shell pm grant com.code2hack.glasseo android.permission.CAMERA` and
  `adb shell pm grant com.code2hack.glasseo android.permission.RECORD_AUDIO`; always verify
  the resulting package/app-op state rather than inferring success from command exit alone.
- Camera2 preview/capture and QR scanning require real-device verification under the
  actual 480x640 HUD lifecycle.
- Microphone verification must cover start, streaming, cancellation, app backgrounding,
  and permission denial without retaining provisional audio/transcript state.
- Built-in Rokid keys and Bluetooth HID bindings must work together. Automate Bluetooth
  settings navigation, pairing confirmation, key identification, and reset verification
  through ADB when reliable. Escalate only a genuinely physical step that ADB cannot
  perform, such as placing a peripheral into pairing mode or reconnecting an unavailable
  cable.
- Generate a standard offer on a Paseo 0.7.0 daemon with
  `paseo daemon pair --relay` (or `--json` for structured automation), scan it through
  Glasseo, and verify the offer's TLS/relay/public-key fields and E2EE connection.
- Relay credentials, pairing offers, daemon private keys, QR payloads, and traffic content
  must never be committed or pasted into logs/issues. Record redacted connection results.
- Do not expose a Paseo daemon directly to the public network for Glasseo testing.

### 7.3 Debugging and evidence priority

Logs and synchronized traces are stronger debugging and behavioral evidence than
screenshots. Capture the evidence closest to the behavior being claimed:

1. structured app/native/WebView logs and automated test output;
2. synchronized raw/framework traces such as `getevent`, `logcat`, WebView console/CDP,
   relay/WebSocket state, and redacted protocol events;
3. authoritative Android state from `dumpsys`, package/app-op state, process/lifecycle
   state, and persisted-state queries;
4. screenshots or screen recordings as supporting evidence for visual layout only.

Use monotonic or otherwise correlatable timestamps, record the source/provenance of each
channel, and preserve command exit statuses. A screenshot must not substitute for traces
when proving event identity, ordering, timing, suppression, lifecycle, transport,
reconnection, persistence, or absence of duplicated actions. Redact credentials, pairing
offers, private keys, and sensitive content from all recorded logs and traces.

Screenshots remain useful for pixel/layout/HUD assertions and for orienting a trace, but a
visual symptom should be paired with the strongest available state/log evidence. During
debugging, prefer a bounded reproducible capture window over an unbounded log stream.

## 8. Credentials and browser boundary

The Project Owner approved existing `gh` authentication and the authenticated controlled
Chrome profile. Agents may use them for in-scope GitHub and CTO operations, but must never
extract, copy, print, persist, or relay tokens, cookies, passwords, browser storage, or
other secrets.

The CTO conversation URL is supplied out of band and must not be committed to this public
repository. The persistent controlled Chrome profile is local-only:

```text
/home/code2hack/.config/google-chrome-codex
```

Chrome 136+ requires a non-default user-data directory for remote debugging. On `u4090`,
the Manager launches that profile on the desktop display with CDP port 9222, then verifies
it using the `$ask-chatgpt` helper's `targets` command. Retry by relaunching the same profile
and checking the same exact CTO URL. After three failed reachability/authentication checks,
raise an ALARM; never fall back to another conversation or browser profile.

## 9. Git, worktree, tmux, and Worker lifecycle

- Manager coordination starts from a clean, up-to-date canonical checkout.
- Each implementation issue owns one branch named `codex/issue-<number>-<slug>` and one
  worktree at `/home/code2hack/Projects/Glasseo-worktrees/issue-<number>`.
- Before creating a worktree, resolve the exact branch, target path, issue, dependencies,
  and CTO plan comment. Never reuse another issue's worktree.
- Each Worker uses one separately named `Glasseo` tmux window, `worker-<number>`, and is
  named `Glasseo-#<number>-worker@u4090`.
- Every Worker prompt includes Manager coordinates `Glasseo:0.0`, exact issue/plan URLs,
  branch/worktree, acceptance criteria, commands from this file, and human-gate procedure.
- The Manager creates Workers sequentially and never exceeds four active Workers.
- Workers commit and push but do not merge. The Manager verifies the remote branch, opens
  the PR, obtains CTO review, and merges only after `PASS` and required checks.
- Commit/amend operations created by Codex must include exactly one `Codex-Host` and one
  `Codex-Thread-ID` trailer using actual session metadata.

Cleanup occurs only after merge/closure or explicit owner cancellation. Verify the exact
worktree path and branch first; remove only that worktree and only its tmux window. Never
close the `Glasseo` or persistent `sudo` tmux session, other windows, or unrelated panes.
Never use broad `git clean`, hard reset, or recursive deletion for lifecycle cleanup.

## 10. ALARM and human-gate procedure

The owner-approved alarm is the local MP3
`/home/code2hack/Music/super-mario-alarm.mp3` through the HDMI sink
`alsa_output.pci-0000_08_00.1.hdmi-stereo`.

Use direct HDMI decoding/routing:

```bash
ffmpeg -v error -i /home/code2hack/Music/super-mario-alarm.mp3 -f wav - \
  | paplay --device=alsa_output.pci-0000_08_00.1.hdmi-stereo
```

`ffplay` alone is not the canonical command because PipeWire stream-restore moved its
stream to the analog default sink during validation. HDMI routing was verified after an
explicit move; the command above avoids that ambiguity by selecting the sink in `paplay`.

An ALARM report to the Project Owner states the event, affected issue/Worker, exact owner
action, and safe repository/device/process state. After raising it, preserve state and wait.

Human gates are restricted to steps that actually require owner judgment, credentials, or
physical action after safe automation has been exhausted. ADB-capable unlock-independent
device setup, permission handling, input/UI automation, application lifecycle, and evidence
capture must not interrupt the owner. Human gates include an unlock or cable/peripheral
action that ADB cannot perform, secret/login entry, specification changes,
destructive/security-sensitive actions not already approved, new hosts/profiles or
concurrency above four, and ambiguity that materially changes visible behavior.

## 11. Privileged commands

No issue #1 validation required `sudo`. If later work requires interactive sudo, follow
`AGENTS.md`: resolve exact targets, run it in a unique window of the persistent `sudo` tmux
session, ask the owner to attach and type the password directly, stop polling, then inspect
and close only that command window after completion. Never capture or pass a sudo password.

## 12. Known limitations and deferred verification

- The #2 scaffold intentionally contains no product controls, device input mapping, Paseo
  connection lifecycle, pairing, Agent UI/state, camera, microphone, sensor, or HID flow;
  those remain owned by #3–#22.
- The full command-line Rokid/Android toolchain is present. Android Studio is not part of
  the required or approved build contract; all reproducible builds use `./gradlew`.
- `ANDROID_HOME` and `ANDROID_SDK_ROOT` were unset in the Manager shell; issue #2 should
  commit no machine-specific SDK path and may use an untracked `local.properties` on hosts.
- The physical device is connected now. Runtime permissions and device/UI setup are
  automated through ADB when supported; only residual physical unlock, cable, or peripheral
  pairing actions that cannot be automated remain human gates.
- System WebView 95 capability and the pinned Paseo relay crypto bundle are covered by the
  executable #2 instrumentation probe described above; full Relay connection lifecycle is
  still owned by later tickets.
- The emulator is available but is not a substitute for Rokid input, sensors, camera,
  microphone, HID, HUD, or WebView acceptance.
- Real Paseo daemon/Relay connection integration remains #4/#5 scope and must use unmodified
  Paseo 0.7.0 packages and standard offers.

## 13. Issue #1 evidence executed

The Manager executed read-only or non-destructive checks for:

- repository cleanliness, remotes, commit history, issues, PRs, and GitHub authentication;
- Java, Android SDK packages, ADB, Node/npm, Codex, Git, GitHub CLI, tmux, FFmpeg, and audio
  sink versions/availability;
- cached Gradle 9.1.0, AGP 9.0.1, Kotlin 2.2.10, the `rokid-adb` selector, Fastboot, and
  the prior same-device WebView/sensor/input qualification evidence;
- target device identity, API/ABI, HUD size/density, advertised hardware features, storage,
  process memory, and System WebView provider/version;
- Paseo release/tag/package metadata and package export/dependency boundaries; and
- authenticated CTO conversation/CDP reachability through the isolated profile.

The exact evidence and architecture decision are recorded on GitHub issue #1. Deferred
commands are assigned explicitly to issue #2 above.

## 14. Primary references

- [Android Gradle Plugin 9.0.1 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes)
- [Android built-in Kotlin migration](https://developer.android.com/build/migrate-to-built-in-kotlin)
- [Paseo v0.7.0 release](https://github.com/getpaseo/paseo/releases/tag/v0.7.0)
- [Paseo client package](https://github.com/getpaseo/paseo/tree/v0.7.0/packages/client)
- [Paseo security model](https://github.com/getpaseo/paseo/blob/v0.7.0/public-docs/security.md)
