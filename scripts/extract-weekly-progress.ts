/**
 * extract-weekly-progress.ts
 * Phase 1 of the weekly progress journal pipeline.
 *
 * Runs in GitHub Actions every Thursday. Pulls the prior Thu->Wed study window
 * from MasteryMaven's Supabase DB via PostgREST, rolls it up into a facts JSON,
 * and writes weekly-facts-<label>.json at the repo root. The workflow step that
 * follows commits it to a branch and opens a draft PR.
 *
 * NO AI. Pure data extraction. Every number traces to a Supabase row.
 *
 *   DATA FLOW
 *   ─────────
 *   computeWindow(now, tz)  ──► { startUTC, endUTC, weekStart, weekEnd, weekLabel }
 *          │
 *          ▼
 *   fetchRows()  ── PostgREST GET ×3 (TIMESTAMPTZ filtered in UTC) ──► Rows
 *          │
 *          ▼
 *   aggregate(rows, window, tz)  ── per-day rollup + week_summary ──► Facts
 *          │
 *          ▼
 *   write weekly-facts-<label>.json  +  emit GITHUB_OUTPUT
 *
 * Schema (verified against migrations 0001 / 0006 / 0022):
 *   drill_attempts      (user_id, skill_id TEXT, correct BOOL, attempted_at TIMESTAMPTZ)
 *   lesson_completions  (user_id, lesson_id, viewed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ NULL)  -- per CARD
 *   milestone_capstones (user_id, milestone_id 'M0'..'M8', passed_at TIMESTAMPTZ NULL)
 */

import { DateTime } from 'luxon';
import { appendFileSync, writeFileSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Window {
  /** Inclusive UTC instant of the window start (local Thursday 00:00:00.000). */
  startUTC: string;
  /** Inclusive UTC instant of the window end (local Wednesday 23:59:59.999). */
  endUTC: string;
  /** Local date of the window start, YYYY-MM-DD (a Thursday). */
  weekStart: string;
  /** Local date of the window end, YYYY-MM-DD (a Wednesday). */
  weekEnd: string;
  /** ISO-week label of weekStart, e.g. "2026-W22". Uses ISO week-YEAR, not calendar year. */
  weekLabel: string;
}

export interface DrillRow { skill_id: string; correct: boolean; attempted_at: string; }
export interface CardRow { lesson_id: string; viewed_at: string; completed_at: string | null; }
export interface MilestoneRow { milestone_id: string; passed_at: string; }

export interface Rows { drills: DrillRow[]; cards: CardRow[]; milestones: MilestoneRow[]; }

export interface DayFacts {
  date: string;
  had_activity: boolean;
  drill_attempts: number;
  drill_correct: number;
  drill_accuracy: number | null;
  cards_viewed: number;
  cards_completed: number;
  skills_practiced: string[];
  milestones_passed: string[];
}

export interface WeekSummary {
  week_label: string;
  active_days: number;
  no_activity_days: string[];
  total_drill_attempts: number;
  total_drill_correct: number;
  avg_drill_accuracy: number | null;
  total_cards_completed: number;
  distinct_lessons_worked: number;
  milestones_passed: string[];
  source_tables: string[];
}

export interface Facts {
  week_label: string;
  week_start: string;
  week_end: string;
  generated_at: string;
  timezone: string;
  days: DayFacts[];
  week_summary: WeekSummary;
}

// ─── Pure window math (unit-tested) ─────────────────────────────────────────

/**
 * Compute the most recent completed Thu->Wed window in `tz`.
 *
 * On the Thursday cron trigger, "this Wednesday" is yesterday, so the window is
 * the 7 days [last Thursday 00:00:00.000 .. this Wednesday 23:59:59.999] local.
 * Run on any other day, it returns the most recent *completed* Thu->Wed week
 * (a window never includes the current, unfinished day).
 *
 * `override` lets workflow_dispatch pass an explicit local date range.
 */
export function computeWindow(
  now: DateTime,
  tz: string,
  override?: { start: string; end: string },
): Window {
  const local = now.setZone(tz);

  let startDay: DateTime;
  let endDay: DateTime;

  if (override) {
    startDay = DateTime.fromISO(override.start, { zone: tz }).startOf('day');
    endDay = DateTime.fromISO(override.end, { zone: tz }).startOf('day');
  } else {
    // Luxon weekday: Mon=1 .. Wed=3 .. Thu=4 .. Sun=7.
    const today = local.startOf('day');
    let daysSinceWed = (today.weekday - 3 + 7) % 7;
    // If today IS Wednesday it isn't finished yet, so fall back to last week's.
    if (daysSinceWed === 0) daysSinceWed = 7;
    endDay = today.minus({ days: daysSinceWed }); // most recent completed Wednesday
    startDay = endDay.minus({ days: 6 }); // the Thursday 6 days before it
  }

  const start = startDay.startOf('day');
  const end = endDay.endOf('day'); // 23:59:59.999 local

  return {
    startUTC: start.toUTC().toISO()!,
    endUTC: end.toUTC().toISO()!,
    weekStart: start.toISODate()!,
    weekEnd: end.toISODate()!,
    // weekYear + weekNumber are ISO-8601: correct across the Dec/Jan boundary.
    weekLabel: `${start.weekYear}-W${String(start.weekNumber).padStart(2, '0')}`,
  };
}

// ─── Pure aggregation (unit-tested) ─────────────────────────────────────────

/** Bucket a TIMESTAMPTZ to its local calendar date (YYYY-MM-DD) in `tz`. */
function localDate(ts: string, tz: string): string {
  return DateTime.fromISO(ts, { zone: 'utc' }).setZone(tz).toISODate()!;
}

/** Every local date in [weekStart, weekEnd] inclusive (always 7 for a normal week). */
function dateRange(weekStart: string, weekEnd: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(weekStart);
  const last = DateTime.fromISO(weekEnd);
  while (d <= last) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

/**
 * Roll raw rows up into the facts JSON. No AI, no estimates.
 * `accuracy` is null (never NaN) when there are zero attempts.
 */
export function aggregate(rows: Rows, w: Window, tz: string): Facts {
  const dates = dateRange(w.weekStart, w.weekEnd);

  const days: DayFacts[] = dates.map((date) => {
    const dayDrills = rows.drills.filter((r) => localDate(r.attempted_at, tz) === date);
    const drillAttempts = dayDrills.length;
    const drillCorrect = dayDrills.filter((r) => r.correct).length;

    const cardsViewed = rows.cards.filter((r) => localDate(r.viewed_at, tz) === date).length;
    const cardsCompleted = rows.cards.filter(
      (r) => r.completed_at != null && localDate(r.completed_at, tz) === date,
    ).length;

    const skills = [...new Set(dayDrills.map((r) => r.skill_id))].sort();
    const milestones = [
      ...new Set(
        rows.milestones
          .filter((r) => localDate(r.passed_at, tz) === date)
          .map((r) => r.milestone_id),
      ),
    ].sort();

    return {
      date,
      had_activity: drillAttempts > 0 || cardsViewed > 0, // design P2
      drill_attempts: drillAttempts,
      drill_correct: drillCorrect,
      drill_accuracy: drillAttempts > 0 ? round2(drillCorrect / drillAttempts) : null,
      cards_viewed: cardsViewed,
      cards_completed: cardsCompleted,
      skills_practiced: skills,
      milestones_passed: milestones,
    };
  });

  const totalAttempts = days.reduce((s, d) => s + d.drill_attempts, 0);
  const totalCorrect = days.reduce((s, d) => s + d.drill_correct, 0);
  const distinctLessons = new Set(rows.cards.map((r) => r.lesson_id)).size;
  const milestonesPassed = [...new Set(days.flatMap((d) => d.milestones_passed))].sort();

  const summary: WeekSummary = {
    week_label: w.weekLabel,
    active_days: days.filter((d) => d.had_activity).length,
    no_activity_days: days.filter((d) => !d.had_activity).map((d) => d.date),
    total_drill_attempts: totalAttempts,
    total_drill_correct: totalCorrect,
    avg_drill_accuracy: totalAttempts > 0 ? round2(totalCorrect / totalAttempts) : null,
    total_cards_completed: days.reduce((s, d) => s + d.cards_completed, 0),
    distinct_lessons_worked: distinctLessons,
    milestones_passed: milestonesPassed,
    source_tables: ['drill_attempts', 'lesson_completions', 'milestone_capstones'],
  };

  return {
    week_label: w.weekLabel,
    week_start: w.weekStart,
    week_end: w.weekEnd,
    generated_at: DateTime.utc().toISO()!,
    timezone: tz,
    days,
    week_summary: summary,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── PostgREST I/O ──────────────────────────────────────────────────────────

interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
  timezone: string;
}

async function pgGet<T>(cfg: Config, path: string): Promise<T[]> {
  const url = `${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostgREST ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T[];
}

async function fetchRows(cfg: Config, w: Window): Promise<Rows> {
  const uid = encodeURIComponent(cfg.userId);
  const s = encodeURIComponent(w.startUTC);
  const e = encodeURIComponent(w.endUTC);

  const drills = await pgGet<DrillRow>(
    cfg,
    `drill_attempts?user_id=eq.${uid}` +
      `&attempted_at=gte.${s}&attempted_at=lte.${e}` +
      `&select=skill_id,correct,attempted_at`,
  );

  // A card counts if it was viewed OR completed in the window (a card completed
  // this week but viewed earlier still belongs to this week's "cards_completed").
  const cards = await pgGet<CardRow>(
    cfg,
    `lesson_completions?user_id=eq.${uid}` +
      `&or=(and(viewed_at.gte.${s},viewed_at.lte.${e}),and(completed_at.gte.${s},completed_at.lte.${e}))` +
      `&select=lesson_id,viewed_at,completed_at`,
  );

  const milestones = await pgGet<MilestoneRow>(
    cfg,
    `milestone_capstones?user_id=eq.${uid}` +
      `&passed_at=gte.${s}&passed_at=lte.${e}` +
      `&select=milestone_id,passed_at`,
  );

  return { drills, cards, milestones };
}

// ─── Entry point ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cfg: Config = {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    userId: requireEnv('USER_ID'),
    timezone: process.env.TIMEZONE || 'America/Edmonton',
  };

  const startOverride = process.env.START_DATE;
  const endOverride = process.env.END_DATE;
  const override =
    startOverride && endOverride ? { start: startOverride, end: endOverride } : undefined;

  const w = computeWindow(DateTime.utc(), cfg.timezone, override);
  console.log(`Window: ${w.weekStart} .. ${w.weekEnd}  (${w.weekLabel})`);
  console.log(`UTC:    ${w.startUTC} .. ${w.endUTC}`);

  const rows = await fetchRows(cfg, w);
  console.log(
    `Rows: ${rows.drills.length} drills, ${rows.cards.length} cards, ${rows.milestones.length} milestones`,
  );

  const facts = aggregate(rows, w, cfg.timezone);
  const factsFile = `weekly-facts-${w.weekLabel}.json`;
  writeFileSync(factsFile, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${factsFile} — active_days=${facts.week_summary.active_days}`);

  // Hand the branch/PR step its inputs.
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(
      ghOut,
      `week_label=${w.weekLabel}\nbranch=weekly-log/${w.weekLabel}\nfacts_file=${factsFile}\n`,
    );
  }
}

// Only run when executed directly (not when imported by the test file).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
