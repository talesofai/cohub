# Generations

Cohub generations provide a small task-based multimodal generation API. Model declarations are loaded from `.cohub/generations` and use the `@neta-art/generation` declaration schema.

## API

```http
GET  /api/models?modelType=multimodal
POST /api/generations
```

`POST /api/generations` accepts:

```ts
type CreateGenerationTaskRequest = {
  spaceId: string;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
```

`content` contains the prompt and any reference media:

```ts
type GenerationSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

type GenerationContentBlock =
  | { type: "text"; text: string; meta?: Record<string, unknown> }
  | { type: "image"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "video"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "audio"; source: GenerationSource; meta?: Record<string, unknown> };
```

The API queues a generation task and returns a task ID. Use task polling, or the SDK / CLI helpers, to wait for the final `GenerationTaskResult`.

## Declarations

Generation declarations live in:

```txt
.cohub/generations/*.yaml
```

Platform declarations are loaded from `platform/.cohub/generations`, and user declarations from `users/<userId>/.cohub/generations`. User declarations override platform declarations with the same `model`.

Declarations use `neta.generation.model.v1`. Adapter credentials and provider base URLs are not stored in model declarations. Worker execution uses `NETA_ROUTER_API_KEY`, while provider routing defaults are handled by `@neta-art/generation`.

Minimal shape:

```yaml
schema: neta.generation.model.v1
model: gpt-image-2
title: GPT Image 2
description: Image generation with optional reference images.

adapter:
  type: openai.images

content:
  input:
    - type: text
      required: true
      min: 1
      merge: newline
    - type: image
      max: 16
      sources: [url, base64]

parameters:
  size:
    type: string
    optional: true
    default: 1024x1024
  quality:
    type: string
    optional: true
    default: auto
    enum: [auto, low, medium, high]
```

See the full examples:

- [`docs/examples/generations/gpt-image-2.yaml`](./examples/generations/gpt-image-2.yaml)
- [`docs/examples/generations/z-image-turbo.yaml`](./examples/generations/z-image-turbo.yaml)
- [`docs/examples/generations/qwen-image-edit.yaml`](./examples/generations/qwen-image-edit.yaml)
- [`docs/examples/generations/gemini-3.1-flash-image-preview.yaml`](./examples/generations/gemini-3.1-flash-image-preview.yaml)
- [`docs/examples/generations/seedance-2-0-fast.yaml`](./examples/generations/seedance-2-0-fast.yaml)
- [`docs/examples/generations/seedance-2-0.yaml`](./examples/generations/seedance-2-0.yaml)
- [`docs/examples/generations/suno_music.yaml`](./examples/generations/suno_music.yaml)

## CLI

```bash
cohub models ls --model-type multimodal

cohub generate "a cyberpunk cat in neon rain" \
  --model gpt-image-2 \
  --param size=1024x1024 \
  --param quality=high

cohub generate "a clean product-style image of a small red toy robot" \
  --model z-image-turbo \
  --param 'size=1024*1024'

cohub generate "change the background to a clean white studio backdrop" \
  --model qwen-image-edit \
  --image https://example.com/input.png \
  --param size=1024x1024

cohub generate "same character, smiling" \
  --model gpt-image-2 \
  --image ./character.png \
  --param quality=high \
  --json

cohub generate "a vibrant infographic explaining photosynthesis" \
  --model gemini-3.1-flash-image-preview \
  --param aspect_ratio=16:9 \
  --param image_size=1K

cohub generate "a cat playing piano in a cozy jazz club" \
  --model seedance-2-0-fast \
  --param duration=5 \
  --param resolution=720p

cohub generate "uplifting cinematic pop with warm piano and clear chorus" \
  --model suno_music \
  --param operation=music \
  --meta '{"title":"Warm Horizon","tags":"cinematic pop, warm piano","make_instrumental":false}'

cohub generate "write a hopeful chorus about sunrise after a storm" \
  --model suno_music \
  --param operation=lyrics
```
