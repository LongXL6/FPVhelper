# Capture / UI publication baseline — Phase 1A

The machine plan is [measurement-plan.json](measurement-plan.json), now
`frozen` with formal execution allowed after the source/build gates below. This directory defines a measurement, not an
optimization, runtime extraction, or approval to release. No formal results exist
merely because the plan or harness exists.

The approved Phase 0 baseline supplied to this task is
`4a35333f9aea79340105a0eaf8b1b3eb7875920f`, for run
`fpvhelper-phase0-20260905-201716`. Its tested implementation is `7fe1938…`;
the intervening commit only adds the Phase 0 handoff. Local evidence below retains
the full SHA, parent, tree, UTC commit date and exact full-index diff.

## Conditions and modes

| ID | Input / activity | Modes per repeat |
|---|---|---|
| S0 | Product demo; no serial fixture | P1 |
| S1-100 | One synthetic port, nominal 100 Hz, idle view | N / P0 / P1 |
| S1-50 | One synthetic port, nominal 50 Hz, idle view | P1 |
| S2 | 100 Hz plus synthetic video and local OSD recording | N / P0 / P1 |
| S3 | Two synthetic ports, channel switching, internal navigation | P1 |
| S4 | Pause/resume, return to demo, explicit cleanup | P1 |

N is the ordinary production build with the measurement build flag off. P0 and
P1 use the **same profiling build**: P0 disables trace collection, P1 enables it.
The fixture deliberately requests setup on in N too; the compiled-out ordinary
build must still expose no measurement bridge.
Unavailable internal metrics in N/P0 are `null` with a reason, never invented zero.
Compare P0−N and P1−P0 separately, using metrics available in both runs. React's
estimated `baseDuration` is not an independently measured N baseline.
Every mode uses `fixture detailed=false` and the same bounded independent frame
ledger (requested/planned/generated/delivered times) and per-port aggregate
counters. P1−P0 adds product collector and profiler callback recording, without
also enabling extra fixture request/chunk logging.
Before/after CDP observation also stays identical across all three modes.

The plan fixes 5 s warmup, a 20 s steady window and 3 repeats. This deliberately
short first baseline limits disruption on the active workstation; it is shorter
than a recommended 60 s window and does not establish sustained-load behavior.
S3/S4 use separately labelled lifecycle phases, not a pooled steady-state ratio.
The explicit 30-run order rotates N/P0/P1 to P0/P1/N to P1/N/P0 across repeats.
Retain all exploratory, failed and partial batches; never pick only the fastest
or successful repetitions for the final comparison.

## Cohorts, clocks and React meaning

Use the page's real `performance.now()` clock. Do not install fake clocks.
After warmup, collect independently confirmed fixture deliveries in `[t0,t1)`.
Use the actual page-clock end boundary and report elapsed duration separately
from the planned wait. At t1 freeze that cohort and allow up to 3 s for drain.
Keep transport running during steady S1/S2 drain: pausing could trigger RC stale
guards and prematurely stop a recording, changing the normal workflow measured.
Preserve in-flight and later deliveries; exclude their IDs only by the declared
delivery-time rule. S4 pauses only in its explicit lifecycle phase. Do not erase
records or change the cohort to hide missing boundary samples.

The independent key is source/port plus `fixtureFrameId`; product `sequence`
does not establish input identity. Scheduled ticks, delivered frames, raw
subscriptions, recording acceptance and visible UI each have distinct counts.
Expected raw IDs intersect each consumer's actual valid subscription intervals.
Expected recorded IDs also intersect the actual recording gate; the full saved
Session includes warmup/other phases and is not the measurement-window denominator.
Demo has no independent serial delivery cohort. Report that completeness metric
as unavailable, not as perfect delivery of zero samples.

The capture observations include `read.batch` for reader results carrying bytes,
and `parser.frame` for each frame produced by that read batch. Keep read byte/chunk
counts and parser command/error counts separate: neither is the RC sample cohort.
The parser observation includes non-RC/error frames; a buffered frame is associated
with the read that completes it. N/P0 leave these internal events unavailable.

Profiler boundaries are `workbench`, `telemetry-display`, `throttle-timeline`,
`recording-ui`, and `pilot-bridge:<channel>`. Report their observed coverage and
React fields: id, phase, actualDuration, baseDuration, startTime and commitTime.
Use `commitTime`, rather than the later collector callback timestamp, for the
measurement window. Raw callback count per profiler is primary. The `workbench`
callback count describes commits of that measured subtree, not every page root.
Distinct commit timestamps help associate boundaries; they are not guaranteed
unique identities. Preserve callbacks with equal timestamps and flag repeated
`workbench` commitTime values as ambiguous. Nested boundary callbacks must not be
added as root commits, or their overlapping durations summed as total CPU.
Profiler data is neither DOM mutation count nor painted FPS.
Keep Strict Mode configured true across modes. Record React's **actual Next app
runtime version**, which may differ from the installed `react/package.json`.

The runner enables the CDP Performance domain once per page and reads the same
six counters before/after every labelled interval: Timestamp, TaskDuration,
ScriptDuration, LayoutDuration, JSHeapUsedSize and JSHeapTotalSize. CDP timestamps
and cumulative duration deltas use seconds in their own clock domain; heap
endpoints use bytes. Do not mix these timestamps with page-clock milliseconds.
This bracket includes the page window, any drain, and control/observation overhead.
For renderer task occupancy, divide TaskDuration delta by CDP Timestamp delta,
not by the shorter input cohort duration. Keep the endpoints and denominator;
do not add ScriptDuration to total TaskDuration. These are renderer observations,
not whole-machine CPU or peak heap. Missing observations remain unavailable.

## Budgets and stop conditions

One isolated browser and one run-owned server at a time; build/mode changes are
sequential. Do not attach to user Chrome, reuse its storage, occupy devices,
restart user services, or run a build/smoke batch in parallel with measurements.
All camera/serial content and recording storage are isolated synthetic fixtures.
Analytics and Next telemetry are disabled; only the owned loopback origin is
allowed. Unexpected external requests stop the batch and remain in evidence.

The collector has a hard cap of 200,000 fixed-schema events, not a heap byte cap.
Check the encoded snapshot ceiling of 64 MiB after each bounded run; do not add
per-frame JSON serialization to measure its size. Retain JSON traces as gzip and
record both raw and compressed byte counts. The 250 MiB artifact budget covers the
entire isolated worktree's `output/playwright`, including earlier explorations,
failures, prerequisites, build/server logs and formal evidence. A fresh output
subdirectory does not reset this allowance.
Report temporary snapshot/compression peaks separately. Require 2 GiB available
disk, at most 120 s per run, 20 s cleanup and 30 min for the entire batch.
The parent allows `maxRunMs + cleanupMs` (140 s) for its runner process, capped by
`batchStarted + maxBatchMs - cleanupMs`. This reserves the final 20 s for cleanup
inside the 30 min batch ceiling. Cleanup allowance is not measurement time.
No heap threshold has been established (`maxHeapBytes: null`); neither encoded
bytes nor event count establish a heap cap. Stop as partial on integrity failure, overflow,
disk/artifact limits, unexpected network activity or unresolved cleanup. A timeout
does not prove cancellation or resource release. Preserve failures instead of
deleting their artifacts to make room for more runs.

## Exploration, freeze and execution

The lower-level runner is `scripts/measure-phase1a.mts`, with fixture
`e2e/fixtures/measurement-hardware.ts` and analyzer `scripts/phase1a-analysis.ts`.
`scripts/run-phase1a-batch.mts` orchestrates formal runs, owns one server PID/process
group and switches N/P categories by the plan's zero-based run index. Both URLs
are `http://127.0.0.1:3124/`; the two build categories never run concurrently.
The direct runner does not start or stop a server: its caller owns that lifecycle.
Node needs `--experimental-transform-types` for imported TypeScript; the
orchestrator passes it to its child runner too. Source inspection and an earlier
P1 exploration do not establish final-source acceptance of every mode or cleanup.

Build the profiling version first, then the ordinary N version last:

```sh
FPV_MEASUREMENT_BUILD=1 NEXT_PUBLIC_ANALYTICS_ENABLED=false NEXT_TELEMETRY_DISABLED=1 npm run build -- --profile
FPV_MEASUREMENT_BUILD=0 NEXT_PUBLIC_ANALYTICS_ENABLED=false NEXT_TELEMETRY_DISABLED=1 npm run build
```

Next may transiently rewrite tracked `next-env.d.ts` for `.next-measurement`;
record that change and check the final ordinary build leaves tracked files clean.
Formal orchestration requires the exact source/build receipt and both BUILD_IDs.
Before each formal run it rechecks that HEAD equals the batch source and the
working tree is clean; a change stops the batch as partial.
After the freeze gate below, use a new output directory for each formal batch:

```sh
node --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/run-phase1a-batch.mts \
  --plan benchmarks/capture/measurement-plan.json \
  --output output/playwright/phase1a-formal-01 --port 3124
```

For the draft positive control, the caller first starts one owned profiling server
on that unused port; use a fresh output directory:

```sh
node --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/measure-phase1a.mts \
  --plan benchmarks/capture/measurement-plan.json \
  --normal-url http://127.0.0.1:3124/ --profile-url http://127.0.0.1:3124/ \
  --output output/playwright/phase1a-exploratory-01 \
  --exploratory --condition S1-100 --mode P1
```

Exploration caps warmup, window and lifecycle phases at 2 s and runs one repeat.
It does not count as a
formal repetition. Verify a positive control with genuine profiling callbacks,
P0 trace-off behavior, N isolation, independent input reconciliation and budgets.
Record actual browser/runtime React versions, headless mode, viewport, profiler
coverage and GPU backend (or explicit unavailability); never copy registry values
into fields claiming runtime observation.

The retained `output/playwright/phase1a/explore-03/` raw artifact contains React
`19.3.0-canary-cbb046ab-20260731`, 8 mount, 6,984 update and 40 nested-update
callbacks across the whole exploratory capture. It also records Chromium
151.0.7922.34, headless true, 1440 × 1100 viewport, and GPU explicitly unqueried.
The plan records the artifact SHA and its source/diff/plan identity. These are
observations of that earlier draft. Its summary is not final acceptance of later
fixture/analyzer changes, nor a formal measurement repetition.

After the capture observations were rebuilt, explore-07 completed all six P1
conditions (S0, S1-100, S1-50, S2, S3, S4). Its original gzip artifacts have passing
reanalysis receipts for the analyzer hash recorded in `freezeEvidence`.
Explore-08/09 provide two P0 and two N controls: P0 bridge disabled with zero
events, N bridge absent, common CDP available, and both S2 MP4 files playable at
1920 × 1080 with matching saved JSON. Raw hashes and historical results remain
in the exploratory index; these runs do not count toward formal repetitions.

Frozen observations record Chromium 151.0.7922.34, headless true, 1440 × 1100,
and profiling React `19.3.0-canary-cbb046ab-20260731`. GPU is explicitly unqueried.
The ordinary React runtime version remains null because N provided no direct
observation; a package version is not substituted. Raw exploration artifacts do
not store the server port, so the formal owned-server receipt must bind port 3124.

The protocol is now frozen. **Commit the plan before formal runs**, then complete
the exact-source checks and source-linked normal/profile build receipts.
Bind each run receipt to the exact frozen plan hash/commit, source commit and
build mode. Record the final plan commit/hash outside the plan to avoid a
self-referential hash. The corresponding null fields in the plan require external
binding; they do not waive it. No formal batch or final build is claimed complete
by the frozen status. Changing conditions after inspection of formal results
requires a new plan version/batch; keep the original results.

## Prerequisite evidence

`output/playwright/phase1a-prerequisites/` is gitignored and **local-only**:

- `environment.json`: OS/CPU/RAM, Node/npm, installed/locked versions, Chromium
  registry/file presence and disk gate; actual runtime/GPU/headless are pending.
- `phase0-reviewed-baseline.json` and `phase0-tested-to-reviewed.patch`: commit,
  parent, tree, UTC dates and full-index diff, without author names/emails.
- `tracked-files-sha256.json`: all 230 tracked baseline files hashed from Git blob
  bytes, including implementation/tests/config/lockfile; no raw file contents.
- `read-only-command-receipts.json`: actual command exit codes and elapsed times.
- `exploratory-index.json`: explore-01 reported bootstrap failure and immutable
  raw/summary/reanalysis references for explore-02…09, including failures.

The initial 16 MiB draft is retained locally alongside a recorded budget revision:
JS object memory differs from serialized size, and per-frame serialization would
distort the measurement. Exploration checked the selected budgets; event counts
and encoded bytes still do not establish peak heap or sustained-load capacity.

These prerequisites ran no tests, browser, device, account/database or network
operations. Local executable paths must be redacted before creating any shared
bundle. Later measurements need their own receipts; installed Chromium does not
prove a browser launch, hardware GPU use or a working React profiling build.
