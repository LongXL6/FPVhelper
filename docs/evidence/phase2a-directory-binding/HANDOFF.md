# Phase 2A-R1 directory binding handoff

Run `phase2a-directory-binding-20260906-01`; **needs_review**. DIRECTORY-01: **confirmed/fixed locally**.

Read [the report](../../phase2a-directory-binding-report.md), [machine-readable handoff](handoff.json), [manifest](manifest.json), [baseline RED](baseline-directory-red.json), [final D1/D2 readback](directory-binding-final.json) and [S1/S2 readback](two-session-directories.json).

Review base is PR11 head `0ee45e163adf15954b7163250d948bf167e1c1f7`. New tested source is `d2cd9903c37fdfdfcaf499c3bbd1e1a6a059c468`, tree `c4267b8fa5e9b2792b992e23a1aedb523e470b36`: 762/79 unit checks with typecheck/lint, 32/32 full smoke and ordinary build passed. Ordinary BUILD_ID `Ug5KVuGzL2RqK2l5oq1iI`; smoke `g93Ixsi_cxsSl-GokkgsM`.

Only the Session hook changes product behavior. It binds queued automatic export to the stop-time directory, keeps manual action-time choice, explains clear retention, and prevents old directory/storage feedback from changing D2/S2 state. Regression and scoped CUA fixture changes are separately listed in JSON. No schema/DB version/serialized handle/background queue is added.

Old Phase2A dac06ff756/30 and CUA evidence are retained unchanged. This run retains the directory RED, S2 error RED, and first candidate's30/31 smoke failure; the full/crop test now waits for actual metadata/export transactions before the original assertions. New native file SHA256 values and sample hashes describe specifically named bytes, without claiming omitted media/traces are in GitHub.

[Parent Computer Use](parent-cua.json) observed new record2ce24394/2169 samples, actual D1→D2 selection, automatic-v2 to D1 and later explicit manual export to D2. This is UI/action evidence; native file enumeration/bytes/hash are independently established by the automated tests. Three screenshots are inline only, with no exported PNG bytes. [Parent source review](parent-source-review.json) closed the identified code chains but did not rerun tests. New owned tabs8/9 were closed and both owned servers stopped after PID/cwd verification; prior error-tab4 restriction remains. Exact delivery SHA/tree and tested-to-delivery patch are recorded after the final documentation commit in local `output/playwright/phase2a-directory-binding/handoff/delivery.json`, then sent to parent for its PR description; this avoids self-reference in a tracked commit.

Parent owns the existing private PR11 update and re-review. Executor makes no push, merge, release, deployment, tag or cloud mutation. R1 performance remains PARTIAL; media queue, full video recovery, hardware/long-duration/power-loss guarantees remain open. Stop at review handoff.
