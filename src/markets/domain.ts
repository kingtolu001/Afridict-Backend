import type { MarketTerms } from '../contracts.js';
import { requireCondition } from '../platform/errors.js';
import { integer } from '../financial/model.js';

export function validateTerms(t: MarketTerms, now = Date.now()) {
  const check = (condition: unknown, message: string) => requireCondition(condition, 422, 'INVALID_MARKET_POLICY', message);
  const ids = t.outcomes.map(o => o.id);
  check(new Set(ids).size === ids.length, 'Outcome identifiers must be unique.');
  check(new Set(t.outcomes.map(o => o.label.trim().toLocaleLowerCase('en'))).size === ids.length, 'Outcome labels must be unique.');
  check(t.outcomes.every(o => o.label.trim().length > 0), 'Outcome labels must not be blank.');
  check(t.outcomes.every(o => o.image_url === undefined), 'Outcome image URLs are server-owned and cannot be supplied in market terms.');
  check(t.outcomes.every(o => o.image_alt === undefined || o.image_media_id !== undefined), 'Outcome image alternative text requires an uploaded image.');
  check(t.question.trim().length >= 10, 'The question must contain at least ten meaningful characters.');
  if (t.market_type === 'binary') check(ids.length === 2 && ids[0] === 'yes' && ids[1] === 'no', 'Binary outcomes must be yes, no in that order.');
  if (t.market_type === 'scalar') {
    check(ids.length === 2 && ids[0] === 'short' && ids[1] === 'long', 'Scalar outcomes must be short, long in that order.');
    const range = t.scalar_range;
    check(range, 'Scalar markets require a range.');
    check(BigInt(range!.upper) > BigInt(range!.lower), 'Scalar upper bound must exceed its lower bound.');
  } else check(t.scalar_range === undefined, 'Only scalar markets may specify a scalar range.');
  const open = Date.parse(t.open_at), close = Date.parse(t.trading_cutoff), event = Date.parse(t.expected_event_at), deadline = Date.parse(t.resolution_deadline);
  check(open > now && open < close && close <= event && event < deadline, 'Times must satisfy now < open < cutoff <= expected event < resolution deadline.');
  check(deadline - event >= (t.resolution.challenge_window_seconds + t.resolution.timelock_seconds) * 1000,
    'Resolution deadline must allow the challenge window and timelock after the event.');
  try { new Intl.DateTimeFormat('en', { timeZone: t.resolution.timezone }); }
  catch { check(false, 'A valid IANA timezone is required.'); }
  check(t.resolution.adjudication_threshold <= t.resolution.panel_size &&
    t.resolution.adjudication_threshold > t.resolution.panel_size / 2, 'Adjudication requires a strict majority within the panel size.');
  const sources = [t.resolution.primary_source, ...t.resolution.fallback_sources];
  for (const source of sources) {
    const url = new URL(source.uri);
    check(!url.username && !url.password, 'Evidence references must not contain credentials.');
  }
  check(new Set(sources.map(s => s.uri)).size === sources.length, 'Primary and fallback source references must be distinct.');
  try {
    check(integer(t.risk.exposure_limit_minor) > 0n, 'Exposure limit must be positive.');
    const subsidy = integer(t.liquidity.subsidy_limit_minor), inventory = integer(t.liquidity.inventory_limit_minor), loss = integer(t.liquidity.loss_limit_minor);
    check(loss <= subsidy, 'AMM loss limit cannot exceed the approved subsidy.');
    if (t.liquidity.amm_enabled) check(subsidy > 0n && inventory > 0n && loss > 0n, 'Enabled AMM requires positive subsidy, inventory and loss bounds.');
    else check(subsidy === 0n && inventory === 0n && loss === 0n, 'Disabled AMM must have zero financial limits.');
  } catch (error) {
    if (error instanceof Error && error.name === 'Error' && !('statusCode' in error)) check(false, 'Financial limits must be bounded exact integer strings.');
    throw error;
  }
}
