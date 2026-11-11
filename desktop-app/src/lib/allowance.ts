// Turns Puter's monthly allowance numbers into something readable.
// Free accounts are never charged: when the allowance is used up, Puter
// refuses requests until it resets next month. Showing what is left lets
// the user see that coming.

/** Puter reports money in micro-cents: $0.01 = 1,000,000. */
const MICROCENTS_PER_DOLLAR = 100_000_000;
/** gpt-transcribe, Puter's default speech model: $0.0045 per minute of audio sent. */
const DOLLARS_PER_AUDIO_MINUTE = 0.0045;
/** Below this share of the allowance left, the overlay warns once. */
const LOW_SHARE = 0.1;

/** Values from `puter.auth.getMonthlyUsage().allowanceInfo`, in micro-cents. */
export interface Allowance {
  allowance: number;
  remaining: number;
}

export interface AllowanceSummary {
  usedPercent: number;
  remainingDollars: number;
  allowanceDollars: number;
  /** Rough hours of captioning the remaining allowance covers at the current settings. */
  hoursLeft: number;
  low: boolean;
}

/**
 * Minutes of audio sent per minute of speech. Final chunks send each moment
 * about once (plus small overlaps); live previews re-send the recent,
 * not-yet-final audio about once a second, roughly four times as much in total.
 */
export function audioPerSpeechMinute(livePreview: boolean): number {
  return livePreview ? 4 : 1.1;
}

export function summarizeAllowance(a: Allowance, livePreview: boolean): AllowanceSummary {
  const allowance = Math.max(0, a.allowance);
  const remaining = Math.max(0, a.remaining);
  const share = allowance > 0 ? Math.min(1, remaining / allowance) : 0;
  const remainingDollars = remaining / MICROCENTS_PER_DOLLAR;
  return {
    usedPercent: (1 - share) * 100,
    remainingDollars,
    allowanceDollars: allowance / MICROCENTS_PER_DOLLAR,
    hoursLeft: remainingDollars / (DOLLARS_PER_AUDIO_MINUTE * audioPerSpeechMinute(livePreview)) / 60,
    low: share < LOW_SHARE,
  };
}

function money(dollars: number): string {
  return dollars > 0 && dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`;
}

function duration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

export function describeAllowance(s: AllowanceSummary): string {
  return (
    `${Math.round(s.usedPercent)}% of this month's allowance used: ${money(s.remainingDollars)} of ` +
    `${money(s.allowanceDollars)} left, about ${duration(s.hoursLeft)} of captioning at the current settings.`
  );
}
