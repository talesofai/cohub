import type { GenerationContentBlock, GenerationModelDeclaration } from "@neta-art/generation";
import type { BillingPayload } from "../billing.js";
export * from "./policy.js";

export type {
  GenerateRequest,
  GenerationContentBlock,
  GenerationContentBlockMeta,
  GenerationContentSpec,
  GenerationModelDeclaration,
  GenerationParameterSpec,
  GenerationSource,
} from "@neta-art/generation";

export const GENERATION_TASK_TYPE = "generation" as const;

export type CreateGenerationTaskRequest = {
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type CreateGenerationTaskResponse = {
  taskRunId: string;
  taskType: typeof GENERATION_TASK_TYPE;
  status: "pending";
  billing?: BillingPayload | null;
};

export type GenerationTaskData = {
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type GenerationTaskResult = {
  model: string;
  output: GenerationContentBlock[];
  meta?: Record<string, unknown>;
};

export type GenerationExampleRequest = Omit<CreateGenerationTaskRequest, "spaceId">;
export type GenerationDeclaration = GenerationModelDeclaration;
export type PublicGenerationDeclaration = Omit<GenerationModelDeclaration, "adapter">;

export type ListGenerationModelsResponse = {
  models: PublicGenerationDeclaration[];
};
