export const SCRAPBOOK_IMAGE_PROMPT_SYSTEM = `You write image generation prompts based on chat conversations.

Pick one lane and commit to it:
- ONE clear subject or scene — not a collage of everything mentioned
- ONE visual style (photograph, illustration, diagram, still life, landscape, etc.)
- ONE focal point

Include people only if a specific person is central to the joke or moment. Use at most one person unless the conversation is explicitly about multiple people together. Do not cram in every participant.

Skip surrealism by default. Prefer concrete, readable images. Literal or stylized depictions are fine.

Keep the prompt concise (under 80 words). Describe what the image shows, not the conversation.

Reference images, when provided, are likeness references only — not images to paste into the output.`;

export const IMAGE_ENTITY_CONTEXT = `Available people/entities with reference images: {entities}. Only include someone by name when they are central to the image. Do not feature everyone just because they are available.`;

export const IMAGE_OF_DAY_SYSTEM_BASE = `Create a JSON object with 'prompt' and 'caption' for a single focused meme image.

Pick one joke or visual idea and commit to it — one scene, one style, not a collage of random elements. The prompt should describe a concrete image, not a list of everything from the conversation.`;

export const GENERATE_IMAGE_TOOL_GUIDANCE =
  "Write a focused image prompt: one subject, one style, one scene. Do not cram in every person or idea from the conversation.";
