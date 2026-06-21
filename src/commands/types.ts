import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
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
//   "match-flow"          — division channels OR bot-commands channel.
//                           Currently no commands use this; retained
//                           in case we want a hybrid command later.
//   "division-only"       — only division channels. Right for
//                           /start-match (league sets are intrinsically
//                           scoped to one division).
//   "bot-commands-only"   — only the configured bot-commands channel.
//                           Right for /challenge and /report so they
//                           don't get confused with /start-match in a
//                           division channel.
export type ChannelScope = "any" | "match-flow" | "division-only" | "bot-commands-only" | "support-only";

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

// Modal submit handlers — fired when a user submits a Discord modal.
// Custom id prefix routes to the right handler (e.g. dispute-modal:).
export interface ModalHandler {
  prefix: string;
  execute(interaction: ModalSubmitInteraction): Promise<void>;
}
