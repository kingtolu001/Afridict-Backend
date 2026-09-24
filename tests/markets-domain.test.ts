import { describe, expect, it } from 'vitest';
import { terms } from '../scripts/fixtures.js';
import type { MarketTerms } from '../src/contracts.js';
import { validateTerms } from '../src/markets/domain.js';

const NOW = Date.parse('2098-01-01T00:00:00.000Z');

function rejects(change: (value: MarketTerms) => void, message: string, kind: 'binary' | 'categorical' | 'scalar' = 'binary') {
  const value = terms(kind);
  change(value);
  expect(() => validateTerms(value, NOW)).toThrow(message);
}

describe('market policy invariants', () => {
  it('accepts each supported market structure under a complete policy', () => {
    for (const kind of ['binary', 'categorical', 'scalar'] as const) expect(() => validateTerms(terms(kind), NOW)).not.toThrow();
  });

  it('requires unique, meaningful outcomes and canonical binary ordering', () => {
    rejects(value => { value.outcomes[1]!.id = value.outcomes[0]!.id; }, 'identifiers must be unique');
    rejects(value => { value.outcomes[1]!.label = ' YES '; }, 'labels must be unique');
    rejects(value => { value.outcomes[1]!.label = ' '; }, 'must not be blank');
    rejects(value => { value.outcomes.reverse(); }, 'yes, no in that order');
    rejects(value => { value.outcomes[0]!.image_url = 'https://cdn.example.com/outcome.png'; }, 'server-owned');
    rejects(value => { value.outcomes[0]!.image_alt = 'Candidate portrait'; }, 'requires an uploaded image');
  });

  it('binds scalar ranges to scalar markets and requires increasing bounds', () => {
    rejects(value => { value.scalar_range = { lower: '0', upper: '1', decimals: 0, unit: 'point' }; }, 'Only scalar markets');
    rejects(value => { value.scalar_range = undefined; }, 'require a range', 'scalar');
    rejects(value => { value.scalar_range!.upper = value.scalar_range!.lower; }, 'must exceed', 'scalar');
  });

  it('enforces the complete scheduling and resolution window', () => {
    rejects(value => { value.open_at = '2097-12-31T23:59:59.000Z'; }, 'Times must satisfy');
    rejects(value => { value.expected_event_at = value.trading_cutoff; value.resolution_deadline = '2099-01-02T12:00:00.000Z'; },
      'must allow the challenge window');
  });

  it('requires a valid timezone and a strict independent majority', () => {
    rejects(value => { value.resolution.timezone = 'Mars/Olympus'; }, 'valid IANA timezone');
    rejects(value => { value.resolution.adjudication_threshold = 1; }, 'strict majority');
    rejects(value => { value.resolution.adjudication_threshold = 4; }, 'within the panel size');
  });

  it('rejects credential-bearing and duplicate evidence references', () => {
    rejects(value => { value.resolution.primary_source.uri = 'https://user:password@example.com/result'; }, 'must not contain credentials');
    rejects(value => { value.resolution.fallback_sources[0]!.uri = value.resolution.primary_source.uri; }, 'must be distinct');
  });

  it('keeps financial limits exact, positive, and bounded by approved subsidy', () => {
    rejects(value => { value.risk.exposure_limit_minor = '0'; }, 'Exposure limit must be positive');
    rejects(value => { value.risk.exposure_limit_minor = '01'; }, 'exact integer strings');
    rejects(value => { value.liquidity.subsidy_limit_minor = '1'; value.liquidity.loss_limit_minor = '1'; },
      'Disabled AMM must have zero');
    rejects(value => {
      value.liquidity.amm_enabled = true;
      value.liquidity.subsidy_limit_minor = '10';
      value.liquidity.inventory_limit_minor = '10';
      value.liquidity.loss_limit_minor = '11';
    }, 'cannot exceed');
  });
});
