import { HttpError } from "@neta-art/cohub";

const RETRYABLE_SUBMISSION_STATUSES = new Set([408, 502, 503, 504]);

function isAmbiguousSubmissionError(error: unknown) {
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  return error instanceof HttpError && RETRYABLE_SUBMISSION_STATUSES.has(error.status);
}

export async function submitWithIdempotentRetry<T>(
  submit: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
) {
  try {
    return await submit();
  } catch (error) {
    if (!isAmbiguousSubmissionError(error)) throw error;
    await wait(150);
    return submit();
  }
}
