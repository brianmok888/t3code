// Port reconstruction (omo fork): omo-desktop's Services/ServerProvider.ts did
// not survive the bundle extraction. Shape derived from the ported
// makeManagedServerProvider `satisfies ServerProviderShape` return. Upstream
// v0.1.2 equivalent is ManagedServerProvider (provider-core/server/snapshot);
// the omo-era member set is preserved here for fidelity.
import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
