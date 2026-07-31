type SystemInstructionsSession = {
  configureSystemInstructions(instructions?: string | null): Promise<void>;
};

export async function activateTurnSystemInstructions(
  session: SystemInstructionsSession,
  instructions?: string | null,
) {
  await session.configureSystemInstructions(instructions);
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    await session.configureSystemInstructions(null);
  };
}
