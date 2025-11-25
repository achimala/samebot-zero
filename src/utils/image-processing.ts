import sharp from "sharp";

const MAGENTA_TARGET = { r: 255, g: 0, b: 255 };
const COLOR_TOLERANCE = 60;

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
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];

    if (isCloseToMagenta(red, green, blue)) {
      pixels[i + 3] = 0;
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

function isCloseToMagenta(red: number, green: number, blue: number): boolean {
  const redDiff = Math.abs(red - MAGENTA_TARGET.r);
  const greenDiff = Math.abs(green - MAGENTA_TARGET.g);
  const blueDiff = Math.abs(blue - MAGENTA_TARGET.b);

  return (
    redDiff <= COLOR_TOLERANCE &&
    greenDiff <= COLOR_TOLERANCE &&
    blueDiff <= COLOR_TOLERANCE
  );
}

