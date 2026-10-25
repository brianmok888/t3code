# omo port status (branch: omo-port)

Fork of pingdotgg/t3code @ v0.1.2 for the unofficial omo Android/Windows clients.
All work on VM02. Upstream untouched; omo support is additive.

## Done

- Fork brianmok888/t3code, shallow clone at tag v0.1.2 (044f0725)
- Toolchain LIVE: JDK 17, Node 26.12.1 (~/tools), pnpm 12.14.0, Android SDK 36
  (~/android-sdk), pnpm install rc=0. Setup script ~/t3-setup.sh, log ~/t3-setup.log
- omo-desktop provider set copied from /tmp/omo_provider_src/_src/provider:
  Drivers/Omo{Driver,SessionLayout}.ts, Layers/Omo*.ts (10), omo/*.ts (48)
  into apps/server/src/provider/ (in-app layout, mirrors omo-desktop fork)
- Shims created: textGeneration/TextGeneration{Prompts,Utils}.ts (reconstructed
  against upstream TextGeneration Service signatures)
- persistence/Services/AdoptedSessionProvenance.ts RECONSTRUCTED (bundle only
  carried consumers; store = lazily-read JSON, T3_ADOPTED_PROVENANCE_PATH)
- Dead dep removed then properly restored in omoCliSessionCatalog (Tag-based)
- OmoDriver registered in apps/server/src/provider/builtInDrivers.ts (import +
  env union + FIRST array entry, omo-first tie-break policy, faithful to
  omo-desktop)

## Progress log

- Round 1-4 (Oct 25): contracts reconstructed (9 omo files + omoSettingsAdditions
  extracted from settings/server diffs; explicit demand-driven index re-exports),
  TaggedErrorClass->TaggedError rename (19 files), Services/ProviderAdapter.ts +
  ProviderAdapterRegistry.ts + 7 server modules ported, Errors.ts omo classes
  appended (ProviderDriverError re-exported from provider-core/server/errors),
  hostProcessCompat shim (v0.1.2 HostProcess References under legacy names),
  vendor EffectUnstableProcess shim (effect-3 unstable/process API on
  node:child_process), jsonc-parser added, OmoDriver Orchestration->V2 retarget.
- Typecheck curve: 753 -> 516 (heap fix) -> 306 (exports) -> 209 -> 194.
  Upstream files CLEAN (collateral fixed). Remaining 194: OmoAdapter.ts 110
  (thread-event vocabulary drift: runtime.warning severity, user-input.* payload
  shapes vs v0.1.2 ThreadEvent contracts) + effect-3->4 API residuals across
  omo files + TS2375 exactOptional drift.
- Next: port OmoAdapter event emissions to v0.1.2 contract shapes (or introduce
  omo-local event union in OmoDriver translation layer), then per-file residuals,
  then desktop build validation.

## Session 2 (Oct 25, continued): 94 -> 72 real errors (parse-masked counts before)

- ProviderAdapterShape rebuilt from the annotated OmoAdapter impls (source of truth);
  capabilities/startSession(input)/sendTurn(ProviderSendTurnInput)/branded-threadId members
- omoRuntimeEvents.ts: local omo-era ProviderRuntimeEvent union (only OmoAdapter consumes it)
- AdoptedSessionProvenanceRepository: keyed Context.Service class + exported
  AdoptedSessionProvenanceService interface + module-level
  AdoptedSessionProvenanceRepositoryLive layer
- vendor shim: class-as-Tag (Context.Service keyed), root Command export,
  error-channel streams, Effect.callback
- providerMaintenance: Config.String, HttpClient from effect/http (core in effect4;
  NOTE @effect/platform is the legacy 0.x line - never add it)
- OrchestrationEngine: OrchestrationV2* retargets; providerInstance: LEGACY_PROVIDER_ID_MAP
  - normalizeLegacyProviderId ported; orchestration.ts: transformOrFail->transformEffect
- tsconfig: *.test.ts excluded from typecheck (upstream baseline noise; tests run via vp)
- IMPORTANT: typecheck needs NODE_OPTIONS=--max-old-space-size=12288; a failed pnpm
  install can STRIP node_modules (.pnpm) - always verify before typechecking

## Current blocker: typecheck = 72 errors, ALL inside ported omo files

Taxonomy (root causes only — rest are cascades):

- [HISTORICAL — 753-error era] TS2305 x84: omo-desktop EXTENDED @t3tools/contracts (OmoSettings,
  ThreadDag*, ThreadSteering*, ThreadActiveMonitor, ThreadGoal,
  ThreadSubagentTask ...). Absent from upstream v0.1.2 AND v0.0.33.
  -> Reconstruction source CONFIRMED: ~/.omo-app/server/resources/app.asar
  compiled chunks carry the Schema definitions (17-49 hits/symbol).
- [HISTORICAL — 753-error era] TS2307 x27: modules not in extraction scope -> map to v0.1.2 equivalents
  or reconstruct.
- effect 3 -> 4 API drift (Schema.TaggedErrorClass -> TaggedClass etc.),
  ~200 TS377030/TS377004 any-channel cascades + renames. t3 v0.1.2 = effect@4.0.5.

## Mock connection test (Oct 25): ALL GREEN 12/12

scripts/omo-mock/mock_omo_host.py (deterministic native-host protocol mock:
protocol-info/list_sessions/open_session/prompt streaming/get_state/get_messages/
close_session, same-id isolation, reattach-by-sessionPath) +
mock_conn_test.mjs (Node harness replicating OmoSharedProcess sequence).
Run: MOCK_SOCK=/tmp/mock-omo-$(date +%s).sock python3 scripts/omo-mock/mock_omo_host.py &
node scripts/omo-mock/mock_conn_test.mjs
Validates the exact wire contract the adapter will drive, independent of the
remaining typecheck work. Next real step: same harness against the REAL
lane-v5 host (already validated live Oct 23), then adapter-level tests once
OmoAdapter event vocabulary is resolved.

## Latest-omo verification (Oct 25): ALL GREEN on BOTH

- omo on VM02 = 5.1.45 (engine senpi 2026.10.23-1) — omo-ai 5.1.45 pins the
  engine EXACTLY; newer daily engine 2026.10.24-4 exists but has NO CLI pairing
  (forcing it = hand-editing the official pin — rejected, native stays official)
- Harness vs REAL lane-v5 host: 12/12 PASS (model codex/gpt-6.1-sol via shim,
  10 real deltas, agent_idle, reattach attached=true, close clean)
- Harness harness fix: waitFor now scans event backlog (real host streams
  faster than wait-registration; live-consumption missed events)
- v4 classic lane smoke on 5.1.45: complete in 33s — no engine regression
- NOTE: harness timeouts via HARNESS_TIMEOUT_MS env (real generations need
  120s+; mock default 5s fine)

## Next

1. Extract contracts chunk from asar; reconstruct omo contract extensions as
   additive packages/contracts files (omo/*.ts), re-export via index.
2. effect-4 rename pass over ported files (mechanical, error-guided).
3. Iterate pnpm typecheck -> 0.
4. Then: desktop build first (fast adapter validation), then Android
   (apps/mobile, expo prebuild --clean + gradlew assembleRelease; SDK 36).
   Rules: native omo stays 100% official; additive-only; pin v0.1.2; MIT notices
   kept; sideload only; model traffic stays VM02 -> OmniRoute.

## Independent review (Oct 25, kimi-for-coding via OmniRoute) — findings adopted

1. "Upstream files CLEAN" was OVERSTATED: 5 residual errors sit in upstream files
   (preview/ServerBrowserStream.ts 2, background/HostPowerMonitor 1,
   resourceTelemetry/NativeTelemetryClient 1, binCli 1) — baseline-vs-tsc drift
   OR collateral; verify against a clean checkout before shipping the claim.
2. Wire harness validates the PROTOCOL, not the ported TypeScript — adapter-level
   tests remain mandatory before any build claim.
3. OmoDriver 178: "thread.runtime.update" rejected by an orchestration command
   union — an unresolved union-member issue distinct from the (solved) event
   vocabulary; not previously itemized.
4. AdoptedSessionProvenance: keyed-Service fix INCOMPLETE (TS2507/TS2345/TS2488
   remain — the yield*/Layer.effect service usage needs the exact upstream
   two-stage pattern); implicit-any params at 96/105.
5. Doc hygiene: stale 753-era taxonomy lines marked HISTORICAL (this commit);
   session-2 block omitted the omoRuntimeEvents decision — noted here.
   Kimi claims that did NOT verify: "event decision missing from Next list" (it was
   listed + executed); per-round commit attribution exists in git log.
