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
    ),
].map((builder) => builder.toJSON());
