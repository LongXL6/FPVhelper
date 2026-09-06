# FPVHelper Phase 2A-R1 — Session-bound Automatic Export Destination

Status: needs_review. DIRECTORY-01 is dynamically confirmed and locally fixed. This is an increment over PR11 review head 0ee45e163adf15954b7163250d948bf167e1c1f7, not another Phase2A implementation or a release.

## Behavior

At stop, the finalization operation captures its authorized directory before any media/early-export wait. Automatic final JSON receives that handle explicitly. User-initiated manual export instead captures the selection at its own action entry. The handle remains in memory; it is not serialized into Session JSON or stored in a new database/queue.

Selection can change to D2 for subsequent Sessions. S1 keeps D1 and cannot borrow D2 on delayed completion or original-directory failure. Clearing changes the default for future records; already-stopped records retain their queued target. The clear action explicitly says that pending exports still use their original folder. It does not cancel existing writes or switch them to another directory.

Directory permission/error/ready updates are conditioned on the target handle still being the current selection. Export success names its real file/folder; original-directory failure names the Session ID prefix and D1. A failed auto archive retains native RC/media facts; any existing ordinary-download fallback is explicitly unconfirmed and cannot mark D2 or the latest revision saved. A later explicit manual export may use D2.

A second controlled RED found S1 late export success could clear S2 RC transaction failure, or S1 export-metadata failure could replace its explanation. Samples/pending state were not lost. Directory export feedback now checks current draft/pending/finalization Session identity before clearing or replacing storageError; its own export failure remains explicitly identified. Both success/failure regressions passed after the guard.

No RC/media lock was extended. No DB version/schema change, persistent directory association, cloud integration, cross-reload archival queue, media migration or cancellation claim was introduced.

## Evidence boundaries

Original Phase2A dac06ff 756/30 and CUA evidence remain unchanged under their original run. The first new candidate a42f0e3 passed758 unit tests but full smoke was30/31: full/crop test read Session metadata immediately after media-file close, before later association/export transactions. The failure is retained. It now waits for both exact media/export confirmations and then runs all original receipt, video-file and sample assertions.

Baseline native RED used unchanged product0ee45e1 plus the new test: normal UI replaced D1 with D2 while early JSON close was held and media was associated. D2 received one S1 final JSON, contrary to expected zero. D1 retained its video and early JSON. Both directories and native JSON were read back; the failure was not inferred solely from metadata filenames.

Final native cases cover D1/D2 switch with notes and versioned early/final files, explicit subsequent manual export to D2, and S1 automatic export completing while S2 records under D2 through the enabled Start control. Hook tests cover clear retention, D1 permission loss with D2 still ready and subsequent manual export, plus replace/clear × old export success/permission/write failure. Inputs are synthetic and storage/recorder APIs are native in browser tests. Mocked hook permission failures are not a physical permission-revocation experiment.

New Computer Use is recorded separately by the parent, including any tool limitations; prior screenshots/actions are not promoted into evidence for new source. File SHA256 and canonical sample hashes are supplied in compact review receipts; full native payloads and traces stay local. Hashes do not make omitted artifacts available remotely.

R1 performance remains PARTIAL / measurement_sensitive_or_inconclusive. Media queues, complete video recovery, real-device synchronization, long-duration durability and power-loss guarantees remain outside scope. No push, merge, deploy, tag or cloud mutation is performed by this executor. Parent owns PR11 update and re-review.

## Exact final source and gates

- Review base: `0ee45e163adf15954b7163250d948bf167e1c1f7`, tree `d93766d93ca0f9cd6cb5758e4ca0a12ab273306e`. PR11 verified OPEN/DRAFT at this head before new publication.
- Tested: `d2cd9903c37fdfdfcaf499c3bbd1e1a6a059c468`, tree `c4267b8fa5e9b2792b992e23a1aedb523e470b36`, clean at check/smoke/build.
- `npm run check`: **762 tests /79 files**, typecheck and lint passed.
- `npx playwright test --config=playwright.phase2a.config.ts --output=output/playwright/phase2a-directory-binding/final-smoke`: **32/32**. Smoke BUILD_ID `g93Ixsi_cxsSl-GokkgsM`.
- Ordinary `npm run build`: exit0, BUILD_ID `Ug5KVuGzL2RqK2l5oq1iI`, analytics disabled/measurement0. Normal static JS and direct3138 HTML contain no test fixture.
- Node v25.8.1, installed Next16.3.3, React/React DOM19.2.8, Playwright1.62.1, Vitest4.1.11; unchanged lockfile hash `ea6b77a38f691ef7d6e51a36801fc3ab3aac104edc2d03ab5a67548870292f07`. Installed versions do not substitute for unobserved browser runtime versions.

Product changes touch only `hooks/use-training-session.ts`. Regressions touch the hook library tests and two existing e2e files. Parent CUA support is test-only: the existing loopback proxy and a scoped directory-control fixture. Later delivery changes are documentation/evidence only; post-commit delivery identity is recorded separately to avoid a self-referential commit hash.

See [handoff](evidence/phase2a-directory-binding/HANDOFF.md), [manifest](evidence/phase2a-directory-binding/manifest.json), [directory RED](evidence/phase2a-directory-binding/baseline-directory-red.json), [directory GREEN](evidence/phase2a-directory-binding/directory-binding-final.json) and [two-Session readback](evidence/phase2a-directory-binding/two-session-directories.json).

## Computer Use and cleanup

[Parent action receipt](evidence/phase2a-directory-binding/parent-cua.json) binds the same tested source/ordinary BUILD_ID to the new directory injection hash `41f1c8c44870883b17b1c889c49c4a61c0924534d6d531aaa5f4306de77d5350`. Actual product UI selected D1, recorded2ce24394/2169 samples (00:25), held early JSON, observed media receipt after the separate control page released the media gate, switched D2 while JSON still waited, then observed automatic-v2 written to D1 after releasing JSON. A subsequent explicit manual export showed D2. Test-control acknowledgements alone were not counted as product success; the actual product feedback was inspected after each release.

Three actual screenshots are inline only, with no PNG export. CUA did not independently enumerate files or recompute bytes/IDB payloads; that evidence remains the separate native browser tests. No business DOM/ref/state alteration, Session reseeding or original database deletion was used. Parent's [source review](evidence/phase2a-directory-binding/parent-source-review.json) is bounded and read-only, with no reviewer test rerun claimed.

Parent verified new tabs8/9 closed and left user tabs untouched. Executor verified PID/command/cwd and stopped its3138/3140 services. Prior Phase2A native reload/error-tab4 policy gaps remain in their original records; this successful new scenario does not erase them or imply a policy bypass.
