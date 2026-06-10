const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(value), min), max);

export const clampAsrEndWindowSizeMs = (value: number) =>
  clamp(value, 200, 3000);

export const clampAsrForceToSpeechTimeMs = (value: number) =>
  clamp(value, 1, 10_000);
