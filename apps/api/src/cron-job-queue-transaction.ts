export async function runCronJobQueueTransaction<Result, RollbackPlan>(
  execute: (registerRollback: (plan: RollbackPlan) => void) => Promise<Result>,
  compensate: (plan: RollbackPlan) => Promise<void>,
  onCompensationError: (error: unknown) => void,
) {
  let rollbackPlan: RollbackPlan | undefined;
  try {
    return await execute((plan) => {
      rollbackPlan = plan;
    });
  } catch (error) {
    if (rollbackPlan !== undefined) {
      try {
        await compensate(rollbackPlan);
      } catch (compensationError) {
        onCompensationError(compensationError);
      }
    }
    throw error;
  }
}
