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

## Current blocker: typecheck = 194 errors, ALL inside ported omo files

Taxonomy (root causes only — rest are cascades):

- TS2305 x84: omo-desktop EXTENDED @t3tools/contracts (OmoSettings,
  ThreadDag*, ThreadSteering*, ThreadActiveMonitor, ThreadGoal,
  ThreadSubagentTask ...). Absent from upstream v0.1.2 AND v0.0.33.
  -> Reconstruction source CONFIRMED: ~/.omo-app/server/resources/app.asar
  compiled chunks carry the Schema definitions (17-49 hits/symbol).
- TS2307 x27: modules not in extraction scope -> map to v0.1.2 equivalents
  or reconstruct.
- effect 3 -> 4 API drift (Schema.TaggedErrorClass -> TaggedClass etc.),
  ~200 TS377030/TS377004 any-channel cascades + renames. t3 v0.1.2 = effect@4.0.5.

## Next

1. Extract contracts chunk from asar; reconstruct omo contract extensions as
   additive packages/contracts files (omo/*.ts), re-export via index.
2. effect-4 rename pass over ported files (mechanical, error-guided).
3. Iterate pnpm typecheck -> 0.
4. Then: desktop build first (fast adapter validation), then Android
   (apps/mobile, expo prebuild --clean + gradlew assembleRelease; SDK 36).
   Rules: native omo stays 100% official; additive-only; pin v0.1.2; MIT notices
   kept; sideload only; model traffic stays VM02 -> OmniRoute.
