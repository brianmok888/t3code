import type { OmoSharedProcess } from "./omoRpcConnection.ts";

export const omoSharedProcessOf = (adapter: unknown): OmoSharedProcess | undefined => {
  if (typeof adapter !== "object" || adapter === null) return undefined;
  const shared = (adapter as { readonly sharedProcess?: unknown }).sharedProcess;
  if (typeof shared !== "object" || shared === null) return undefined;
  const candidate = shared as Partial<OmoSharedProcess>;
  return candidate.request === undefined ||
    candidate.records === undefined ||
    candidate.refresh === undefined
    ? undefined
    : (shared as OmoSharedProcess);
};
