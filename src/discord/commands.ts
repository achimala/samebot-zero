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
    .setName("samebot")
    .setDescription("Generate a new :samebot: emoji for this server"),
].map((builder) => builder.toJSON());
