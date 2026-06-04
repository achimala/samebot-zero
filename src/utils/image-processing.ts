import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";

export async function processEmojiImage(inputBuffer: Buffer): Promise<Buffer> {
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions");
  }

  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const channels = info.channels;

  for (let i = 0; i < pixels.length; i += channels) {
    const red = pixels[i] ?? 0;
    const green = pixels[i + 1] ?? 0;
    const blue = pixels[i + 2] ?? 0;
    const currentAlpha = pixels[i + 3] ?? 255;

    const magentaScore = calculateMagentaScore(red, green, blue);

    if (magentaScore > 0) {
      const newAlpha = Math.round(currentAlpha * (1 - magentaScore));
      pixels[i + 3] = newAlpha;

      if (newAlpha > 0 && magentaScore > 0.1) {
        const despillResult = despillMagenta(red, green, blue, magentaScore);
        pixels[i] = despillResult.red;
        pixels[i + 1] = despillResult.green;
        pixels[i + 2] = despillResult.blue;
      }
    }
  }

  const processedImage = sharp(Buffer.from(pixels), {
    raw: {
      width: info.width,
      height: info.height,
      channels: channels,
    },
  });

  const trimmedBuffer = await processedImage.trim().png().toBuffer();

  return trimmedBuffer;
}

function calculateMagentaScore(
  red: number,
  green: number,
  blue: number,
): number {
  const redNorm = red / 255;
  const greenNorm = green / 255;
  const blueNorm = blue / 255;

  const magentaCharacteristic = Math.min(redNorm, blueNorm) - greenNorm;

  if (magentaCharacteristic <= 0) {
    return 0;
  }

  const brightness = (redNorm + greenNorm + blueNorm) / 3;
  const brightnessBoost = brightness > 0.4 ? 1 : brightness * 2.5;

  const rawScore = magentaCharacteristic * brightnessBoost * 2.5;
  const clampedScore = Math.min(1, Math.max(0, rawScore));

  return Math.pow(clampedScore, 0.5);
}

function despillMagenta(
  red: number,
  green: number,
  blue: number,
  magentaScore: number,
): { red: number; green: number; blue: number } {
  const spillAmount = magentaScore * 0.7;

  const targetGreen = (red + blue) / 2;
  const adjustedRed = Math.round(red - (red - targetGreen) * spillAmount * 0.3);
  const adjustedBlue = Math.round(
    blue - (blue - targetGreen) * spillAmount * 0.3,
  );
  const adjustedGreen = Math.round(
    green + (targetGreen - green) * spillAmount * 0.5,
  );

  return {
    red: Math.min(255, Math.max(0, adjustedRed)),
    green: Math.min(255, Math.max(0, adjustedGreen)),
    blue: Math.min(255, Math.max(0, adjustedBlue)),
  };
}

export interface GifOptions {
  frames: number;
  fps: number;
  loopDelay: number;
}

export function buildGifPrompt(
  prompt: string,
  gridSize: number,
  isEmoji: boolean = false,
): string {
  const parts: string[] = [prompt];

  if (isEmoji) {
    parts.push(
      "solid bright magenta background (#FF00FF) wherever it should be transparent",
      "suitable as a Discord emoji",
      "will be displayed very small so make things clear and avoid fine details or small text",
      "",
    );
  }

  parts.push(
    `Create a ${gridSize}x${gridSize} grid of animation frames showing the progression of ${isEmoji ? "this emoji" : "this scene"}.`,
    "Each frame should be as stable as possible with minimal changes between frames.",
    `Arranged in a ${gridSize}x${gridSize} grid layout (${gridSize} rows, ${gridSize} columns).`,
    "The frames should show a smooth animation sequence from top-left to bottom-right.",
    "",
    "IMPORTANT: Do NOT draw any borders, lines, gaps, or separators between frames.",
    "The frames must tile directly against each other with no visible divisions.",
  );

  return parts.join(" ");
}

interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface ProcessedGridFrame {
  pixels: Uint8Array;
  width: number;
  height: number;
  contentBounds: ContentBounds;
}

function isForegroundPixel(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): boolean {
  if (alpha < 128) {
    return false;
  }
  return calculateMagentaScore(red, green, blue) < 0.5;
}

function processMagentaKeyInPlace(pixels: Uint8Array): void {
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;

    const magentaScore = calculateMagentaScore(red, green, blue);

    if (magentaScore > 0.5) {
      pixels[index] = 1;
      pixels[index + 1] = 1;
      pixels[index + 2] = 1;
      pixels[index + 3] = 0;
    } else if (magentaScore > 0.1) {
      const despilled = despillMagenta(red, green, blue, magentaScore);
      pixels[index] = despilled.red;
      pixels[index + 1] = despilled.green;
      pixels[index + 2] = despilled.blue;
      pixels[index + 3] = 255;
    } else {
      pixels[index + 3] = 255;
    }
  }
}

function findContentBounds(
  pixels: Uint8Array,
  width: number,
  height: number,
): ContentBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;

      if (!isForegroundPixel(red, green, blue, alpha)) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function computeVerticalEdgeProfile(
  pixels: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const profile = new Float32Array(width);

  for (let x = 1; x < width - 1; x++) {
    let edgeStrength = 0;

    for (let y = 0; y < height; y++) {
      for (let channel = 0; channel < 3; channel++) {
        const leftIndex = (y * width + (x - 1)) * 4 + channel;
        const rightIndex = (y * width + (x + 1)) * 4 + channel;
        edgeStrength += Math.abs(
          (pixels[rightIndex] ?? 0) - (pixels[leftIndex] ?? 0),
        );
      }
    }

    profile[x] = edgeStrength;
  }

  return profile;
}

function computeHorizontalEdgeProfile(
  pixels: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const profile = new Float32Array(height);

  for (let y = 1; y < height - 1; y++) {
    let edgeStrength = 0;

    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const topIndex = ((y - 1) * width + x) * 4 + channel;
        const bottomIndex = ((y + 1) * width + x) * 4 + channel;
        edgeStrength += Math.abs(
          (pixels[bottomIndex] ?? 0) - (pixels[topIndex] ?? 0),
        );
      }
    }

    profile[y] = edgeStrength;
  }

  return profile;
}

function refineGridBoundaries(
  dimensionSize: number,
  gridSize: number,
  edgeProfile: Float32Array,
): number[] {
  const boundaries = [0];
  const averageCellSize = dimensionSize / gridSize;
  const searchRadius = Math.max(2, Math.floor(averageCellSize / 6));
  let previousBoundary = 0;

  for (let boundaryIndex = 1; boundaryIndex < gridSize; boundaryIndex++) {
    const expectedPosition = Math.round(boundaryIndex * averageCellSize);
    const remainingCells = gridSize - boundaryIndex;
    const searchStart = Math.max(previousBoundary + 1, expectedPosition - searchRadius);
    const searchEnd = Math.min(
      dimensionSize - remainingCells,
      expectedPosition + searchRadius,
    );

    let bestPosition = expectedPosition;
    let bestScore = -1;

    for (let position = searchStart; position <= searchEnd; position++) {
      const score = edgeProfile[position] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestPosition = position;
      }
    }

    boundaries.push(bestPosition);
    previousBoundary = bestPosition;
  }

  boundaries.push(dimensionSize);
  return boundaries;
}

function extractRawRegion(
  pixels: Uint8Array,
  imageWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array {
  const region = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = ((top + y) * imageWidth + (left + x)) * 4;
      const targetIndex = (y * width + x) * 4;
      region[targetIndex] = pixels[sourceIndex] ?? 0;
      region[targetIndex + 1] = pixels[sourceIndex + 1] ?? 0;
      region[targetIndex + 2] = pixels[sourceIndex + 2] ?? 0;
      region[targetIndex + 3] = pixels[sourceIndex + 3] ?? 0;
    }
  }

  return region;
}

function extractCroppedRegion(
  pixels: Uint8Array,
  width: number,
  height: number,
  bounds: ContentBounds,
): { pixels: Uint8Array; width: number; height: number } {
  const cropWidth = bounds.maxX - bounds.minX + 1;
  const cropHeight = bounds.maxY - bounds.minY + 1;
  const cropped = new Uint8Array(cropWidth * cropHeight * 4);

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const sourceIndex = ((bounds.minY + y) * width + (bounds.minX + x)) * 4;
      const targetIndex = (y * cropWidth + x) * 4;
      cropped[targetIndex] = pixels[sourceIndex] ?? 0;
      cropped[targetIndex + 1] = pixels[sourceIndex + 1] ?? 0;
      cropped[targetIndex + 2] = pixels[sourceIndex + 2] ?? 0;
      cropped[targetIndex + 3] = pixels[sourceIndex + 3] ?? 0;
    }
  }

  return { pixels: cropped, width: cropWidth, height: cropHeight };
}

async function renderStabilizedFrame(
  frame: ProcessedGridFrame,
  scale: number,
  targetSize: number,
): Promise<Uint8Array> {
  const { pixels: croppedPixels, width: cropWidth, height: cropHeight } =
    extractCroppedRegion(
      frame.pixels,
      frame.width,
      frame.height,
      frame.contentBounds,
    );

  const scaledWidth = Math.max(1, Math.round(cropWidth * scale));
  const scaledHeight = Math.max(1, Math.round(cropHeight * scale));

  const { data: scaledData } = await sharp(Buffer.from(croppedPixels), {
    raw: { width: cropWidth, height: cropHeight, channels: 4 },
  })
    .resize(scaledWidth, scaledHeight, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const scaledPixels = new Uint8Array(scaledData);
  const canvas = new Uint8Array(targetSize * targetSize * 4);
  const offsetX = Math.round((targetSize - scaledWidth) / 2);
  const offsetY = Math.round((targetSize - scaledHeight) / 2);

  for (let y = 0; y < scaledHeight; y++) {
    for (let x = 0; x < scaledWidth; x++) {
      const sourceIndex = (y * scaledWidth + x) * 4;
      const targetX = offsetX + x;
      const targetY = offsetY + y;

      if (
        targetX < 0 ||
        targetY < 0 ||
        targetX >= targetSize ||
        targetY >= targetSize
      ) {
        continue;
      }

      const targetIndex = (targetY * targetSize + targetX) * 4;
      canvas[targetIndex] = scaledPixels[sourceIndex] ?? 0;
      canvas[targetIndex + 1] = scaledPixels[sourceIndex + 1] ?? 0;
      canvas[targetIndex + 2] = scaledPixels[sourceIndex + 2] ?? 0;
      canvas[targetIndex + 3] = scaledPixels[sourceIndex + 3] ?? 0;
    }
  }

  return canvas;
}

export async function processGifEmojiGrid(
  inputBuffer: Buffer,
  options: GifOptions = { frames: 9, fps: 5, loopDelay: 0 },
): Promise<Buffer> {
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions");
  }

  const gridSize = Math.sqrt(options.frames);
  const targetSize = 128;
  const frameDelay = Math.round(1000 / options.fps);
  const contentPaddingRatio = 0.92;

  const { data: fullImageData } = await image
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const fullPixels = new Uint8Array(fullImageData);
  const columnBoundaries = refineGridBoundaries(
    metadata.width,
    gridSize,
    computeVerticalEdgeProfile(fullPixels, metadata.width, metadata.height),
  );
  const rowBoundaries = refineGridBoundaries(
    metadata.height,
    gridSize,
    computeHorizontalEdgeProfile(fullPixels, metadata.width, metadata.height),
  );

  const processedFrames: ProcessedGridFrame[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const left = columnBoundaries[col] ?? 0;
      const top = rowBoundaries[row] ?? 0;
      const right = columnBoundaries[col + 1] ?? metadata.width;
      const bottom = rowBoundaries[row + 1] ?? metadata.height;
      const frameWidth = right - left;
      const frameHeight = bottom - top;

      if (frameWidth <= 0 || frameHeight <= 0) {
        throw new Error("Invalid grid cell dimensions after boundary detection");
      }

      const framePixels = extractRawRegion(
        fullPixels,
        metadata.width,
        left,
        top,
        frameWidth,
        frameHeight,
      );

      processMagentaKeyInPlace(framePixels);

      const contentBounds = findContentBounds(
        framePixels,
        frameWidth,
        frameHeight,
      );

      if (!contentBounds) {
        throw new Error("Grid frame has no visible content after processing");
      }

      processedFrames.push({
        pixels: framePixels,
        width: frameWidth,
        height: frameHeight,
        contentBounds,
      });
    }
  }

  let maxContentWidth = 0;
  let maxContentHeight = 0;

  for (const frame of processedFrames) {
    const contentWidth =
      frame.contentBounds.maxX - frame.contentBounds.minX + 1;
    const contentHeight =
      frame.contentBounds.maxY - frame.contentBounds.minY + 1;
    maxContentWidth = Math.max(maxContentWidth, contentWidth);
    maxContentHeight = Math.max(maxContentHeight, contentHeight);
  }

  const unifiedScale = Math.min(
    (targetSize * contentPaddingRatio) / maxContentWidth,
    (targetSize * contentPaddingRatio) / maxContentHeight,
  );

  const stabilizedFrames: Uint8Array[] = [];

  for (const frame of processedFrames) {
    stabilizedFrames.push(
      await renderStabilizedFrame(frame, unifiedScale, targetSize),
    );
  }

  const encoder = new GIFEncoder(targetSize, targetSize, "neuquant", true);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(1);
  encoder.setDispose(2);
  encoder.setTransparent(0x010101);

  for (let frameIndex = 0; frameIndex < stabilizedFrames.length; frameIndex++) {
    const isLastFrame = frameIndex === stabilizedFrames.length - 1;
    const delay = isLastFrame && options.loopDelay > 0
      ? frameDelay + frameDelay * options.loopDelay
      : frameDelay;
    encoder.setDelay(delay);
    encoder.addFrame(stabilizedFrames[frameIndex]!);
  }

  encoder.finish();
  return encoder.out.getData();
}
