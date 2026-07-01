import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  for (let index = 0; index < pixels.length; index += channels) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const currentAlpha = pixels[index + 3] ?? 255;

    const magentaScore = calculateMagentaScore(red, green, blue);

    if (magentaScore > 0) {
      const newAlpha = Math.round(currentAlpha * (1 - magentaScore));
      pixels[index + 3] = newAlpha;

      if (newAlpha > 0 && magentaScore > 0.1) {
        const despillResult = despillMagenta(red, green, blue, magentaScore);
        pixels[index] = despillResult.red;
        pixels[index + 1] = despillResult.green;
        pixels[index + 2] = despillResult.blue;
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
  isEmoji: boolean = false,
): string {
  const parts: string[] = [prompt];

  if (isEmoji) {
    parts.push(
      "solid bright magenta background (#FF00FF) wherever it should be transparent",
      "suitable as a Discord emoji",
      "will be displayed very small so make things clear and avoid fine details or small text",
    );
  }

  parts.push(
    "In a single unbroken scene with no scene cuts.",
    "Smooth continuous animation suitable for looping as a GIF.",
    "No dialogue. No sound effects.",
  );

  return parts.join(" ");
}

export function buildVideoPrompt(prompt: string): string {
  const parts: string[] = [
    prompt,
    "In a single unbroken scene with no scene cuts.",
    "Smooth continuous animation.",
    "No dialogue. No sound effects.",
  ];

  return parts.join(" ");
}

const MAGENTA_COLORKEY_FILTER = "colorkey=0xFF00FF:0.35:0.08";

export async function processVideoToGif(
  videoBuffer: Buffer,
  options: GifOptions = { frames: 25, fps: 12, loopDelay: 0 },
  targetSize: number = 128,
): Promise<Buffer> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "samebot-gif-"));
  const videoPath = join(tempDirectory, "input.mp4");
  const framesDirectory = join(tempDirectory, "frames");

  try {
    await writeFile(videoPath, videoBuffer);
    await mkdir(framesDirectory, { recursive: true });

    const durationSeconds = await getVideoDurationSeconds(videoPath);
    const frameCount = Math.min(
      options.frames,
      Math.ceil(durationSeconds * options.fps),
    );
    const extractionFrameRate = frameCount / durationSeconds;

    await runCommand("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=${extractionFrameRate},scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease,pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=0xFF00FF,${MAGENTA_COLORKEY_FILTER}`,
      "-frames:v",
      String(frameCount),
      join(framesDirectory, "frame_%03d.png"),
    ]);

    const frameFileNames = (await readdir(framesDirectory))
      .filter((fileName) => fileName.endsWith(".png"))
      .sort();

    if (frameFileNames.length === 0) {
      throw new Error("Video frame extraction produced no frames");
    }

    const processedFrames: Uint8Array[] = [];
    for (const fileName of frameFileNames) {
      const frameBuffer = await readFile(join(framesDirectory, fileName));
      processedFrames.push(await readTransparentGifFrame(frameBuffer));
    }

    return encodeGif(processedFrames, options, targetSize);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function readTransparentGifFrame(frameBuffer: Buffer): Promise<Uint8Array> {
  const { data } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 255;

    if (alpha < 128) {
      pixels[index] = 1;
      pixels[index + 1] = 1;
      pixels[index + 2] = 1;
      pixels[index + 3] = 0;
    } else {
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}

function encodeGif(
  processedFrames: Uint8Array[],
  options: GifOptions,
  targetSize: number,
): Buffer {
  const frameDelay = Math.round(1000 / options.fps);

  const encoder = new GIFEncoder(targetSize, targetSize, "neuquant", true);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(1);
  encoder.setDispose(2);
  encoder.setTransparent(0x010101);

  for (let frameIndex = 0; frameIndex < processedFrames.length; frameIndex++) {
    const isLastFrame = frameIndex === processedFrames.length - 1;
    const delay =
      isLastFrame && options.loopDelay > 0
        ? frameDelay + frameDelay * options.loopDelay
        : frameDelay;
    encoder.setDelay(delay);
    encoder.addFrame(processedFrames[frameIndex]!);
  }

  encoder.finish();
  return encoder.out.getData();
}

async function getVideoDurationSeconds(videoPath: string): Promise<number> {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);

  const durationSeconds = Number.parseFloat(output.trim());

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Could not determine video duration");
  }

  return durationSeconds;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const childProcess = spawn(command, args);

    childProcess.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    childProcess.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    childProcess.on("error", (error) => {
      reject(error);
    });

    childProcess.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${exitCode}: ${stderr || stdout}`,
        ),
      );
    });
  });
}
