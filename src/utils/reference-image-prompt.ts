export const REFERENCE_IMAGE_LIKENESS_INSTRUCTION =
  "Use attached images only to guide subject likeness, facial features, and appearance. Generate a completely new original image. Never paste, composite, collage, overlay, or include the reference photos themselves in the output. Do not copy their exact pose, expression, framing, background, or composition.";

export const REFERENCE_IMAGE_EDIT_BASE_INSTRUCTION =
  "Edit the first attached image according to the prompt below.";

export const REFERENCE_IMAGE_EDIT_LIKENESS_INSTRUCTION =
  "Additional attached images are likeness references only. Use them for facial features and identity, but never paste or composite those photos into the output.";

export function augmentPromptForReferenceImages(
  prompt: string,
  referenceImageCount: number,
  baseImageCount: number = 0,
): string {
  if (referenceImageCount <= 0) {
    return prompt;
  }

  const normalizedBaseImageCount = Math.max(
    0,
    Math.min(baseImageCount, referenceImageCount),
  );
  const likenessReferenceCount =
    referenceImageCount - normalizedBaseImageCount;

  if (normalizedBaseImageCount > 0 && likenessReferenceCount === 0) {
    return `${REFERENCE_IMAGE_EDIT_BASE_INSTRUCTION}\n\n${prompt}`;
  }

  if (normalizedBaseImageCount > 0 && likenessReferenceCount > 0) {
    const likenessStartIndex = normalizedBaseImageCount + 1;
    const likenessEndIndex = referenceImageCount;
    const likenessImageLabel =
      likenessReferenceCount === 1
        ? `Image ${likenessStartIndex}`
        : `Images ${likenessStartIndex}-${likenessEndIndex}`;

    return `${REFERENCE_IMAGE_EDIT_BASE_INSTRUCTION} ${likenessImageLabel} ${REFERENCE_IMAGE_EDIT_LIKENESS_INSTRUCTION}\n\n${prompt}`;
  }

  const attachedImageLabel =
    referenceImageCount === 1
      ? "The attached image is a likeness reference."
      : `The ${referenceImageCount} attached images are likeness references.`;

  return `${attachedImageLabel} ${REFERENCE_IMAGE_LIKENESS_INSTRUCTION}\n\n${prompt}`;
}

export function formatEntityReferenceImageLabel(
  entityName: string,
  imageCount: number,
  firstImageIndex: number,
): string {
  const lastImageIndex = firstImageIndex + imageCount - 1;
  const imageIndexLabel =
    imageCount === 1
      ? `Image ${firstImageIndex}`
      : `Images ${firstImageIndex}-${lastImageIndex}`;

  return `${imageIndexLabel}: likeness reference for ${entityName}`;
}
