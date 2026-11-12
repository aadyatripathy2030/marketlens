// Settings read by more than one file, parsed once here, so the terms page
// and the ledger can never disagree about them. (AFFILIATE_SHARE=abc used to
// credit 0% in the ledger while the terms page promised 25%.)
const numOr = (v, d) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : d; };
const AFF_SHARE = numOr(process.env.AFFILIATE_SHARE, 25);          // percent of each payment
module.exports = {
  AFF_SHARE,
  AFFILIATE_SHARE: String(AFF_SHARE),
  AFFILIATE_MONTHS: numOr(process.env.AFFILIATE_MONTHS, 12),
  AFFILIATE_MIN_PAYOUT: numOr(process.env.AFFILIATE_MIN_PAYOUT, 25),
  CONTACT_EMAIL: (process.env.CONTACT_EMAIL || '[CONTACT EMAIL ON CHARTGAUGE.COM]').trim(),
  TRIAL_DAYS: Number(process.env.TRIAL_DAYS || 14),
  FREE_UNTIL: Date.parse(process.env.FREE_UNTIL || '2026-10-18T00:00:00Z'),
};
