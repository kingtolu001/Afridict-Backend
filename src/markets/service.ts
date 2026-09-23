import { randomUUID } from 'node:crypto';
import type { MarketTerms } from '../contracts.js';
import type { Sql } from '../platform/database.js';
import { hash, record } from '../platform/commands.js';
import { requireCondition } from '../platform/errors.js';
import { hasRole, type Account } from '../identity/auth.js';
import { validateTerms } from './domain.js';

export interface MarketRow {
  id: string; creator_id: string; source_proposal_id: string | null;
  state: 'draft' | 'review' | 'rejected' | 'scheduled'; version: number;
  terms: MarketTerms; policy_hash: string; created_at: Date; updated_at: Date; published_at: Date | null;
}
export function publicMarket(m: MarketRow,tradingEnabled=false) {
  return { id: m.id, state: m.state, version: m.version, terms: m.terms, policy_hash: m.policy_hash,
    created_at: new Date(m.created_at).toISOString(), updated_at: new Date(m.updated_at).toISOString(),
    published_at: m.published_at ? new Date(m.published_at).toISOString() : null, trading_enabled: tradingEnabled };
}
export const reviewRoles: Record<string, string> = { product: 'market_approver', legal: 'legal_reviewer',
  integrity: 'integrity_reviewer', resolution: 'resolution_reviewer' };
export async function getMarket(sql: Sql, id: string, lock = false) {
  const market = (await sql.query<MarketRow>(`SELECT * FROM markets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  requireCondition(market, 404, 'NOT_FOUND', 'Market not found.');
  return market;
}
export function mayReadDraft(account: Account, market: MarketRow) {
  if (market.creator_id === account.id) return;
  hasRole(account, 'market_approver', 'legal_reviewer', 'integrity_reviewer', 'resolution_reviewer', 'auditor');
}
export async function approvedTemplate(sql: Sql, terms: MarketTerms) {
  const row = (await sql.query<{ approved: boolean; market_type: string }>(
    'SELECT approved,market_type FROM market_templates WHERE id=$1 AND version=$2 FOR SHARE',
    [terms.template_id, terms.template_version])).rows[0];
  requireCondition(row?.approved && row.market_type === terms.market_type, 422, 'TEMPLATE_NOT_APPROVED', 'An approved template matching this market structure is required.');
}
export async function approvedReferences(sql: Sql, terms: MarketTerms) {
  for (const source of [terms.resolution.primary_source, ...terms.resolution.fallback_sources]) {
    const row = (await sql.query<{ approved: boolean }>(`SELECT approved FROM evidence_sources
      WHERE name=$1 AND uri=$2 FOR SHARE`, [source.name, source.uri])).rows[0];
    requireCondition(row?.approved, 422, 'SOURCE_NOT_APPROVED', 'Every primary and fallback evidence source must be approved in the source registry.');
  }
  const refs = [
    ['eligibility', terms.risk.eligibility_policy_ref], ['adjudication', terms.resolution.adjudicator_policy_ref],
    ['bond', terms.resolution.bond_policy_ref], ['payout', terms.resolution.payout_policy_ref],
    ['collateral', terms.risk.settlement_asset_ref],
  ];
  for (const [kind, ref] of refs) {
    const row = (await sql.query<{ approved: boolean }>(`SELECT approved FROM policy_registry
      WHERE kind=$1 AND policy_ref=$2 FOR SHARE`, [kind, ref])).rows[0];
    requireCondition(row?.approved, 422, 'POLICY_NOT_APPROVED', 'The market uses an unapproved financial or governance policy reference.');
  }
}
export async function createDraft(sql: Sql, a: Account, terms: MarketTerms, request: string, proposalId?: string) {
  validateTerms(terms);
  await approvedTemplate(sql, terms); await approvedReferences(sql, terms);
  if (proposalId) {
    const proposal = (await sql.query<{ status: string; terms: MarketTerms }>(
      'SELECT status,terms FROM market_proposals WHERE id=$1 FOR UPDATE', [proposalId])).rows[0];
    requireCondition(proposal, 404, 'NOT_FOUND', 'Proposal not found.');
    requireCondition(proposal.status === 'submitted' && hash(proposal.terms) === hash(terms), 409, 'PROPOSAL_CONFLICT', 'The proposal must be submitted and match the draft terms exactly.');
  }
  const id = randomUUID();
  const row = (await sql.query<MarketRow>(`INSERT INTO markets(id,creator_id,source_proposal_id,terms,policy_hash)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, a.id, proposalId ?? null, JSON.stringify(terms), hash(terms)])).rows[0]!;
  if (proposalId) await sql.query("UPDATE market_proposals SET status='accepted' WHERE id=$1", [proposalId]);
  await record(sql, { actor: a.id, authority: 'market_creator', action: 'market.drafted', resource: id,
    request, reason: proposalId ? 'Draft from governed proposal' : 'Create market draft', after: publicMarket(row) });
  return publicMarket(row);
}
export async function editDraft(sql: Sql, a: Account, id: string, version: number, terms: MarketTerms, reason: string, request: string) {
  const before = await getMarket(sql, id, true);
  requireCondition(before.creator_id === a.id, 403, 'FORBIDDEN', 'Only the draft creator may revise these terms.');
  requireCondition(['draft', 'rejected'].includes(before.state) && before.version === version, 409, 'VERSION_OR_STATE_CONFLICT', 'Refresh the market; this version cannot be edited.');
  validateTerms(terms); await approvedTemplate(sql, terms); await approvedReferences(sql, terms);
  const after = (await sql.query<MarketRow>(`UPDATE markets SET terms=$2, policy_hash=$3, version=version+1,
    state='draft',updated_at=now() WHERE id=$1 RETURNING *`, [id, JSON.stringify(terms), hash(terms)])).rows[0]!;
  await record(sql, { actor: a.id, authority: 'market_creator', action: 'market.revised', resource: id,
    request, reason, before: publicMarket(before), after: publicMarket(after) });
  return publicMarket(after);
}
export async function submitDraft(sql: Sql, a: Account, id: string, version: number, reason: string, request: string) {
  const before = await getMarket(sql, id, true);
  requireCondition(before.creator_id === a.id, 403, 'FORBIDDEN', 'Only the creator may submit this draft.');
  requireCondition(before.state === 'draft' && before.version === version, 409, 'VERSION_OR_STATE_CONFLICT', 'Refresh the market; only the current draft can be submitted.');
  validateTerms(before.terms); await approvedTemplate(sql, before.terms); await approvedReferences(sql, before.terms);
  const after = (await sql.query<MarketRow>("UPDATE markets SET state='review',updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0]!;
  await record(sql, { actor: a.id, authority: 'market_creator', action: 'market.submitted', resource: id,
    request, reason, before: publicMarket(before), after: publicMarket(after) });
  return publicMarket(after);
}
export async function independent(sql: Sql, a: Account, market: MarketRow) {
  requireCondition(market.creator_id !== a.id, 403, 'SEPARATION_OF_DUTIES', 'The creator cannot review or publish this market.');
  if (market.source_proposal_id) {
    const original = (await sql.query<{ proposer_id: string }>('SELECT proposer_id FROM market_proposals WHERE id=$1', [market.source_proposal_id])).rows[0];
    requireCondition(original?.proposer_id !== a.id, 403, 'SEPARATION_OF_DUTIES', 'The original proposer cannot review or publish this market.');
  }
}
export async function reviewMarket(sql: Sql, a: Account, id: string, input: {
  expected_version: number; review_type: string; decision: string; reason: string; evidence_ref: string;
}, request: string) {
  const role = reviewRoles[input.review_type];
  requireCondition(role, 400, 'VALIDATION_FAILED', 'Unknown review type.'); hasRole(a, role);
  const market = await getMarket(sql, id, true); await independent(sql, a, market);
  requireCondition(market.state === 'review' && market.version === input.expected_version, 409, 'VERSION_OR_STATE_CONFLICT', 'Only the submitted current policy version may be reviewed.');
  const priorReviewers = (await sql.query<{ reviewer_id: string }>(`SELECT reviewer_id FROM market_reviews
    WHERE market_id=$1 AND market_version=$2`, [id, market.version])).rows;
  requireCondition(!priorReviewers.some(r => r.reviewer_id === a.id), 403, 'SEPARATION_OF_DUTIES', 'Each policy review requires a distinct reviewer.');
  const exists = (await sql.query('SELECT id FROM market_reviews WHERE market_id=$1 AND market_version=$2 AND review_type=$3', [id, market.version, input.review_type])).rows.length;
  requireCondition(!exists, 409, 'REVIEW_ALREADY_RECORDED', 'This review type has already been recorded for this version.');
  const row = (await sql.query(`INSERT INTO market_reviews
    (id,market_id,market_version,reviewer_id,review_type,decision,policy_hash,reason,evidence_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,market_id,market_version,review_type,decision,policy_hash,created_at`,
    [randomUUID(), id, market.version, a.id, input.review_type, input.decision, market.policy_hash, input.reason, input.evidence_ref])).rows[0]!;
  if (input.decision === 'rejected') await sql.query("UPDATE markets SET state='rejected',updated_at=now() WHERE id=$1", [id]);
  await record(sql, { actor: a.id, authority: role, action: 'market.reviewed', resource: id, request,
    reason: input.reason, evidence: input.evidence_ref, before: { state: market.state, policy_hash: market.policy_hash },
    after: row, result: input.decision });
  return row;
}
export async function publish(sql: Sql, a: Account, id: string, version: number, reason: string, request: string) {
  const before = await getMarket(sql, id, true); await independent(sql, a, before);
  requireCondition(before.state === 'review' && before.version === version, 409, 'VERSION_OR_STATE_CONFLICT', 'Only the reviewed current version may be published.');
  validateTerms(before.terms); await approvedTemplate(sql, before.terms); await approvedReferences(sql, before.terms);
  const reviews = (await sql.query<{ review_type: string }>(`SELECT review_type FROM market_reviews WHERE market_id=$1
    AND market_version=$2 AND policy_hash=$3 AND decision='approved'`, [id, version, before.policy_hash])).rows;
  requireCondition(Object.keys(reviewRoles).every(type => reviews.some(r => r.review_type === type)), 409, 'REVIEWS_REQUIRED', 'Product, legal, integrity and resolution approvals must cover this exact policy hash.');
  for (const country of [...before.terms.jurisdictions].sort()) {
    const policy = (await sql.query<{ publication_allowed: boolean }>(`SELECT publication_allowed FROM country_policies
      WHERE jurisdiction=$1 AND category=$2 FOR SHARE`, [country, before.terms.category])).rows[0];
    requireCondition(policy?.publication_allowed, 403, 'COUNTRY_POLICY_BLOCKED', 'Publication is not approved for every requested country and category.');
  }
  const after = (await sql.query<MarketRow>("UPDATE markets SET state='scheduled',published_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0]!;
  await record(sql, { actor: a.id, authority: 'market_approver', action: 'market.published', resource: id,
    request, reason, before: publicMarket(before), after: publicMarket(after) });
  return publicMarket(after);
}
