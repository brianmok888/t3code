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

## Current blocker: typecheck = 753 errors, ALL inside ported omo files

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
