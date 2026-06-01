// Central registry: every slash command and interaction handler is wired here.
import { admin } from "./admin.js";
import { challenge } from "./challenge.js";
import { help } from "./help.js";
import { league } from "./league.js";
import { matchButtons, matchSelectMenus } from "./match-buttons.js";
import { profile } from "./profile.js";
import { report, reportButtons } from "./report.js";
import { reportShootout } from "./report-shootout.js";
import { schedule } from "./schedule.js";
import { signupHandlers } from "./signup-buttons.js";
import { standings } from "./standings.js";
import { startMatch } from "./start-match.js";
import type { ButtonHandler, SelectMenuHandler, SlashCommand } from "./types.js";

export const slashCommands: SlashCommand[] = [help, report, reportShootout, standings, schedule, profile, league, startMatch, challenge, admin];

export const buttonHandlers: ButtonHandler[] = [reportButtons, signupHandlers, matchButtons];

export const selectMenuHandlers: SelectMenuHandler[] = [matchSelectMenus];
