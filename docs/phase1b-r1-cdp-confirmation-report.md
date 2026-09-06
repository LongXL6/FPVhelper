# FPVHelper Phase 1B-R1 — CDP Increase Confirmation Without Product Changes

Status: **partial**. Risk classification: **measurement_sensitive_or_inconclusive**. The bounded confirmation was interrupted for independently identified measurement-tool guard gaps; it did not complete the matrix and does not close the prior CDP increase risk.

## Actual result and stopping point

Run `formal-r1-b6a3849-20260906-01` planned 32 items: 24 A/B items across S1-100/N, S1-100/P1 and S2/P1, plus eight same-version control items. Each main condition had two AB and two BA pairs. Each S1 mode had one AA and one BB pair. Up to four CPU-profile diagnostic items were conditional on positive P1 full-interval task differences after all 32 valid items.

The actual formal batch contains **one completed item (index 0, A/S1-100/N), one interrupted item (index 1, B/S1-100/N), and 30 unattempted items**. There are **zero complete A/B pairs, zero complete same-version controls and zero formal diagnostic items**. The orchestration receipt reports 42.157670833 seconds. A point-in-time progress message initially observed zero completed items; the final cleanup receipt supersedes that snapshot because index 0 completed before the interrupt took effect. The first result is retained, not relabelled exploratory. No replacement run or fresh 30-minute budget was started.

The interruption occurred when the coordinating task's static review arrived after formal launch: the tested wrapper could leave `needs_review` after a final-budget exception and did not bound all synchronous verification/finalization work with the global deadline. This is a tool-gate failure, not an observed product defect. The actual retained receipt is partial/nonzero after SIGINT. Owned runner PID 72182 and server PID 72180 both have confirmed absent process groups. Process exit is not proof of product media track.stop, write cancellation or zero tail loss.

## Exact identities

- A product: `9ab7d90b6d4a8f3eac3c0c2e7825fc6a75846b84`; tree `701d6191fac682c64d77286886e1b71d71cb9e31`.
- B product: `b6a3849df7d712e704ba340b7891c3158b54caed`; tree `1990a5e56a5ecaf78b898ba0c766240a7ce57bfb`.
- Prior delivery: `a5abe1ae7be8082b6642b2b61f0af48f18137d1e`; tree `167a22ba452e333575b72f4f8ca32695ad5efd09`. Prior tested-to-delivery changes only the supplied 111-line report.
- Formal tested driver: `f9d7da834bc2a8726a68794c0805628b170c18ba`. This is separate from the served A/B identities.
- Post-interruption tool correction: `db6cb2055fa361c44d1a2ac69b1558490bcbba2b`. It has 13 passing targeted regressions, but has **not** run a new formal batch. The final delivery commit is supplied in `handoff.json`; tested-to-delivery includes tool corrections and this report, not only a report.
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

Before formal launch, `npm run check` passed typecheck, 742 tests and lint; 10 targeted Python regressions passed. After interruption, 13 targeted regressions passed, including final-budget fail-closed state, cleanup time reservation, synchronous alarm interruption and owned process cleanup. The post-interruption wrapper has not been validated by a new end-to-end formal run.

## Recomputed historical evidence

The independent standard-library recalculation read all 18 original compressed records and verified their hashes. It reproduced S1/P1 task B−A of **+0.319967, +3.013100, +0.956139 percentage points**, mean **+1.429735**; S2/P1 **−3.805426, −15.248162, +3.600301**; S2/N **−2.692317, −5.171949, −3.660031**. S2/P1 recording callbacks per actual RC fell about 46% in each pair; workbench callbacks/s did not fall. These remain historical observations and do not replace missing S1/N or same-version controls.

Old source and server events demonstrate conditional arm/mode service reuse. New frozen policy restarts each service/browser/context, including controls. Old records do not establish OS cache/thermal state, host idleness, GC causation or a separated steady/drain CDP window. No old metric is retroactively filled.

## Only completed new formal item

A/S1-100/N delivered 1,743 cohort RC frames over its actual page window, **87.133009 Hz**. Raw reconciliation passed. N Profiler/internal metrics remain null/unavailable.

| CDP interval | Timestamp seconds | Task seconds | Task percent | Script seconds | Layout seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Steady | 20.006376 | 5.614047 | 28.061289 | 2.432535 | 0.372083 |
| Drain | 3.001340 | 0.730386 | 24.335330 | 0.324823 | 0.050351 |
| Full | 23.007716 | 6.344433 | 27.575240 | 2.757358 | 0.422434 |

Each ratio uses its own CDP endpoint Timestamp denominator. Full is recomputed from first/last endpoints, not a mean or sum of percentages. Script/Layout ratios and all raw endpoint dictionaries are in report.json. CDP target session/timeTicks settings and runner/page call brackets are retained; boundaries are not simultaneous and different realms' performance.now are never subtracted. These are renderer counters, not host CPU. This unpaired A result cannot classify the B increase as reproduced, absent, noise or a product regression.

## Actual Computer Use

`mcp__cua_repl.js` created and operated an owned in-app browser tab. On the exact B ordinary build at loopback port 3134 it dismissed first-use checks, entered synthetic alias `R1-CUA-SYNTHETIC`, navigated to training records and scrolled to visibly verify the empty library and disconnected bridge readiness. It never invoked a device, camera, directory picker or recording. Separate local evidence-page buttons showed the old S1/P1 and S2/P1 tables. Five actual screenshots were displayed inline in this execution task's Computer Use tool results; their PNG bytes were not exported into the package. `preflight/computer-use.json` records actions, target BUILD_ID and this attachment limitation. No substitute automation screenshot is presented as Computer Use evidence. Owned pages/services were closed before performance tools.

## Delivery boundaries and next step

At freeze, cumulative retained evidence was 155,841,724 bytes, including historical roots and failed/exploratory runs. Reserved formal, optional diagnostic and sharing allowances projected 258,950,588 bytes below the 262,144,000-byte limit. Final manifests record actual retained and package bytes. Installed dependencies and build footprint are separately inventoried; the evidence limit follows the original retained-artifact scope. Encoded buffers, event counts and CDP heap endpoints are not peak-memory guarantees; peak remains unknown.

No push, PR, merge, deploy, Promote, tag, cloud/database changes, real hardware or user media use occurred. Only authorized coordination messages were sent to the original task. Raw RC final persistence waiting on video, unbounded video queue, whole-vision-history rewrite, long-duration/resource/hardware and physical synchronization risks remain open.

**One next step:** independent review of this partial package and the post-interruption tool fixes, with an explicit decision on whether to authorize a new bounded confirmation run. Do not infer permission to restart, optimize, revert products or publish from this delivery.
