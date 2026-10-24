const AMBIENT_OMO_SELECTOR_NAMES = [
  "SENPI_BRAND",
  "OMO_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

export const makeOmoChildEnvironment = (
  ambient: NodeJS.ProcessEnv,
  configured: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => {
  const child = { ...ambient };
  for (const name of AMBIENT_OMO_SELECTOR_NAMES) delete child[name];
  return { ...child, ...(configured ?? {}) };
};
