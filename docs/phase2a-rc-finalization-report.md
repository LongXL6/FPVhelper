# FPVHelper Phase 2A — Independent RC Finalization

Status: **needs_review**. Final Computer Use action receipts are included with explicit environment gaps. This is local implementation and review evidence, not merge, deployment, hardware or end-to-end delivery approval. R1 remains PARTIAL / measurement_sensitive_or_inconclusive; no performance A/B was run.

## Behavior and ownership

Stop freezes the original Session once and invokes media stop immediately. The RC final transaction proceeds without awaiting media. In-flight checkpoints precede final completion; the existing transaction commits terminal metadata/tail chunks/draft tombstone together. Confirmed sample counters advance at that transaction boundary. A later termination-metadata failure is shown separately from already-saved samples and has its own retry state.

Media callbacks carry the original Session/operation identity. An atomic metadata patch reads the current manifest in a readwrite transaction, checks manifest/chunk keys/quarantine, merges only permitted fields and updates its checksum. It does not rewrite sample chunks. Duplicate identical media receipts are idempotent; wrong operations or conflicting results fail. Notes, export confirmation and termination upgrades use the same transaction merge. Termination input is explicitly projected to two fields at both resolver and patch boundaries, including when callers pass a complete stale Session.

The normal automatic JSON waits for media association, without delaying RC saved state or viewing. Explicit early RC export is available while media is pending; later export uses existing version naming and retains the earlier file. Automatic export waits for an in-flight user export/notes operation before locking and capturing the latest record. `exportedAt/exportCount` history is retained; content/confirmed-export revisions distinguish an old file from current content. Explicit note overrides are saved before the export snapshot; file failure does not undo that saved note.

UI separates RC transaction state, pending termination update, media finalization/association and export. It retains the active-media start/configuration and exit guards. On same-origin reopen, a terminal RC record keeps its stop time/reason/samples; a pending media result is displayed unconfirmed, never inferred from a filename or nonzero file. A null result after a recorder actually started is not a success receipt; the no-recorder path remains not requested.

## Compatibility

Session schema/chunk format remain2. The optional `finalization.version=1` extension is strictly parsed, with unknown/malformed versions rejected rather than dropped. Legacy v1/v2 files without it remain readable; legacy video:false means unknown, and existing valid video receipts remain intact. Legacy revision defaults0 without changing original files.

IndexedDB becomes version3, with the same stores/chunks. Existing versionchange handlers close older connections, and binaries hardcoding open(version2) fail instead of erasing extension metadata. Tests retain old record originals and cover blocked upgrade, explicit old-close/first-request-success/retry-success events and old-open rejection. Any future application rollback must retain DB3 support; downgrading or deleting the DB is not a rollback. Uncommitted in-memory samples in an old active tab are not migrated: future adoption must finish old captures first. This task changed no user database or deployed environment.

## Identities and gates

- Base: `851ca2da59306178bcb4965e48474989e618a96e`, tree `d462e7074fad5a7bd72f7df42f5432599bdfe4d9`, private Draft PR9 (unmerged at initial verification).
- Final product/tested: `dac06ff38a307852a58cd894fb58824abc6f4d40`, tree `a30ebfdb79776f0172c99361aa5c43e4b4ab3323`.
- Baseline ordinary BUILD_ID: `V6cINYwXAu4ghbu2DGoVE`.
- Final smoke BUILD_ID: `cyLU6TcO9kLbhK3gAOKRD` (existing analytics-test configuration; query-off in new faults).
- Final ordinary BUILD_ID: `DPyUoeC8qHVHAWSNlDycX` (analytics disabled, measurement0, Next telemetry disabled).
- On final tested source: check passed **756 tests across79 files**, typecheck and lint. Complete browser smoke passed **30/30**, including six new native-storage/recorder fault/recovery scenarios. Ordinary build passed with clean source before/after.
- Ordinary compiled JS/HTML contains no Phase2A fault globals/bootstrap. The loopback test proxy owns injection; it is not a product build entry.
- Runtime/toolchain: Node v25.8.1, installed Next 16.3.3, React/React DOM 19.2.8, Playwright 1.62.1 and Vitest 4.1.11; lockfile unchanged. Installed React is not substituted for an unobserved ordinary browser React runtime version.

## Baseline RED and final browser GREEN

The automated baseline read an86-frame checkpoint, then froze98 frames. While the media gate blocked actual close, a new IndexedDB transaction still read an86-frame draft and zero terminal Sessions; clicking retry did not progress. Releasing the gate finally committed98 frames. The failed independent-terminal assertion and bounded cleanup remain in local evidence. Parent Computer Use independently observed1701 UI frames versus1700 persisted and no terminal completion; this UI evidence is separate from the automated86/98 readback.

Final native browser cases on dac06ff:

| Case | Actual evidence |
| --- | --- |
| Normal | 114 frozen samples, video receipt and exactly one final JSON; sample payload and receipt agree. |
| Actual close held | 115-sample terminal record and early JSON while underlying close had not resolved. Same page/context/origin reload retained the same Session ID, samples, endedAt and normal termination; media stayed pending/unconfirmed. A real beforeunload dialog was accepted. |
| RC transaction fault | No terminal Session after injected transaction failure; user retry while media still pending committed115 samples, with no fabricated video receipt. |
| Close resolved, acknowledgement held | 114 frozen samples; notes saved, early RC export close held, then media acknowledgement released. Metadata merged without overwriting notes/samples/time. Final JSON waited for the early export, used a distinct filename, and matched exportCount2/current revision2. |
| Association write fault | RC remained readable; receipt-only retry associated the same closed video. Only one media writable was created, and the114 samples/stop boundary did not change. |
| Rejected acknowledgement | A real video file existed after close, but metadata remained video.recorded=false/media.failed. RC and its JSON remained independently readable; file existence was not promoted into success. |

All new browser cases assert no unexpected page HTTP request outside their explicit local origin/GET/HEAD boundary. Inputs are synthetic; MediaRecorder, IndexedDB and OPFS are native. Controlled gates are not evidence of a particular physical disk/browser permanently hanging. Actual recorded MP4/WebM bytes were read during tests but were not exported as review files; do not claim those ephemeral-profile originals remain available after cleanup. Existing repository synthetic vision PNG/MP4 fixtures are unrelated to these new recordings.

## Retained failures and review corrections

The first smoke was27/30: old coupling assertions, a locator selecting a hidden workbench copy, and prematurely reading media metadata at initial RC confirmation. Those tests now separately wait for and strongly verify the relevant facts; raw/frame/media assertions were retained.

The second was29/30: an OPFS evidence read raised NotFound. Its original log did not record the exact file/stage, so no specific temporary-file or bad-directory cause is claimed. Evidence reads now wait for actual export confirmation, read only confirmed JSON in the unclosed-media scenario, and fail with stage/filename detail rather than suppressing errors.

Data review found and fixed strict media-state typing, termination normalization and missing-chunk/quarantine guarding. A final review found a complete stale Session could spread old fields into metadata: two explicit RED regressions reproduced pure-field loss and an actual fake-indexeddb note overwrite. Only the two-field projections were changed; the new exact source then passed756/30. Earlier passing candidate runs remain earlier evidence, not substitutes for this final source.

All failures remain under ignored local output. Reviewable exact excerpts, classifications, original/shared hashes and compact case summaries are prepared under `docs/evidence/phase2a-rc-finalization/`. Full sample arrays, Profiles, historical ZIPs and recorded media are not copied to GitHub. Hashes describe omitted originals, not their availability to a reviewer.

## Computer Use and external boundary

Native Chrome for Testing CUA could prepare synthetic devices but begin actions were interrupted; ScreenCaptureKit capture failed (-3811/-10005). It is not counted as a successful full CUA scenario. The parent then used its own IAB through the dedicated loopback test proxy, with bootstrap installed before unchanged product bundles and real visible user actions. Candidate normal UI success was observed (2883 samples,1296205-byte video receipt and final JSON); this is UI evidence, not a substitute for the native data assertions above. The pending case ea7e42d4 showed 2592 samples/00:30 saved while video still finished, disabled new capture, and confirmed an early JSON export. A fresh same-origin tab read that existing record; after closing the original pending tab and reloading the fresh tab, the same ID/count/duration and media-unconfirmed notice remained, and a second -v2 JSON export succeeded. No target record was seeded and no database was deleted. These are UI observations, not a second independent sample/byte calculation.

The original pending tab reload did not complete: getJsDialog returned undefined, and Computer Use safety policy denied native Codex app control for the confirmation. The parent did not bypass it. CUA therefore does **not** establish same-original-tab reload/dialog acceptance; the separately identified automated test does. Three real screenshots exist inline in the parent tool outputs, with no exported PNG bytes. Tabs5/6 were closed; closing the browser-generated error page in tab4 was blocked by URL policy and remains an explicit temporary-tab cleanup gap.

The15-minute proxy lifetime expired between candidate CUA scenarios; the parent restarted only that owned proxy against the same ordinary build and injection hash. No rebuild or data reset was used to hide the interruption. Original3140 baseline data was retained and distinguished from new Session IDs.

Remaining limits: R1 performance uncertainty, video queue budgets, full visual-history rewrite, full video recovery, physical synchronization, hardware/long-duration durability and power-loss guarantees remain open. Context closure is not an explicit track.stop/write-cancellation proof.

The parent owns final push, stacked Draft PR and ChatGPT review. This executor made no push, merge/main change, deployment, tag, cloud/database or real-device action. The handoff marks local-versus-GitHub availability explicitly; exact delivery identity is recorded after the documentation commit. Stop after parent review delivery.
