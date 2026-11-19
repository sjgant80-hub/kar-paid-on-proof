// cost.mjs — the staff time the gate takes off a team, priced at the floor (pure, never throws).
//
// Without the gate, a person checks each agent-bought deliverable against its sources before the payment
// is approved. With it, the check is the verifier's and the chain's. The only sourced figure is the floor
// rate: the UK National Living Wage from 1 April 2026, GBP 12.71 an hour (gov.uk), before employer NI and
// pension, so the result is a floor, not an estimate. Jobs and minutes are the buyer's own numbers.

export const NLW_2026_GBP = 12.71;
export const NLW_SOURCE = 'UK National Living Wage from 1 April 2026: GBP 12.71/hour (gov.uk, National Minimum Wage and National Living Wage rates)';

// input: { jobsPerMonth, minutesPerCheck, hourlyRate? }  ->  { hoursPerMonth, perMonth, perYear, rate } or null
export function staffTime(input) {
  try {
    const jobs = Number(input.jobsPerMonth);
    const minutes = Number(input.minutesPerCheck);
    const rate = input.hourlyRate === undefined ? NLW_2026_GBP : Number(input.hourlyRate);
    if (!(jobs >= 0) || !(minutes >= 0) || !(rate >= 0)) return null;
    if (!Number.isFinite(jobs * minutes * rate)) return null;
    const hoursPerMonth = (jobs * minutes) / 60;
    const perMonth = hoursPerMonth * rate;
    return { hoursPerMonth, perMonth, perYear: perMonth * 12, rate };
  } catch {
    return null;
  }
}
