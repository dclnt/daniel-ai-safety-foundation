import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { computeWindow, aggregate, type Rows, type Window } from './extract-weekly-progress';

const TZ = 'America/Edmonton';

describe('computeWindow', () => {
  it('normal Thursday cron → prior Thu..Wed window, ISO-W22 label', () => {
    // 2026-06-04 is a Thursday. Yesterday (Wed) = 2026-06-03.
    const now = DateTime.fromISO('2026-06-04T08:00:00Z'); // matches cron 0 8 * * 4
    const w = computeWindow(now, TZ);
    expect(w.weekStart).toBe('2026-05-28'); // a Thursday
    expect(w.weekEnd).toBe('2026-06-03'); // a Wednesday
    expect(w.weekLabel).toBe('2026-W22');
  });

  it('uses ISO week-YEAR at the Dec/Jan boundary (not calendar year)', () => {
    // Run Thursday 2027-01-07 → window Thu 2026-12-31 .. Wed 2027-01-06.
    // The start Thursday 2026-12-31 is ISO 2026-W53, NOT 2027.
    const now = DateTime.fromISO('2027-01-07T08:00:00Z');
    const w = computeWindow(now, TZ);
    expect(w.weekStart).toBe('2026-12-31');
    expect(w.weekEnd).toBe('2027-01-06');
    expect(w.weekLabel).toBe('2026-W53'); // would be wrong as "2027-..." with a naive .year
  });

  it('handles the spring-forward DST week (window spans 167h, not 168h)', () => {
    // Edmonton springs forward Sun 2026-03-08. Window Thu 2026-03-05 .. Wed 2026-03-11.
    const now = DateTime.fromISO('2026-03-12T08:00:00Z'); // Thursday after
    const w = computeWindow(now, TZ);
    expect(w.weekStart).toBe('2026-03-05');
    expect(w.weekEnd).toBe('2026-03-11');
    const hours =
      (DateTime.fromISO(w.endUTC).toMillis() - DateTime.fromISO(w.startUTC).toMillis()) /
      3_600_000;
    // 7 inclusive local days minus the lost DST hour ≈ 167h (rounding off the .999s end).
    expect(Math.round(hours)).toBe(167);
  });

  it('never includes the current unfinished day when run on a Wednesday', () => {
    // Wednesday 2026-06-10 is not over → fall back to the prior completed week.
    const now = DateTime.fromISO('2026-06-10T20:00:00Z');
    const w = computeWindow(now, TZ);
    expect(w.weekEnd).toBe('2026-06-03'); // last completed Wednesday, not 06-10
    expect(w.weekStart).toBe('2026-05-28');
  });

  it('honours an explicit override range', () => {
    const now = DateTime.fromISO('2026-06-04T08:00:00Z');
    const w = computeWindow(now, TZ, { start: '2026-05-21', end: '2026-05-27' });
    expect(w.weekStart).toBe('2026-05-21');
    expect(w.weekEnd).toBe('2026-05-27');
    expect(w.weekLabel).toBe('2026-W21');
  });
});

// Reusable window for aggregate tests.
const W: Window = computeWindow(DateTime.fromISO('2026-06-04T08:00:00Z'), TZ);

describe('aggregate', () => {
  it('zero-activity week: 7 empty days, accuracy null, all days flagged no-activity', () => {
    const rows: Rows = { drills: [], cards: [], milestones: [] };
    const f = aggregate(rows, W, TZ);
    expect(f.days).toHaveLength(7);
    expect(f.days.every((d) => !d.had_activity)).toBe(true);
    expect(f.week_summary.active_days).toBe(0);
    expect(f.week_summary.no_activity_days).toHaveLength(7);
    expect(f.week_summary.avg_drill_accuracy).toBeNull(); // never NaN
    expect(f.days[0].drill_accuracy).toBeNull();
  });

  it('buckets drills/cards/milestones to the right local day and computes accuracy', () => {
    const rows: Rows = {
      drills: [
        // 2026-05-28 local (morning UTC same day): 2 attempts, 1 correct
        { skill_id: 'vertex-form', correct: true, attempted_at: '2026-05-28T15:00:00Z' },
        { skill_id: 'vertex-form', correct: false, attempted_at: '2026-05-28T16:00:00Z' },
        // 2026-05-29 local: 1 attempt, correct, different skill
        { skill_id: 'quadratic-formula', correct: true, attempted_at: '2026-05-29T18:00:00Z' },
      ],
      cards: [
        { lesson_id: 'L1', viewed_at: '2026-05-28T15:30:00Z', completed_at: '2026-05-28T17:00:00Z' },
        { lesson_id: 'L2', viewed_at: '2026-05-29T19:00:00Z', completed_at: null },
      ],
      milestones: [
        { milestone_id: 'M0', passed_at: '2026-05-30T20:00:00Z' },
      ],
    };
    const f = aggregate(rows, W, TZ);

    const d28 = f.days.find((d) => d.date === '2026-05-28')!;
    expect(d28.drill_attempts).toBe(2);
    expect(d28.drill_correct).toBe(1);
    expect(d28.drill_accuracy).toBe(0.5);
    expect(d28.cards_viewed).toBe(1);
    expect(d28.cards_completed).toBe(1);
    expect(d28.skills_practiced).toEqual(['vertex-form']);
    expect(d28.had_activity).toBe(true);

    const d29 = f.days.find((d) => d.date === '2026-05-29')!;
    expect(d29.drill_attempts).toBe(1);
    expect(d29.cards_viewed).toBe(1);
    expect(d29.cards_completed).toBe(0); // completed_at null

    const d30 = f.days.find((d) => d.date === '2026-05-30')!;
    expect(d30.milestones_passed).toEqual(['M0']);
    expect(d30.had_activity).toBe(false); // milestone alone is not drill/card activity (design P2)

    expect(f.week_summary.total_drill_attempts).toBe(3);
    expect(f.week_summary.total_drill_correct).toBe(2);
    expect(f.week_summary.avg_drill_accuracy).toBe(0.67); // 2/3 rounded
    expect(f.week_summary.distinct_lessons_worked).toBe(2);
    expect(f.week_summary.milestones_passed).toEqual(['M0']);
    expect(f.week_summary.active_days).toBe(2);
  });

  it('counts a card completed in-window but viewed before it (completed_at bucketing)', () => {
    const rows: Rows = {
      drills: [],
      // viewed last week, completed on 2026-06-01 (in this window)
      cards: [{ lesson_id: 'L9', viewed_at: '2026-05-20T12:00:00Z', completed_at: '2026-06-01T18:00:00Z' }],
      milestones: [],
    };
    const f = aggregate(rows, W, TZ);
    const d = f.days.find((x) => x.date === '2026-06-01')!;
    expect(d.cards_completed).toBe(1);
    expect(d.cards_viewed).toBe(0); // viewed_at is outside the window
    expect(f.week_summary.total_cards_completed).toBe(1);
  });
});
