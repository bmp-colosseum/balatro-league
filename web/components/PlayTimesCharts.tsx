"use client";

// Charts for /admin/play-times. A thin shell: computes the viewer's own UTC
// offset (so every bucket reflects whoever is looking, not the server), runs
// the pure core, and draws plain inline SVG from the result -- no chart
// library. Colors reuse the site's CSS variables (var(--accent-2) etc.) so
// this reads like the rest of the admin area, not a bolted-on widget.

import { useMemo, useSyncExternalStore } from "react";
import {
  computePlayTimes,
  busiestHourWindow,
  busiestWeekday,
  quietestWeekday,
  overallLastThreeDaysShare,
  type PlayTimesMatch,
  type PlayTimesSeason,
  type PlayTimesSeasonSummary,
} from "@/lib/play-times-core";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Fades from near-invisible to the site's accent-2 blurple (var(--accent-2),
// #5865f2) as intensity rises from 0 to 1. Hardcoded to match the CSS
// variable's value, same approach app/globals.css already uses for its own
// rgba() flash-card tints (can't interpolate a CSS var's color in JS).
function heatFill(intensity: number): string {
  const alpha = intensity <= 0 ? 0.05 : 0.12 + intensity * 0.78;
  return `rgba(88,101,242,${alpha})`;
}

const HEAT_CELL_W = 26;
const HEAT_CELL_H = 20;
const HEAT_HEADER_H = 18;
const HEAT_WIDTH = 24 * HEAT_CELL_W;
const HEAT_HEIGHT = HEAT_HEADER_H + WEEKDAY_LABELS.length * HEAT_CELL_H;

// No actual external store to subscribe to -- the browser's own UTC offset
// never changes mid-session -- so subscribe is a no-op. getServerSnapshot
// returns null so SSR + the initial client hydration render stay identical
// (no tz-dependent mismatch); useSyncExternalStore then swaps in the real
// client snapshot right after hydration, which is its documented way to
// surface a browser-only value without a manual setState-in-effect.
function subscribeNever(): () => void {
  return () => {};
}

function getClientTzOffsetMinutes(): number {
  return new Date().getTimezoneOffset();
}

function getServerTzOffsetMinutes(): number | null {
  return null;
}

export interface PlayTimesChartsProps {
  matches: PlayTimesMatch[];
  seasons: PlayTimesSeason[];
}

export function PlayTimesCharts({ matches, seasons }: PlayTimesChartsProps) {
  const tzOffsetMinutes = useSyncExternalStore(
    subscribeNever,
    getClientTzOffsetMinutes,
    getServerTzOffsetMinutes,
  );

  const result = useMemo(() => {
    if (tzOffsetMinutes === null) return null;
    return computePlayTimes({ matches, seasons, tzOffsetMinutes });
  }, [matches, seasons, tzOffsetMinutes]);

  if (!result) {
    return <div className="card muted">Loading local play times...</div>;
  }

  const busiestWindow = busiestHourWindow(result.hours, result.kept);
  const busiestDay = busiestWeekday(result.weekdays);
  const quietestDay = quietestWeekday(result.weekdays);
  const lastThreeShare = overallLastThreeDaysShare(result.perSeason);
  const maxHeat = result.heat.reduce((max, row) => row.reduce((rowMax, v) => Math.max(rowMax, v), max), 0);
  const maxHourTotal = result.hours.reduce((max, v) => Math.max(max, v), 0);

  const windowHours = new Set<number>();
  for (let i = 0; i < busiestWindow.lengthHours; i++) windowHours.add((busiestWindow.startHour + i) % 24);

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <div className="stat">
          <div className="label">Matches counted</div>
          <div className="value">{result.kept}</div>
          {result.dropped > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {result.dropped} dropped as bulk imports
            </div>
          )}
        </div>
        <div className="stat">
          <div className="label">Busiest 4-hour window</div>
          <div className="value" style={{ fontSize: 20 }}>
            {hourLabel(busiestWindow.startHour)}-{hourLabel((busiestWindow.startHour + busiestWindow.lengthHours) % 24)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {pct(busiestWindow.share)} of all matches
          </div>
        </div>
        <div className="stat">
          <div className="label">Busiest / quietest day</div>
          <div className="value" style={{ fontSize: 20 }}>
            {WEEKDAY_LABELS[busiestDay.weekday]} / {WEEKDAY_LABELS[quietestDay.weekday]}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {busiestDay.total} vs {quietestDay.total} matches
          </div>
        </div>
        <div className="stat">
          <div className="label">In the last 3 days of a season</div>
          <div className="value">{pct(lastThreeShare)}</div>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Weekday x hour heatmap</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Times are shown in your local time zone.
      </p>
      <div className="card" style={{ display: "flex", gap: 6 }}>
        <div style={{ display: "flex", flexDirection: "column", paddingTop: HEAT_HEADER_H, flexShrink: 0 }}>
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="muted"
              style={{ height: HEAT_CELL_H, display: "flex", alignItems: "center", fontSize: 11 }}
            >
              {label}
            </div>
          ))}
        </div>
        <div className="table-scroll">
          <svg
            width={HEAT_WIDTH}
            height={HEAT_HEIGHT}
            role="img"
            aria-label="Matches per weekday and hour, in your local time"
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <text
                key={hour}
                x={hour * HEAT_CELL_W + HEAT_CELL_W / 2}
                y={HEAT_HEADER_H - 6}
                fontSize={10}
                fill="var(--muted)"
                textAnchor="middle"
              >
                {hour % 3 === 0 ? hourLabel(hour) : ""}
              </text>
            ))}
            {result.heat.map((row, weekday) =>
              row.map((count, hour) => (
                <rect
                  key={`${weekday}-${hour}`}
                  x={hour * HEAT_CELL_W}
                  y={HEAT_HEADER_H + weekday * HEAT_CELL_H}
                  width={HEAT_CELL_W - 1}
                  height={HEAT_CELL_H - 1}
                  fill={heatFill(maxHeat > 0 ? count / maxHeat : 0)}
                  stroke="var(--border)"
                >
                  <title>
                    {WEEKDAY_LABELS[weekday]} {hourLabel(hour)}: {count} match{count === 1 ? "" : "es"}
                  </title>
                </rect>
              )),
            )}
          </svg>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Matches by hour of day</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Times are shown in your local time zone. Gold bars mark the busiest 4-hour window.
      </p>
      <div className="card">
        <svg
          viewBox="0 0 480 150"
          width="100%"
          height={150}
          preserveAspectRatio="none"
          role="img"
          aria-label="Matches by hour of day, in your local time"
        >
          {result.hours.map((count, hour) => {
            const barHeight = maxHourTotal > 0 ? (count / maxHourTotal) * 110 : 0;
            const x = hour * 20;
            return (
              <g key={hour}>
                <rect
                  x={x + 2}
                  y={120 - barHeight}
                  width={16}
                  height={barHeight}
                  fill={windowHours.has(hour) ? "var(--accent)" : "var(--accent-2)"}
                >
                  <title>
                    {hourLabel(hour)}: {count} match{count === 1 ? "" : "es"}
                  </title>
                </rect>
                <text x={x + 10} y={136} fontSize={9} fill="var(--muted)" textAnchor="middle">
                  {hour % 3 === 0 ? hourLabel(hour) : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <h3 style={{ marginTop: 24 }}>Matches per day, by season</h3>
      <div className="grid grid-3">
        {result.perSeason.map((season) => (
          <SeasonMiniChart key={season.number} season={season} />
        ))}
      </div>
    </>
  );
}

const SEASON_CHART_WIDTH = 280;
const SEASON_CHART_HEIGHT = 110;
const SEASON_PLOT_BOTTOM = 84;
const SEASON_PLOT_HEIGHT = 70;

function SeasonMiniChart({ season }: { season: PlayTimesSeasonSummary }) {
  const days = season.dayCounts.length;
  const maxDay = season.dayCounts.reduce((max, v) => Math.max(max, v), 0);
  const barWidth = days > 0 ? SEASON_CHART_WIDTH / days : SEASON_CHART_WIDTH;
  const sharePct = season.total > 0 ? Math.round((season.lastThreeDays / season.total) * 100) : 0;

  return (
    <div className="card">
      <strong style={{ fontSize: 13 }}>
        Season {season.number}
        {season.active && <span className="muted" style={{ fontWeight: "normal" }}>{" "}- active</span>}
      </strong>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {season.total} matches - {sharePct}% in the last 3 days
      </div>
      <svg
        viewBox={`0 0 ${SEASON_CHART_WIDTH} ${SEASON_CHART_HEIGHT}`}
        width="100%"
        height={SEASON_CHART_HEIGHT}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Matches per day since start, season ${season.number}`}
      >
        {season.dayCounts.map((count, day) => {
          const barHeight = maxDay > 0 ? (count / maxDay) * SEASON_PLOT_HEIGHT : 0;
          return (
            <rect
              key={day}
              x={day * barWidth}
              y={SEASON_PLOT_BOTTOM - barHeight}
              width={Math.max(barWidth - 1, 1)}
              height={barHeight}
              fill="var(--accent-2)"
            >
              <title>
                Day {day}: {count} match{count === 1 ? "" : "es"}
              </title>
            </rect>
          );
        })}
        {season.endDay !== null && (
          <line
            x1={season.endDay * barWidth + barWidth / 2}
            x2={season.endDay * barWidth + barWidth / 2}
            y1={0}
            y2={SEASON_PLOT_BOTTOM}
            stroke="var(--muted)"
            strokeDasharray="4 3"
          />
        )}
        <line x1={0} x2={SEASON_CHART_WIDTH} y1={SEASON_PLOT_BOTTOM} y2={SEASON_PLOT_BOTTOM} stroke="var(--border)" />
      </svg>
    </div>
  );
}
