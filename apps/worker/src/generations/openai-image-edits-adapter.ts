import {
  GenerationProviderError,
  GenerationValidationError,
  type GenerationAdapterInput,
  type GenerationContentBlock,
} from "@neta-art/generation";

const REQUEST_TIMEOUT_MS = 300_000;

type OpenAiImagesResponse = {
  data?: Array<{ url?: unknown; b64_json?: unknown; revised_prompt?: unknown }>;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function mergeText(content: GenerationContentBlock[]): string {
  return content
    .filter((block): block is Extract<GenerationContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function firstUrlImage(content: GenerationContentBlock[]): string {
  const image = content.find(
    (block): block is Extract<GenerationContentBlock, { type: "image" }> => block.type === "image",
  );
  if (!image) throw new GenerationValidationError("Source image is required");
  if (image.source.type !== "url") throw new GenerationValidationError("This image edit model only supports image URLs");
  return image.source.url;
}

export async function openAiImageEditsAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const prompt = mergeText(input.request.content);
  if (!prompt) throw new GenerationValidationError("Edit instruction is required");

  const body = new FormData();
  body.set("model", input.declaration.model);
  body.set("prompt", prompt);
  body.set("image", firstUrlImage(input.request.content));
  for (const [key, value] of Object.entries(input.parameters)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.context.fetch(joinUrl(input.context.baseUrl, "/v1/images/edits"), {
      method: "POST",
      headers: { Authorization: `Bearer ${input.context.apiKey}` },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => response.statusText);
    throw new GenerationProviderError("Image edit provider request failed", { status: response.status, body: bodyText });
  }

  const raw = (await response.json()) as OpenAiImagesResponse;
  const output: GenerationContentBlock[] = [];
  for (const item of raw.data ?? []) {
    if (typeof item.url === "string" && item.url) output.push({ type: "image", source: { type: "url", url: item.url } });
    if (typeof item.b64_json === "string" && item.b64_json) {
      output.push({ type: "image", source: { type: "base64", mediaType: "image/png", data: item.b64_json } });
    }
    if (typeof item.revised_prompt === "string" && item.revised_prompt.trim()) {
      output.push({ type: "text", text: item.revised_prompt, meta: { role: "revised_prompt" } });
    }
  }
  if (output.length === 0) throw new GenerationProviderError("Image edit returned no output", { details: raw });
  return output;
}
