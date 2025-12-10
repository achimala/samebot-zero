import sharp from "sharp";

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

  // Apply power curve for sharper falloff - pushes mid-range values toward 1
  // This makes the transition from opaque to transparent happen faster
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

export async function processGifEmojiGrid(inputBuffer: Buffer): Promise<Buffer> {
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions");
  }

  const frameWidth = Math.floor(metadata.width / 3);
  const frameHeight = Math.floor(metadata.height / 3);

  const frames: Buffer[] = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const left = col * frameWidth;
      const top = row * frameHeight;

      const frameBuffer = await image
        .clone()
        .extract({
          left,
          top,
          width: frameWidth,
          height: frameHeight,
        })
        .toBuffer();

      const processedFrame = await processEmojiImage(frameBuffer);
      frames.push(processedFrame);
    }
  }

  const gifBuffer = await createGifFromFrames(frames);
  return gifBuffer;
}

async function createGifFromFrames(frames: Buffer[]): Promise<Buffer> {
  const frameDelay = 100;
  const targetSize = 128;

  const processedFrames = await Promise.all(
    frames.map(async (frame) => {
      return await sharp(frame)
        .resize(targetSize, targetSize, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .raw()
        .toBuffer();
    }),
  );

  const totalHeight = targetSize * frames.length;
  const combinedBuffer = Buffer.concat(processedFrames);

  return await sharp(combinedBuffer, {
    raw: {
      width: targetSize,
      height: totalHeight,
      channels: 4,
    },
  })
    .gif({
      delay: frameDelay,
      loop: 0,
    })
    .toBuffer();
}
