export const canonicalizeCronJobIdentity = <T extends { userUuid: string }>(
  job: T,
  canonicalUserId: string,
): T => ({ ...job, userUuid: canonicalUserId });
