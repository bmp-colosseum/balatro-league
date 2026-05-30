// Central registry: every slash command and button handler is wired here.
import { admin } from "./admin.js";
import { league } from "./league.js";
import { profile } from "./profile.js";
import { report, reportButtons } from "./report.js";
import { schedule } from "./schedule.js";
import { signupHandlers } from "./signup-buttons.js";
import { standings } from "./standings.js";
import type { ButtonHandler, SlashCommand } from "./types.js";

export const slashCommands: SlashCommand[] = [report, standings, schedule, profile, admin, league];

export const buttonHandlers: ButtonHandler[] = [reportButtons, signupHandlers];
