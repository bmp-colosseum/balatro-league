// Central registry: every slash command and interaction handler is wired here.
import { admin } from "./admin.js";
import { challenge } from "./challenge.js";
import { disputeResolveSelect, disputeThreadButtonHandler } from "./dispute-buttons.js";
import { adminHelp, help } from "./help.js";
import { helper } from "./helper.js";
import { league } from "./league.js";
import { callHelperModal, matchButtons, matchSelectMenus } from "./match-buttons.js";
import { pool } from "./pool.js";
import { profile } from "./profile.js";
import { random } from "./random.js";
import { disputeModal, disputeSelect, report, reportButtons } from "./report.js";
import { reportShootout } from "./report-shootout.js";
import { schedule } from "./schedule.js";
import { status } from "./status.js";
import { signupHandlers } from "./signup-buttons.js";
import { signupAskButtonHandler } from "./signup-ask-buttons.js";
import { standings } from "./standings.js";
import { startMatch } from "./start-match.js";
import { support } from "./support.js";
import { supportButtons } from "./support-buttons.js";
import { queueButtons } from "./queue-buttons.js";
import { rosterButtons } from "./roster-buttons.js";
import type { ButtonHandler, ModalHandler, SelectMenuHandler, SlashCommand } from "./types.js";

// NOTE: /report and /report-shootout are intentionally NOT registered as slash
// commands — reporting now happens through the guided /start-match flow (which
// also captures lives, decks, etc.) or the website. The report.ts / report-shootout.ts
// code stays (the report-flow + buttons back /start-match finalize, web reports,
// and admin tooling), it's just hidden from the player command list.
// /timezone removed — the messed-up autocomplete (Discord's 25-result cap on
// IANA zones) wasn't worth it. Timezone is still settable on the website (/me, with
// browser auto-detect) and shown to opponents in /schedule.
export const slashCommands: SlashCommand[] = [help, adminHelp, helper, support, standings, schedule, status, profile, league, startMatch, challenge, admin, random, pool];

export const buttonHandlers: ButtonHandler[] = [reportButtons, signupHandlers, signupAskButtonHandler, matchButtons, disputeThreadButtonHandler, supportButtons, queueButtons, rosterButtons];

export const selectMenuHandlers: SelectMenuHandler[] = [matchSelectMenus, disputeSelect, disputeResolveSelect];

export const modalHandlers: ModalHandler[] = [disputeModal, callHelperModal];
