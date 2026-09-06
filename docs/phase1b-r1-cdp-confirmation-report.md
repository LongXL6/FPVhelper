# FPVHelper Phase 1B-R1 — CDP Increase Confirmation Without Product Changes

**Status: partial. Risk: measurement_sensitive_or_inconclusive.** Source/recording integrity passed for completed items, but mixed task directions, incomplete controls and absent formal diagnostic prevent risk closure.

## Actual scope, interruption and authorized continuation

The frozen matrix contains 32 slots: 24 main items and eight same-version controls. Original p01 A/S1/N completed; its B counterpart was interrupted after independent static review identified final-budget status and global-deadline tool gaps. The original 42.157670833-second receipt and raw data remain unchanged. A point-in-time message reported zero completed items; final cleanup showed A completed before SIGINT took effect. That correction is retained.

The coordinating task explicitly authorized only original indices 2–31 once, without replacing index1 or restarting the 30-minute budget. A separately committed continuation manifest binds the original receipt hash, original plan/child identity, retained indices and remaining exact order. It does not claim its tool corrections preceded all formal results. The absolute deadline remained **1788694765581 ms**, original start **1788692965581 ms**; repair and waiting consumed the same wall-clock allowance.

**Final 32-slot state: 29 completed, 2 failed (indices 1 and 30), 1 not run (31).** There are 11 complete main pairs (S1/N three; S1/P1 four; S2/P1 four), three complete controls (N AA/BB and P1 AA), and zero formal CPU-profile diagnostics. p01 and p16 remain incomplete and are never paired with substitute records. Index30 had started its own server/runner when the work deadline interrupted it; index31 was never started. Final global elapsed was **1780.094376 seconds**, leaving reserved cleanup time within the original 1800-second ceiling. All four original/continuation owned process groups were verified absent.

Continuation manifest SHA-256: `3d9474898770c23afdce673fa7830b0e33e30586ca0a5b602d8d38d52f238030`. Original plan SHA-256 remains `3ae6db30b3b04a296338c395d981bafcbd2cc4f153f14c4345a65b641169e7c0`.

## Exact identities

- A product: `9ab7d90b6d4a8f3eac3c0c2e7825fc6a75846b84`; tree `701d6191fac682c64d77286886e1b71d71cb9e31`.
- B product: `b6a3849df7d712e704ba340b7891c3158b54caed`; tree `1990a5e56a5ecaf78b898ba0c766240a7ce57bfb`.
- Prior delivery: `a5abe1ae7be8082b6642b2b61f0af48f18137d1e`; tree `167a22ba452e333575b72f4f8ca32695ad5efd09`. Prior tested-to-delivery changes only the supplied 111-line report.
- Formal tested driver: `f9d7da834bc2a8726a68794c0805628b170c18ba`. This is separate from the served A/B identities.
- Post-interruption tool correction: `db6cb2055fa361c44d1a2ac69b1558490bcbba2b`. It has 13 passing targeted regressions, but has **not** run a new formal batch. Continuation formally tested driver: `e5c3f7a9af4567ac56651203c5c693361a3e33ac`. Final delivery SHA is in handoff.json. f9d7da8-to-delivery includes tool fixes and reports; e5c3f7a-to-delivery is report-only.
- Frozen new parent plan SHA-256: `3ae6db30b3b04a296338c395d981bafcbd2cc4f153f14c4345a65b641169e7c0`. The frozen plan is not rewritten after formal results.
- Prior parent/child plan SHA-256: `627f333f7d94490d31cca02b8919b4746f393d4f02a4ed8b6850b661b6476ac0` / `05a64380b0338a074e63d1d821f6f52513d6da892de9ea5b274576e2d91a9283`.

| Product | Normal BUILD_ID | Profiling BUILD_ID |
| --- | --- | --- |
| A | a8gWhSSDDz8LOc-tbUctK | flDCQ0gQBK6VoqcRnCM91 |
| B | VF_8ZNwcc2RFaUVo7cekB | MMVk5Ybhfea361ESdorf4 |

Both products used the existing identical lockfile and installed dependency versions. Fresh products were built P1 then N, analytics disabled, Next telemetry disabled. Complete build file inventories bind each produced BUILD_ID. Every one of A's 243 and B's 249 tracked files was compared against its Git blob; all final product bytes match. Complete tracked-source tarballs are attached and were read back against the content proof. Dependencies, compiled build contents and Git history/object databases are not included; build inventories alone do not prove the content of those omitted build bytes to an offline reviewer.

## Retained failures and tool gates

The first A build attempt used N then P1. Next's installed type-declaration generator changed exactly two `next-env.d.ts` imports from `.next/types` to `.next-measurement/types`, triggering the clean-source guard. The original patch, failed receipt, logs and build inventories remain. After independent coordinator review, a separately logged normal recovery build restored the declaration via Next itself. A/B then used the same P1→N sequence: only the exact generated declaration state was allowed after P1; after N, every tracked byte including next-env matched Git. No HEAD was moved and no product file was manually repaired or excluded from inventory.

Exploration-01 failed before starting a server because `ps` truncated a multibyte process name and strict UTF-8 decoding failed. Original process bytes are retained locally in subsequent runs; sharing omits unrelated process names/paths. A ps snapshot is not whole-window load evidence.

Exploration-02 passed N then retained an INVALID P1 timeline at the 8 MiB cap. Exploration-03 passed three separate checks: N internal probe unavailable, P1 genuine mount/update with three CDP endpoints and CPU sampling, and S2/P1 synthetic recording/JSON/video-receipt reconciliation. The CPU profile has 3,745 samples and 225,303 encoded bytes; it is a preflight profile, not a formal diagnostic. CPU sampling was selected and frozen before formal launch. Its interval is 1,000 microseconds; it is not a full task/GC/layout timeline or causal attribution.

Before formal launch, `npm run check` passed typecheck, 742 tests and lint; 10 targeted Python regressions passed. After interruption, 13 targeted regressions passed, including final-budget fail-closed state, cleanup time reservation, synchronous alarm interruption and owned process cleanup. The subsequently frozen continuation at e5c3f7a additionally binds the external build receipt to frozen root/SHA/tree/BUILD_ID/inventory hashes, and tests actual CPU-profile byte/sample validation branches. It passed 14 Python tests, one CPU-profile Vitest, typecheck and the permitted continuation. A post-run full check passed 743 tests/typecheck/lint.

## Recomputed historical evidence

The independent standard-library recalculation read all 18 original compressed records and verified their hashes. It reproduced S1/P1 task B−A of **+0.319967, +3.013100, +0.956139 percentage points**, mean **+1.429735**; S2/P1 **−3.805426, −15.248162, +3.600301**; S2/N **−2.692317, −5.171949, −3.660031**. S2/P1 recording callbacks per actual RC fell about 46% in each pair; workbench callbacks/s did not fall. These remain historical observations and do not replace missing S1/N or same-version controls.

Old source and server events demonstrate conditional arm/mode service reuse. New frozen policy restarts each service/browser/context, including controls. Old records do not establish OS cache/thermal state, host idleness, GC causation or a separated steady/drain CDP window. No old metric is retroactively filled.


## Every complete pair

Task differences below are percentage points. Main pairs use B−A regardless of execution order; controls use second−first with the same source and build. Each ratio uses its own CDP Timestamp denominator. Full is recomputed from first/last endpoints, never the mean/sum of subinterval percentages. All A/B absolute values, Script/Layout/Task seconds and ratios, actual RC rates, raw three-endpoint brackets and per-boundary Profiler are supplied in combined-report.json and raw files.

| Pair | Condition | Order | Steady task Δ pp | Drain task Δ pp | Full task Δ pp |
| --- | --- | --- | ---: | ---: | ---: |
| p02 | S1-100/P1 | BA | -2.230171 | -0.365713 | -1.986588 |
| p03 | S2/P1 | AB | -3.474934 | -7.178047 | -3.957528 |
| p04 | S1-100/N control | AA | +2.542415 | +1.360868 | +2.388166 |
| p05 | S2/P1 | BA | -4.067880 | -0.342133 | -3.582054 |
| p06 | S1-100/N | BA | +1.040205 | -0.670923 | +0.817223 |
| p07 | S1-100/P1 | AB | -3.289426 | -0.452187 | -2.918986 |
| p08 | S1-100/P1 control | AA | +0.396896 | +2.032205 | +0.609893 |
| p09 | S1-100/P1 | AB | +0.465300 | +1.915526 | +0.654479 |
| p10 | S2/P1 | BA | -5.354538 | -3.805716 | -5.152753 |
| p11 | S1-100/N | BA | +0.710893 | +7.675526 | +1.619184 |
| p12 | S1-100/N control | BB | -0.557882 | -9.618042 | -1.740148 |
| p13 | S1-100/N | AB | -3.338331 | -0.258028 | -2.936457 |
| p14 | S2/P1 | AB | -5.037327 | -1.258713 | -4.544552 |
| p15 | S1-100/P1 | BA | -2.094372 | -7.646484 | -2.818441 |

| Main condition | Complete pairs | Positive / negative | Median Δ pp | Range Δ pp |
| --- | ---: | --- | ---: | --- |
| S1-100/N | 3 | 2 / 1 | +0.817223 | -2.936457 to +1.619184 |
| S1-100/P1 | 4 | 1 / 3 | -2.402515 | -2.918986 to +0.654479 |
| S2/P1 | 4 | 0 / 4 | -4.251040 | -5.152753 to -3.582054 |

S1/N has two positive and one negative complete pair; its original AB first pair is missing, so the completed subset is not the balanced four-pair matrix. S1/P1 has one positive and three negative pairs, across the planned two AB/two BA orders; the original three-of-three positive direction did not recur uniformly. S2/P1 has four negative pairs. These short repeats describe this batch, not statistical no-regression proof.

The sole positive S1/P1 pair p09 has steady +0.465300 pp and drain +1.915526 pp. N p11 has steady +0.710893 pp and drain +7.675526 pp. Thus the positive signs are not exclusively drain effects, although interval composition matters. N controls themselves differ by +2.388166 pp (AA) and −1.740148 pp (BB), and P1 AA by +0.609893 pp; absolute differences are 2.388166, 1.740148 and 0.609893 pp. One control pair per cell cannot establish a noise bound, and similarity to a main-pair difference does not prove noise.

Actual main-run delivery rates span S1/N 86.219823–87.578543 Hz, S1/P1 85.512802–87.037815 Hz and S2/P1 82.760275–84.963466 Hz. The unpaired original A/S1/N delivered 1743 frames at87.133009Hz and full task27.575240%; it is retained but excluded from paired summaries. N internal metrics remain unavailable. S2 recording callbacks/RC decreased approximately45.88–46.76%; nested durations are never summed and callbacks are not FPS. Raw and session/file receipts passed for all completed S2 items.

**Diagnostic gap:** p09 meets the frozen positive full-CDP-task trigger for S1/P1, but the original deadline was exhausted before formal diagnostic execution. S2/P1 has no positive complete pair. Zero formal profiles were collected; the exploration-03 CPU profile is not substituted as formal attribution. Cause remains unlocated; no product fix or minimal rollback is justified from this evidence alone.

## All 32 original slots

| Index | Pair | Product / mode | Status |
| ---: | --- | --- | --- |
| 0 | p01 | A S1-100/N | completed |
| 1 | p01 | B S1-100/N | failed |
| 2 | p02 | B S1-100/P1 | completed |
| 3 | p02 | A S1-100/P1 | completed |
| 4 | p03 | A S2/P1 | completed |
| 5 | p03 | B S2/P1 | completed |
| 6 | p04 | A S1-100/N | completed |
| 7 | p04 | A S1-100/N | completed |
| 8 | p05 | B S2/P1 | completed |
| 9 | p05 | A S2/P1 | completed |
| 10 | p06 | B S1-100/N | completed |
| 11 | p06 | A S1-100/N | completed |
| 12 | p07 | A S1-100/P1 | completed |
| 13 | p07 | B S1-100/P1 | completed |
| 14 | p08 | A S1-100/P1 | completed |
| 15 | p08 | A S1-100/P1 | completed |
| 16 | p09 | A S1-100/P1 | completed |
| 17 | p09 | B S1-100/P1 | completed |
| 18 | p10 | B S2/P1 | completed |
| 19 | p10 | A S2/P1 | completed |
| 20 | p11 | B S1-100/N | completed |
| 21 | p11 | A S1-100/N | completed |
| 22 | p12 | B S1-100/N | completed |
| 23 | p12 | B S1-100/N | completed |
| 24 | p13 | A S1-100/N | completed |
| 25 | p13 | B S1-100/N | completed |
| 26 | p14 | A S2/P1 | completed |
| 27 | p14 | B S2/P1 | completed |
| 28 | p15 | B S1-100/P1 | completed |
| 29 | p15 | A S1-100/P1 | completed |
| 30 | p16 | B S1-100/P1 | failed |
| 31 | p16 | B S1-100/P1 | not_run |

## Actual Computer Use

`mcp__cua_repl.js` created and operated an owned in-app browser tab. On the exact B ordinary build at loopback port 3134 it dismissed first-use checks, entered synthetic alias `R1-CUA-SYNTHETIC`, navigated to training records and scrolled to visibly verify the empty library and disconnected bridge readiness. It never invoked a device, camera, directory picker or recording. Separate local evidence-page buttons showed the old S1/P1 and S2/P1 tables. Five actual screenshots were displayed inline in this execution task's Computer Use tool results; their PNG bytes were not exported into the package. `preflight/computer-use.json` records actions, target BUILD_ID and this attachment limitation. No substitute automation screenshot is presented as Computer Use evidence. Owned pages/services were closed before performance tools.


## Resources, delivery and end boundary

At original freeze cumulative retained evidence was155841724bytes. At final continuation cleanup it was183942025bytes, including all historical, failed, interrupted and exploratory evidence. Final manifests add actual packaging totals. Installed dependencies and compiled build footprint are reported separately under the original retained-evidence budget scope. Event/fixture/encoded-byte and CDP heap limits are not peak-memory guarantees; peak remains unknown.

Sharing excludes raw host process-list bytes and removes unrelated process names/paths from JSON snapshots; original bytes stay local and original/shared hashes map each transformation. Full tracked A/B source tarballs are supplied and verified against Git blobs. Build bytes, dependencies, Git object databases, MP4 files and original Computer Use PNG bytes are not attached; omissions are explicit. The retained preflight truncated timeline is INVALID and remains bounded, not a parseable diagnostic. The valid preflight CPU profile remains Chrome-readable after sharing redaction.

No push, PR, merge, deploy, Promote, tag, cloud/database operation, real device or user media access occurred. Only authorized coordination messages were sent. RC persistence waiting for video, unbounded video queue, whole-vision-history rewrite, hardware/endurance/physical synchronization and media cleanup limits remain open.

**One next step:** return this partial package to ChatGPT/coordination for independent review and a decision on the missing S1/P1 diagnostic. Do not automatically start another batch, optimize, revert products or publish.
