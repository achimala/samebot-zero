import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("img")
    .setDescription("Generate an image with nano banana")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Describe what to draw")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Dump the active Samebot context for this channel"),
  new SlashCommandBuilder()
    .setName("agent")
    .setDescription("Launch a Cursor agent to create a PR for a request")
    .addStringOption((option) =>
      option
        .setName("instructions")
        .setDescription("What should the agent do?")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("emoji")
    .setDescription("Generate a new :samebot: emoji for this server")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Describe what the emoji should look like")
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("reference")
        .setDescription("Optional reference image to base the emoji on")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("rememberimage")
    .setDescription("Add a reference image for an entity (person, thing, etc.)")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Name of the entity (e.g., 'anshu', 'office-cat')")
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("Reference image for this entity")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("gifemoji")
    .setDescription("Generate a new animated GIF emoji for this server")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Describe what the animated emoji should look like")
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("reference")
        .setDescription("Optional reference image to base the emoji on")
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName("frames")
        .setDescription("Number of frames (must be perfect square: 4, 9, 16, 25). Default: 9")
        .setRequired(false)
        .addChoices(
          { name: "4 (2x2)", value: 4 },
          { name: "9 (3x3)", value: 9 },
          { name: "16 (4x4)", value: 16 },
          { name: "25 (5x5)", value: 25 },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("fps")
        .setDescription("Frames per second (1-20). Default: 5")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20),
    )
    .addIntegerOption((option) =>
      option
        .setName("loop_delay")
        .setDescription("Pause at end for N frames before looping. Default: 0")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(30),
    )
    .addBooleanOption((option) =>
      option
        .setName("remove_background")
        .setDescription("Remove magenta background (default: true)")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("Generate an animated GIF")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Describe what the animated GIF should look like")
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("reference")
        .setDescription("Optional reference image to base the GIF on")
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName("frames")
        .setDescription("Number of frames (must be perfect square: 4, 9, 16, 25). Default: 9")
        .setRequired(false)
        .addChoices(
          { name: "4 (2x2)", value: 4 },
          { name: "9 (3x3)", value: 9 },
          { name: "16 (4x4)", value: 16 },
          { name: "25 (5x5)", value: 25 },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("fps")
        .setDescription("Frames per second (1-20). Default: 5")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20),
    )
    .addIntegerOption((option) =>
      option
        .setName("loop_delay")
        .setDescription("Pause at end for N frames before looping. Default: 0")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(30),
    )
    .addBooleanOption((option) =>
      option
        .setName("remove_background")
        .setDescription("Remove magenta background (default: true)")
        .setRequired(false),
    ),
].map((builder) => builder.toJSON());
