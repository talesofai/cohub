import type { CohubHttpClient, ParsedWorkRef, WorkGetResponse } from "@neta-art/cohub";
import { formatWorkRef, parseWorkRef } from "@neta-art/cohub";

export type { ParsedWorkRef };
export { formatWorkRef, parseWorkRef };

export function getWorkByRef(client: CohubHttpClient, input: string): Promise<WorkGetResponse> {
  const ref = parseWorkRef(input);
  return "id" in ref
    ? client.works.get(ref.id)
    : client.works.getBySlug(ref.username, ref.spaceSlug, ref.workSlug);
}
