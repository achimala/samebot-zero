import { describe, expect, it } from "vitest";
import {
  augmentPromptForReferenceImages,
  formatEntityReferenceImageLabel,
  REFERENCE_IMAGE_LIKENESS_INSTRUCTION,
} from "./reference-image-prompt";

describe("augmentPromptForReferenceImages", () => {
  it("returns the prompt unchanged when there are no reference images", () => {
    expect(augmentPromptForReferenceImages("draw a cat", 0)).toBe("draw a cat");
  });

  it("adds likeness instructions for reference-only generation", () => {
    const prompt = augmentPromptForReferenceImages("draw a cat", 2);

    expect(prompt).toContain(REFERENCE_IMAGE_LIKENESS_INSTRUCTION);
    expect(prompt).toContain("2 attached images are likeness references");
    expect(prompt).toContain("draw a cat");
  });

  it("adds edit instructions when only a base image is attached", () => {
    const prompt = augmentPromptForReferenceImages("make it sunset", 1, 1);

    expect(prompt).toContain("Edit the first attached image");
    expect(prompt).not.toContain(REFERENCE_IMAGE_LIKENESS_INSTRUCTION);
    expect(prompt).toContain("make it sunset");
  });

  it("adds edit and likeness instructions when a base image and references are attached", () => {
    const prompt = augmentPromptForReferenceImages(
      "add tyrus to the scene",
      3,
      1,
    );

    expect(prompt).toContain("Edit the first attached image");
    expect(prompt).toContain("Images 2-3");
    expect(prompt).toContain("likeness references only");
    expect(prompt).toContain("add tyrus to the scene");
  });
});

describe("formatEntityReferenceImageLabel", () => {
  it("formats a single-image entity label", () => {
    expect(formatEntityReferenceImageLabel("tyrus", 1, 1)).toBe(
      "Image 1: likeness reference for tyrus",
    );
  });

  it("formats a multi-image entity label", () => {
    expect(formatEntityReferenceImageLabel("tyrus", 3, 2)).toBe(
      "Images 2-4: likeness reference for tyrus",
    );
  });
});
