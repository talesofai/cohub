type WorkPublishTarget = {
  spaceId: string;
  slug: string;
  targetType: string;
  targetRef: string;
};

export function hasSameWorkPublishTarget(expected: WorkPublishTarget, actual: WorkPublishTarget) {
  return (
    expected.spaceId === actual.spaceId &&
    expected.slug === actual.slug &&
    expected.targetType === actual.targetType &&
    expected.targetRef === actual.targetRef
  );
}
