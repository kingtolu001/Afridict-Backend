import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth, demoConfig, seedDemo, terms } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { postgres, type Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';

let db: Database, app: FastifyInstance;
let key = 0;
const auth = (name: string) => ({ authorization: `Bearer demo.${name}` });
const write = async (name: string, method: 'POST' | 'PUT', url: string, payload: unknown, reuse?: string) => app.inject({
  method, url, headers: { ...auth(name), 'idempotency-key': reuse ?? `test-key-${++key}` }, payload: payload as Record<string, unknown>,
});
const read = (name: string, url: string) => app.inject({ method: 'GET', url, headers: auth(name) });
const create = async (kind: 'binary' | 'categorical' | 'scalar' = 'binary') => {
  const response = await write('creator', 'POST', '/v1/admin/markets', { terms: terms(kind) });
  expect(response.statusCode, response.body).toBe(201); return response.json<{ id: string; policy_hash: string }>();
};
const submit = async (id: string) => {
  const response = await write('creator','POST',`/v1/admin/markets/${id}/submit`,{ expected_version: 1, reason: 'Submit for independent review' });
  expect(response.statusCode, response.body).toBe(200);
};
const review = (persona: string, id: string, type: string, decision = 'approved', reuse?: string) =>
  write(persona,'POST',`/v1/admin/markets/${id}/reviews`,{
    expected_version: 1, review_type: type, decision, reason: 'Synthetic assessment only', evidence_ref: 'test:review',
  }, reuse);
const allReviews = async (id: string) => {
  for (const [type, persona] of [['product','approver'],['legal','legal'],['integrity','integrity'],['resolution','resolution']]) {
    const result = await review(persona!, id, type!); expect(result.statusCode, result.body).toBe(201);
  }
};
const publish = (name: string, id: string) => write(name,'POST',`/v1/admin/markets/${id}/publish`,{
  expected_version: 1, reason: 'Publish synthetic reviewed metadata',
});

beforeAll(async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    if (new URL(testUrl).pathname !== '/afridict_test') throw new Error('Refusing to run tests against a non-test database');
    db = postgres(testUrl);
  } else db = await embeddedDatabase();
  await migrate(db); await seedDemo(db); app = await buildApp(db, demoConfig, demoAuth);
});
afterAll(async () => { if (app) await app.close(); if (db) await db.close(); });

describe('identity and governance boundaries', () => {
  it('publishes only non-secret normalized authentication configuration',async()=>{
    const response=await app.inject({method:'GET',url:'/v1/auth/configuration'});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({methods:[{id:'password',enabled:false},{id:'google',enabled:false}],
      oidc:{authorization_url:null,client_id:null,audience:null,pkce:'S256'},registration_available:false,
      account_linking:'verified_provider_subject'});
    expect(response.body).not.toMatch(/secret|credential/i);
  });
  it('starts with denied eligibility and never advertises trading', async () => {
    const me = await read('trader','/v1/me'); expect(me.statusCode).toBe(200);
    expect(me.json()).not.toHaveProperty('subject');
    const eligibility = await read('trader','/v1/eligibility');
    expect(eligibility.json()).toMatchObject({ status: 'pending', trading_enabled: false });
    expect(eligibility.headers['x-request-id']).toMatch(/^req_/);
    expect((await read('invalid','/v1/me')).statusCode).toBe(401);
    const capabilities=(await read('trader','/v1/me/capabilities')).json<Record<string,{allowed:boolean;requirements:string[]}>>();
    expect(capabilities.BROWSE!.allowed).toBe(true);
    expect(capabilities.WITHDRAW_NGN).toMatchObject({allowed:false});
    expect(capabilities.WITHDRAW_NGN!.requirements).toContain('CAPABILITY_NOT_ACTIVE');
  });
  it('onboards from verified identity without accepting supplied roles or jurisdiction changes', async () => {
    const first = await write('new_user','POST','/v1/onboarding',{ jurisdiction: 'ZZ' },'new-user-onboard');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ roles: ['user'], jurisdiction: 'ZZ' });
    const profile=await write('new_user','POST','/v1/registration/profile',{first_name:'New',last_name:'User',
      email:'new.user@example.com',phone_number:'+2348031234567',terms_version:'test:terms-v1',
      privacy_version:'test:privacy-v1',accepted:true});
    expect(profile.statusCode,profile.body).toBe(201);
    expect(profile.json()).toMatchObject({email:'new.user@example.com',phone_number:'+2348031234567',
      terms_version:'test:terms-v1'});
    expect((await write('new_user','POST','/v1/onboarding',{ jurisdiction: 'ZZ' },'new-user-onboard')).body).toBe(first.body);
    const changed = await write('new_user','POST','/v1/onboarding',{ jurisdiction: 'NG' },'new-user-onboard');
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const untrusted = await write('new_user','POST','/v1/onboarding',{ jurisdiction: 'ZZ', roles: ['market_approver'] });
    expect(untrusted.statusCode).toBe(400);
  });
  it('requires independent compliance actors for eligibility changes', async () => {
    const target = (await read('trader','/v1/me')).json<{ id: string }>().id;
    const proposal = await write('compliance','POST',`/v1/admin/accounts/${target}/eligibility-reviews`,{
      decision: 'eligible', policy_version: 'test:policy', evidence_ref: 'test:evidence', reason: 'Synthetic compliant status',
    });
    expect(proposal.statusCode, proposal.body).toBe(201);
    expect((await read('trader','/v1/eligibility')).json().status).toBe('pending');
    const reviewId = proposal.json<{ id: string }>().id;
    expect((await write('compliance','POST',`/v1/admin/eligibility-reviews/${reviewId}/decision`,{ decision: 'approved', reason: 'Self approval' })).statusCode).toBe(403);
    expect((await write('trader','POST',`/v1/admin/eligibility-reviews/${reviewId}/decision`,{ decision: 'approved', reason: 'User attempt' })).statusCode).toBe(403);
    const approved = await write('other_compliance','POST',`/v1/admin/eligibility-reviews/${reviewId}/decision`,{ decision: 'approved', reason: 'Independent synthetic review' });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await read('trader','/v1/eligibility')).json()).toMatchObject({ status: 'eligible', trading_enabled: false });
    expect((await write('other_compliance','POST',`/v1/admin/eligibility-reviews/${reviewId}/decision`,{ decision: 'approved', reason: 'Another decision' })).statusCode).toBe(409);
  });
  it('blocks publication until all independent reviews and the country gate pass', async () => {
    const market = await create(); await submit(market.id);
    expect((await publish('approver',market.id)).json().code).toBe('REVIEWS_REQUIRED');
    expect((await publish('creator',market.id)).statusCode).toBe(403);
    await allReviews(market.id);
    await db.query("UPDATE country_policies SET publication_allowed=false WHERE jurisdiction='ZZ' AND category='weather'");
    expect((await publish('approver',market.id)).json().code).toBe('COUNTRY_POLICY_BLOCKED');
    await db.query("UPDATE country_policies SET publication_allowed=true WHERE jurisdiction='ZZ' AND category='weather'");
    const published = await publish('approver',market.id);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ state: 'scheduled', policy_hash: market.policy_hash, trading_enabled: false });
    expect((await read('trader',`/v1/markets/${market.id}`)).statusCode).toBe(200);
    expect((await write('creator','PUT',`/v1/admin/markets/${market.id}`,{ expected_version: 1, terms: terms(), reason: 'Illegal edit' })).statusCode).toBe(409);
    await expect(db.query('UPDATE markets SET policy_hash=$2 WHERE id=$1',[market.id,'f'.repeat(64)])).rejects.toThrow();
  });
  it('hides drafts and external proposals from unrelated accounts', async () => {
    const market = await create('categorical');
    expect((await read('trader',`/v1/markets/${market.id}`)).statusCode).toBe(404);
    expect((await read('trader',`/v1/admin/markets/${market.id}`)).statusCode).toBe(403);
    const proposal = await write('proposer','POST','/v1/market-proposals',{ terms: terms('scalar') });
    expect(proposal.statusCode, proposal.body).toBe(201);
    const proposalId = proposal.json<{ id: string }>().id;
    expect((await read('trader',`/v1/market-proposals/${proposalId}`)).statusCode).toBe(404);
    expect((await read('creator',`/v1/market-proposals/${proposalId}`)).statusCode).toBe(200);
    const draft = await write('creator','POST','/v1/admin/markets',{ terms: terms('scalar'), source_proposal_id: proposalId });
    expect(draft.statusCode, draft.body).toBe(201);
    expect((await read('trader','/v1/admin/markets')).statusCode).toBe(403);
    expect((await read('creator','/v1/admin/markets')).statusCode).toBe(200);
    expect((await read('proposer','/v1/market-proposals')).json().items.some((p: { id: string }) => p.id === proposalId)).toBe(true);
    expect((await read('trader','/v1/market-proposals')).statusCode).toBe(403);
  });
  it('rejects external proposals through an attributable, terminal decision', async () => {
    const proposal = await write('proposer','POST','/v1/market-proposals',{ terms: terms('categorical') });
    expect(proposal.statusCode, proposal.body).toBe(201);
    const proposalId = proposal.json<{ id: string }>().id;
    const url = `/v1/admin/market-proposals/${proposalId}/reject`;
    const reason = { reason: 'Synthetic source hierarchy is inadequate', evidence_ref: 'test:proposal-review' };
    expect((await write('proposer','POST',url,reason)).statusCode).toBe(403);
    const rejected = await write('approver','POST',url,reason,'reject-proposal-once');
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().status).toBe('rejected');
    expect((await write('approver','POST',url,reason,'reject-proposal-once')).body).toBe(rejected.body);
    expect((await write('approver','POST',url,reason)).statusCode).toBe(409);
    expect((await write('creator','POST','/v1/admin/markets',{ terms: terms('categorical'), source_proposal_id: proposalId })).statusCode).toBe(409);
    expect((await read('proposer',`/v1/market-proposals/${proposalId}`)).json().status).toBe('rejected');
  });
  it('rejects invalid policy, unapproved templates and market role bypass', async () => {
    const t = terms(); t.outcomes = [{ id: 'yes', label: 'Yes' }, { id: 'yes', label: 'No' }];
    expect((await write('creator','POST','/v1/admin/markets',{ terms: t })).json().code).toBe('INVALID_MARKET_POLICY');
    const n = terms(); n.template_id = 'unapproved';
    expect((await write('creator','POST','/v1/admin/markets',{ terms: n })).json().code).toBe('TEMPLATE_NOT_APPROVED');
    expect((await write('trader','POST','/v1/admin/markets',{ terms: terms() })).statusCode).toBe(403);
  });
  it('requires source and policy registry approval at draft and publication time', async () => {
    expect((await read('creator','/v1/admin/evidence-sources')).json().items).toHaveLength(2);
    expect((await read('trader','/v1/admin/policy-registry')).statusCode).toBe(403);
    const unlisted = terms(); unlisted.resolution.primary_source.uri = 'https://example.com/unregistered';
    expect((await write('creator','POST','/v1/admin/markets',{ terms: unlisted })).json().code).toBe('SOURCE_NOT_APPROVED');
    const unknownPolicy = terms(); unknownPolicy.resolution.payout_policy_ref = 'unknown:payout';
    expect((await write('creator','POST','/v1/admin/markets',{ terms: unknownPolicy })).json().code).toBe('POLICY_NOT_APPROVED');
    const market = await create(); await submit(market.id); await allReviews(market.id);
    await db.query("UPDATE evidence_sources SET approved=false WHERE name='Synthetic primary source'");
    expect((await publish('approver',market.id)).json().code).toBe('SOURCE_NOT_APPROVED');
    await db.query("UPDATE evidence_sources SET approved=true WHERE name='Synthetic primary source'");
    await db.query("UPDATE policy_registry SET approved=false WHERE kind='payout'");
    expect((await publish('approver',market.id)).json().code).toBe('POLICY_NOT_APPROVED');
    await db.query("UPDATE policy_registry SET approved=true WHERE kind='payout'");
  });
  it('requires a separate reviewer for each policy review', async () => {
    const market = await create(); await submit(market.id);
    const first = await review('approver',market.id,'product'); expect(first.statusCode, first.body).toBe(201);
    const account = (await read('approver','/v1/me')).json<{ id: string }>();
    await db.query("UPDATE accounts SET roles=array_append(roles,'legal_reviewer') WHERE id=$1",[account.id]);
    const second = await review('approver',market.id,'legal');
    expect(second.json().code).toBe('SEPARATION_OF_DUTIES');
    await db.query("UPDATE accounts SET roles=array_remove(roles,'legal_reviewer') WHERE id=$1",[account.id]);
  });
  it('deduplicates concurrent commands and binds keys to the exact request', async () => {
    const request = { terms: terms('binary') }, shared = 'simultaneous-request';
    const [one,two] = await Promise.all([
      write('creator','POST','/v1/admin/markets',request,shared),
      write('creator','POST','/v1/admin/markets',request,shared),
    ]);
    expect(one.statusCode, one.body).toBe(201); expect(two.statusCode, two.body).toBe(201);
    expect(one.json().id).toBe(two.json().id);
    const count = (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM markets WHERE id=$1',[one.json().id])).rows[0];
    expect(count?.n).toBe('1');
    const changed = await write('creator','POST','/v1/admin/markets',{ terms: terms('scalar') },shared);
    expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('binds reviews to the current policy version and rejects a lost update', async () => {
    const market = await create();
    const revised = terms(); revised.question += ' Revised terms.';
    const updated = await write('creator','PUT',`/v1/admin/markets/${market.id}`,{
      expected_version: 1, terms: revised, reason: 'Clarify the event question',
    });
    expect(updated.statusCode, updated.body).toBe(200); expect(updated.json().version).toBe(2);
    expect((await write('creator','PUT',`/v1/admin/markets/${market.id}`,{
      expected_version: 1, terms: revised, reason: 'Lost edit',
    })).statusCode).toBe(409);
  });
  it('paginates public metadata and binds cursors to their filters', async () => {
    const page = await read('trader','/v1/markets?limit=1&market_type=binary');
    expect(page.statusCode).toBe(200);
    if (page.json().next_cursor) {
      const cursor = encodeURIComponent(page.json().next_cursor as string);
      expect((await read('trader',`/v1/markets?limit=1&market_type=scalar&cursor=${cursor}`)).json().code).toBe('INVALID_CURSOR');
      expect((await read('trader',`/v1/markets?limit=1&market_type=binary&cursor=${cursor}`)).statusCode).toBe(200);
    }
  });
  it('records audit and outbox atomically and rejects history edits', async () => {
    const audit = await read('auditor','/v1/admin/audit-events?limit=5');
    expect(audit.statusCode, audit.body).toBe(200);
    expect((await read('trader','/v1/admin/audit-events')).statusCode).toBe(403);
    const row = (await db.query<{ id: string }>('SELECT id FROM audit_events LIMIT 1')).rows[0]!;
    await expect(db.query("UPDATE audit_events SET action='changed' WHERE id=$1",[row.id])).rejects.toThrow();
    const total = (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_events')).rows[0]?.n;
    const events = (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox')).rows[0]?.n;
    expect(total).toBe(events);
  });
});
