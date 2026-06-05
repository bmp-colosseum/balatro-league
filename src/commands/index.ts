// Central registry: every slash command and interaction handler is wired here.
import { admin } from "./admin.js";
import { challenge } from "./challenge.js";
import { adminHelp, help } from "./help.js";
import { helper } from "./helper.js";
import { league } from "./league.js";
import { callHelperModal, matchButtons, matchSelectMenus } from "./match-buttons.js";
import { profile } from "./profile.js";
import { random, randomDeck, randomStake } from "./random.js";
import { disputeModal, disputeSelect, report, reportButtons } from "./report.js";
import { reportShootout } from "./report-shootout.js";
import { schedule } from "./schedule.js";
import { signupHandlers } from "./signup-buttons.js";
import { standings } from "./standings.js";
import { startMatch } from "./start-match.js";
import type { ButtonHandler, ModalHandler, SelectMenuHandler, SlashCommand } from "./types.js";

export const slashCommands: SlashCommand[] = [help, adminHelp, helper, report, reportShootout, standings, schedule, profile, league, startMatch, challenge, admin, random, randomDeck, randomStake];

export const buttonHandlers: ButtonHandler[] = [reportButtons, signupHandlers, matchButtons];

export const selectMenuHandlers: SelectMenuHandler[] = [matchSelectMenus, disputeSelect];

export const modalHandlers: ModalHandler[] = [disputeModal, callHelperModal];
