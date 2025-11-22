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
].map((builder) => builder.toJSON());
