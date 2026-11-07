import type { Clock } from '../clock';
import { nextRunAt } from '../backup/scheduler';

// The daily survey (design 2026-11-07-poe-switches-design.md, "Survey"): at 03:30 local time (the backup's zone),
// outside the retention run. Driven by the server tick (no timer of its own): a tick at or after the time runs it
// once and computes the next. A cams-admin that was down at 03:30 waits for the next day.
export const SURVEY_AT = '03:30';

export class SurveySchedule {
  private next: number;

  constructor(private d: { clock: Clock; tz: string; at?: string; run: () => void }) {
    this.next = nextRunAt(d.clock.now(), d.at ?? SURVEY_AT, d.tz);
  }

  get nextAt(): number {
    return this.next;
  }

  // True when it ran.
  tick(): boolean {
    const now = this.d.clock.now();
    if (now < this.next) return false;
    this.next = nextRunAt(now, this.d.at ?? SURVEY_AT, this.d.tz);
    this.d.run();
    return true;
  }
}
