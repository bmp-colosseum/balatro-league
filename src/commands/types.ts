import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  StringSelectMenuInteraction,
} from "discord.js";

export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

// Where a command is allowed to run. Default ("any") means anywhere in
// the guild.
//
//   "match-flow"     — division channels OR the bot-commands channel.
//                      Right for /challenge (casual, no division) and
//                      /report (reporting a known pair).
//   "division-only"  — only division channels. Right for /start-match
//                      since a league set is intrinsically scoped to
//                      one division; running it elsewhere would have to
//                      pick a division arbitrarily.
export type ChannelScope = "any" | "match-flow" | "division-only";

export interface SlashCommand {
  data: CommandBuilder;
  // Defaults to "any" when omitted.
  channelScope?: ChannelScope;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

// Button interactions are routed by customId prefix. Each handler claims a prefix
// (e.g. "report:confirm:") and parses the rest of the customId for its own state.
export interface ButtonHandler {
  prefix: string;
  execute(interaction: ButtonInteraction): Promise<void>;
}

// Same routing model for StringSelectMenu interactions. Multi-pick UIs
// (e.g. the match ban phases) submit one interaction with `values: string[]`
// instead of one button click per choice.
export interface SelectMenuHandler {
  prefix: string;
  execute(interaction: StringSelectMenuInteraction): Promise<void>;
}
