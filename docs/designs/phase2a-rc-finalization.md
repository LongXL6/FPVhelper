# Phase 2A — RC independent finalization

Base: 851ca2da59306178bcb4965e48474989e618a96e, Draft PR9 (not merged). R1 remains PARTIAL / measurement_sensitive_or_inconclusive; no performance matrix in this task.

## Baseline RED

`output/playwright/phase2a/baseline-red-01/receipt.json`: ordinary BUILD_ID `V6cINYwXAu4ghbu2DGoVE`, real IndexedDB/MediaRecorder/OPFS with synthetic MSP/video. A committed checkpoint has86 frames. Stop freezes98 frames while the test gate blocks the actual media stream close. A new readonly transaction still sees only the86-frame draft and no session; the UI retry is clickable but leaves that readback unchanged. Releasing the gate completes the media and only then produces the98-frame terminal record. The desired independent-terminal assertion fails; failure and bounded cleanup are retained. Screenshot is automated, not Computer Use.

## Small state model and ownership

| Fact | Owner / durable representation | Meaning |
| --- | --- | --- |
| Recording input | existing draftRef/recordingActiveRef | Same append, dedup, clocks and250ms count publication; freeze once on stop. |
| RC terminal transaction | pendingSessionRef + existing completeSession | RC pending/writing/error independent of media; only IDB transaction completion advances saved. Existing draft queue settles before terminal commit; existing tombstone prevents resurrection. List refresh failure is separate from failed RC transaction. |
| Media lifecycle | one ref containing original sessionId/operationId, promise outcome and association retry; version1 optional finalization metadata | pending→recorded/failed; null without a started recorder means not_requested; null after an actual recorder started is a failure/unknown outcome, never receipt. Reopen pending without owner displays unconfirmed, never fabricates success. |
| Content/export version | finalization.contentRevision / confirmedExportRevision, existing exportedAt/exportCount retained | Notes/media/termination changes increment revision only when content changes. Export close confirms the captured snapshot revision, not whichever revision is newest later. A prior confirmed file remains historical and is never overwritten. |

New records carry a small `finalization` extension with its own `version:1`, media state/operation identity and revision pair. Session schema/chunk format stay at2; IndexedDB version becomes3 without new stores or record rewrites. Existing versionchange listeners close old connections, and old open(version2) fails instead of dropping finalization metadata. Old v1/v2 input without this extension remains readable: legacy video:false means unknown, valid video:true remains a receipt, revision defaults0. Current parser explicitly validates known fields/version and rejects malformed/future extension versions; it does not drop the extension. Old binaries are not claimed to understand these new semantics. No eager rewrite/migration of old files or second truth store.

## Stop and merge sequence

1. Freeze the same Session once (all tail samples, IDs, dates, source, markers, termination priority and validity). Generate an operation ID only for the current media attempt.
2. Invoke media stop immediately, before awaiting any database operation. Capture a settled outcome handler; do not await it before starting RC finalization.
3. Settle in-flight checkpoints, then call existing atomic completeSession (session manifest + tail chunks + draft tombstone). Record RC saved immediately on transaction completion. RC retry remains effective while media promise is pending. Never save an obsolete draft after terminal success just because refreshing the list failed.
4. When media settles, atomically patch only matching session/operation metadata. A narrow `patchSession` transaction reads the latest manifest and updates its checksum while preserving chunks/count. Notes, export confirmation and termination upgrades use the same narrow patch mechanism. Same operation/identical receipt is a no-op; wrong operation or inconsistent receipt is a conflict. Association failure retains the successful receipt in the operation ref for association-only retry.
5. Automatic JSON waits for settled media association and reads the latest stored record, preserving the normal one-file path. User-triggered RC export is available after RC transaction confirmation while video remains pending; a later media receipt changes revision, so the early export is not labelled current. Existing versioned file names preserve the early snapshot. Export with a notes override first saves the explicit note via the metadata patch before capturing the export snapshot; a later file failure does not discard that saved note.

The active media ref and existing local-video active state continue blocking new sessions/configuration changes and warning on exit until media settles; RC saved does not unlock them. After reopen, old media is shown unknown/unconfirmed and is not automatically scanned or reconstructed. No new recording concurrency or media resource cancellation claim is introduced.

## UI and tests

Separate RC `isFinishing/hasPendingSave` from media pending/association error. Fix dashboard header, session card, library/detail save state, navigation auto-selection, notes and export guards; history summaries use the same revision-aware export predicate. RC saved/media pending must be readable and exportable; notes/termination/export patches preserve concurrent metadata. Keep60s/300sample validity, raw input contracts and synchronization=false unchanged.

Controlled tests cover pre-checkpoint tail, RC failure/retry with media pending, immediate/rejected/late media, concurrent notes/export, duplicate/wrong operation, list failure, termination upgrade and reopen. The metadata patch uses a single readwrite transaction so multiple store instances cannot lose each other's fields; no generic workflow engine.

CUA preparation: own loopback service/profile plus pre-navigation synthetic MSP/video and per-media-file gates (before actual close vs after actual close). Native Chrome for Testing CUA prepared devices successfully but start actions were interrupted and ScreenCaptureKit reported-3811; retained as an environment gap. Coordinator approved an IAB-owned page served through a dedicated loopback test proxy, injecting only test bootstrap before unchanged product scripts. Canvas synthetic video can supply a real MediaStream; IDB/OPFS/MediaRecorder remain native. The proxy exposes no arbitrary files and is not in the product build. CUA performs actual visible start/stop/export/reload; independent readonly assertions verify data. No DOM value fabrication or business-internal action injection.

Only local implementation/test commits are made here; the parent coordinates push/stacked Draft PR and review. Major compatibility or resource decisions are reported before widening scope.

## Rollback compatibility

The IndexedDB3 upgrade intentionally makes old binaries that open version2 fail. Any later application rollback must retain DB3-compatible reading/writing; downgrading the database or deleting it is not a rollback plan. Existing record originals remain. Blocked-upgrade tests use explicit request events (blocked → old connection closes → first request succeeds/closes → retry succeeds), not sleeps. This task produces only local review commits for a Draft PR; no deployment occurred.
