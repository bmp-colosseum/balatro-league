// Admin-only config page. Sections:
//   - Categories / Channels & external — category + channel-id KV values + webhook URLs
//   - Mode, Community, Public/join, BMP — assorted LeagueConfig KV knobs
//   - Role bindings — view + add + remove role → tier mappings
//
// Scoring / match policy / timeouts live on /admin/settings, NOT here.
// Everything is admin-friendly form-based instead of requiring SQL. All
// writes go through scoped server actions in actions.ts.

import { requireAdmin, hasTier } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSelect } from "@/components/FormSelect";
import {
  addRoleBinding,
  clearConfigValue,
  removeRoleBinding,
  setConfigValue,
} from "./actions";

export const dynamic = "force-dynamic";

// One row per LeagueConfig key we want exposed via UI. Order matters —
// it's the display order on the page. Sections are sub-headed below.
const CHANNEL_KEYS = [
  { key: "announcements_channel_id", label: "Announcements channel ID", help: "Where the bot posts league-wide announcements (e.g. \"Season N is now live!\"). Right-click channel → Copy Channel ID. Auto-created as #league-announcements on bot startup if unset — set it here to redirect to a different channel. Falls back to env ANNOUNCEMENTS_CHANNEL_ID." },
  { key: "league_info_channel_id", label: "League-info channel ID", help: "The #league-info channel where the bot maintains the pinned 'how it works' + live-season message. Set this if you created the channel manually instead of running /league setup." },
  { key: "signups_channel_id", label: "Signups channel ID", help: "Default channel the season signup embed posts to (e.g. #league-signups). The Open-signups form on the seasons page pre-selects this. /league setup adopts + renames a channel pinned here. Right-click channel → Copy Channel ID." },
  { key: "results_webhook_url", label: "Results webhook URL", help: "Posts match results here via webhook. First priority. Falls back to env RESULTS_WEBHOOK_URL." },
  { key: "results_channel_id", label: "Results channel — bot", help: "Where the BOT auto-posts match results (e.g. #league-results-bot). Used when no webhook is set. Right-click channel → Copy Channel ID. Falls back to env RESULTS_CHANNEL_ID." },
  { key: "results_human_channel_id", label: "Results channel — humans", help: "Human-facing results channel (e.g. #league-results) for people to post in manually if the bot's auto-post ever has an issue. The bot doesn't post here." },
  { key: "bot_commands_channel_id", label: "Bot-commands channel ID(s)", help: "Where public bot commands (/random, /pool, /random-bans) are allowed to run. Accepts a COMMA-SEPARATED LIST of channel IDs to allow several channels. The admin channel is always allowed too. Ephemeral commands (/standings, /profile, /schedule) and dedicated-channel ones (/report, /challenge) still work anywhere. Auto-created as #league-bot-commands on startup if unset." },
  { key: "standings_channel_id", label: "Standings channel ID", help: "Read-only channel where the bot maintains a self-updating live standings post for the active season (one embed per division, refreshed every 15 min). Auto-created as #league-standings by /league setup. Clear to turn the standings feed off." },
  { key: "challenges_channel_id", label: "Challenges channel ID", help: "Parent channel for /challenge match threads. Optional." },
  { key: "challenge_results_channel_id", label: "Challenge results channel ID", help: "Where casual /challenge results post as a browsable feed. Defaults to the #challenges channel if unset. Right-click channel → Copy Channel ID." },
  { key: "challenge_results_webhook_url", label: "Challenge results webhook URL", help: "Optional webhook for the casual /challenge result feed (avoids the bot's rate-limit budget). Takes priority over the channel ID. Channel → Edit → Integrations → Webhooks → copy URL." },
  { key: "devops_channel_id", label: "DevOps channel ID", help: "Queue-stall + rate-limit alerts. Tech-only." },
];

const CATEGORY_KEYS = [
  { key: "league_category_id", label: "League category ID", help: "The Discord CATEGORY the bot creates its channels under (info, signups, results, announcements, bot-commands, …). Right-click the category → Copy ID. Set this to drop the league into an existing category on a server the bot didn't create — bootstrap + auto-create honor it. Auto-filled when /league setup runs." },
  { key: "matches_category_id", label: "Matches category ID", help: "The category that holds #challenges (casual /challenge match threads). Defaults to a '🎴 Matches' category created on bootstrap; set an ID here to use an existing one." },
];

const MODE_KEYS = [
  { key: "signups_only_mode", label: "Sign-ups-only mode", help: "Set to 'true' to disable every command except /help while keeping the sign-up flow live. Use for a soft launch in a new server; set to 'false' (or clear) when the season starts." },
  { key: "division_channels_disabled", label: "Disable division channels", help: "Set to 'true' for a lightweight league: activating a season won't auto-create per-division channels/roles. Matches run in #bot-commands, results post to the Results channel, standings are on the web. You can still create channels later from the season page." },
];

const COMMUNITY_KEYS = [
  { key: "support_channel_id", label: "Support channel ID", help: "Where /support opens private ticket threads (pings helpers). Unset = /support is disabled." },
  { key: "admin_channel_id", label: "Admin channel ID", help: "League admin/staff chat. Stored so the bot/site can reference it. Optional." },
  { key: "feedback_channel_id", label: "Feedback channel ID", help: "Feedback / forum channel where players post. Optional." },
  { key: "general_channel_id", label: "General channel ID", help: "League general chat. Optional." },
];

const BMP_KEYS = [
  { key: "bmp_current_season", label: "Current BMP season", help: "e.g. 'season6'. Auto-detected from balatromp.com daily — override here if needed." },
  { key: "bmp_capture_previous_season", label: "Capture previous BMP season on refresh", help: "Set to 'true' to backfill the previous BMP season for everyone. Default: unset (only current is captured)." },
];

const SITE_KEYS = [
  { key: "discord_server_invite_url", label: "Discord server invite URL", help: "Public invite link shown as the 'Step 1 — Join the Discord server' card on the /join landing page. Use a non-expiring invite (https://discord.gg/…). Leave unset to hide the Step 1 card entirely." },
];

// Scoring + match policy + timeouts already have a dedicated UI at
// /admin/settings (via getLeagueSettings() with typed defaults). This
// page is for the channels/webhooks/BMP/role-binding stuff that was
// previously SQL-only.

export default async function AdminConfigPage() {
  await requireAdmin();
  // Role binding (role → tier) is OWNER-only — an ADMIN binding a role to
  // OWNER would be self-escalation. Non-owners see config but not the binder.
  const isOwner = await hasTier("OWNER");
  const [configRows, roleBindings] = await Promise.all([
    prisma.leagueConfig.findMany(),
    prisma.roleBinding.findMany({ orderBy: { tier: "asc" } }),
  ]);
  const valueByKey = new Map(configRows.map((r) => [r.key, r.value]));

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/config" />
      <main>
        <h2>⚙️ Config</h2>
        <p className="muted">
          Tunable knobs that used to be SQL-only. Everything here is admin-friendly
          form-based now. Changes apply immediately (LeagueConfig has a ~30s in-memory
          cache on the bot side, so rules tweaks take up to that long to propagate).
        </p>

        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Tip: toggle <strong>Show Discord IDs</strong> per-browser from the ⚙️ menu (top-right) —
          it's a personal display preference, not a server-wide setting.
        </p>

        <ConfigSection title="Categories" keys={CATEGORY_KEYS} valueByKey={valueByKey} />
        <ConfigSection title="Channels & external" keys={CHANNEL_KEYS} valueByKey={valueByKey} />
        <ConfigSection title="Mode" keys={MODE_KEYS} valueByKey={valueByKey} />
        <ConfigSection title="Community channels" keys={COMMUNITY_KEYS} valueByKey={valueByKey} />
        <ConfigSection title="Public / join page" keys={SITE_KEYS} valueByKey={valueByKey} />
        <ConfigSection title="BMP / balatromp.com" keys={BMP_KEYS} valueByKey={valueByKey} />
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          Looking for scoring / match policy / timeouts? Those live on{" "}
          <a href="/admin/settings">/admin/settings</a>.
        </p>

        {isOwner ? (
        <div className="card" style={{ marginTop: 16 }}>
          <strong>Role bindings ({roleBindings.length})</strong>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Maps Discord role IDs to permission tiers: <strong>OWNER &gt; ADMIN &gt; HELPER</strong>,
            plus <strong>DEVOPS</strong> (infra-only, off the ladder). Owner is also pinned via the
            LEAGUE_OWNER_DISCORD_ID env var as a lockout-prevention fallback. Use{" "}
            <code>/league set-role</code> in Discord for the easier path — it accepts an @role
            mention, this page wants raw IDs.
          </p>
          <form action={addRoleBinding} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <Input type="text" name="discordRoleId" placeholder="Discord role ID (17-20 digits)" required pattern="\d{17,20}" className="flex-1 min-w-[200px]" />
            <FormSelect
              name="tier"
              required
              defaultValue="ADMIN"
              options={[
                { value: "OWNER", label: "OWNER" },
                { value: "ADMIN", label: "ADMIN" },
                { value: "HELPER", label: "HELPER" },
                { value: "DEVOPS", label: "DEVOPS" },
              ]}
            />
            <Button type="submit">Add binding</Button>
          </form>
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Tier</th><th>Discord role ID</th><th>Set by</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {roleBindings.length === 0 ? (
                <tr><td colSpan={5} className="muted">No bindings yet.</td></tr>
              ) : roleBindings.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.tier}</strong></td>
                  <td><code style={{ fontSize: 11 }}>{b.discordRoleId}</code></td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdBy ?? "—"}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    <form action={removeRoleBinding} style={{ display: "inline" }}>
                      <input type="hidden" name="id" value={b.id} />
                      <Button type="submit" variant="ghost" size="sm" className="text-[#e74c3c]">
                        remove
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : (
          <div className="card muted" style={{ marginTop: 16 }}>
            <strong>Role bindings</strong> are owner-only. Ask the league owner — or use{" "}
            <code>/league set-role</code> in Discord — to change role → tier mappings.
          </div>
        )}
      </main>
    </>
  );
}

function ConfigSection({
  title,
  keys,
  valueByKey,
}: {
  title: string;
  keys: Array<{ key: string; label: string; help: string }>;
  valueByKey: Map<string, string>;
}) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>{title}</strong>
      <table style={{ marginTop: 8 }}>
        <thead>
          <tr><th style={{ width: "30%" }}>Setting</th><th>Current value</th><th></th></tr>
        </thead>
        <tbody>
          {keys.map(({ key, label, help }) => {
            const value = valueByKey.get(key) ?? "";
            return (
              <tr key={key}>
                <td>
                  <strong style={{ fontSize: 13 }}>{label}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>{help}</div>
                  <div className="muted" style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}>{key}</div>
                </td>
                <td>
                  <form action={setConfigValue} style={{ display: "flex", gap: 6 }}>
                    <input type="hidden" name="key" value={key} />
                    <Input
                      type="text"
                      name="value"
                      defaultValue={value}
                      placeholder={value ? "" : "(unset)"}
                      className="flex-1 text-xs"
                    />
                    <Button type="submit" variant="secondary" size="sm">Save</Button>
                  </form>
                </td>
                <td>
                  {value && (
                    <form action={clearConfigValue} style={{ display: "inline" }}>
                      <input type="hidden" name="key" value={key} />
                      <Button type="submit" variant="ghost" size="sm" className="text-[#e74c3c]">
                        clear
                      </Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
