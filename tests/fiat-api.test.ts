import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {migrate} from '../src/platform/migrations.js';
import type {Database} from '../src/platform/database.js';
import type {FiatRailProvider} from '../src/funding/swervpay.js';
import {processFiatCollection} from '../src/funding/fiat.js';
import {accountBalance,ledgerAccount,postJournal} from '../src/financial/ledger.js';

let db:Database,app:FastifyInstance,traderId:string;
const provider:FiatRailProvider={
  listBanks:vi.fn(async()=>[{code:'999',name:'Synthetic Bank'}]),
  resolveAccount:vi.fn(async({bankCode,accountNumber})=>({accountName:'Synthetic Recipient',accountNumber,bankCode,bankName:'Synthetic Bank'})),
  createCollection:vi.fn(),createPayout:vi.fn(),getPayout:vi.fn(),
};
const auth={authorization:'Bearer demo.trader'};
const financeAuth={authorization:'Bearer demo.finance'};
const dataEncryptionKey=Buffer.alloc(32,7);
beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);traderId=ids.trader!;
  await db.query("UPDATE eligibility SET status='eligible',policy_version='synthetic:eligible' WHERE account_id=$1",[ids.trader]);
  await db.query("UPDATE fiat_rail_registry SET approved=true,collections_enabled=true,payouts_enabled=(asset_code='NGN'),reviewed_at=now() WHERE provider='swervpay'");
  await db.transaction(async sql=>{const escrow=await ledgerAccount(sql,null,'NGN','escrow_asset'),available=await ledgerAccount(sql,ids.trader!,'NGN','user_available');
    await postJournal(sql,{effectId:'synthetic:ngn-opening',asset:'NGN',kind:'financial_correction',referenceId:'synthetic-fixture',reason:'Synthetic test balance',
      lines:[{account:escrow,debit:100000n,credit:0n},{account:available,debit:0n,credit:100000n}]});});
  app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,undefined,{provider,environment:'sandbox',
    businessId:'business_test',webhookSecret:'synthetic-swervpay-webhook-secret',
    dataHashKey:['synthetic','bank','data','hash','key','for','tests'].join(':'),dataEncryptionKey,keyVersion:'test-v1'});});
afterAll(async()=>{await app.close();await db.close();});

describe('fiat provider API boundary',()=>{
  it('lists provider-reported banks for an authenticated caller',async()=>{
    const response=await app.inject({method:'GET',url:'/v1/fiat/banks',headers:auth});
    expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({items:[{code:'999',name:'Synthetic Bank'}]});
  });
  it('returns a matching bank resolution without persisting account data',async()=>{
    const response=await app.inject({method:'POST',url:'/v1/fiat/bank-accounts/resolve',headers:auth,
      payload:{bank_code:'999',account_number:'0000000000'}});
    expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({account_name:'Synthetic Recipient',
      account_number:'0000000000',bank_code:'999',bank_name:'Synthetic Bank'});
    const audit=await db.query('SELECT * FROM audit_events'),outbox=await db.query('SELECT * FROM outbox');
    expect(JSON.stringify([audit.rows,outbox.rows])).not.toContain('0000000000');
  });
  it('rejects malformed account numbers before calling the provider',async()=>{
    const calls=vi.mocked(provider.resolveAccount).mock.calls.length;
    const response=await app.inject({method:'POST',url:'/v1/fiat/bank-accounts/resolve',headers:auth,
      payload:{bank_code:'999',account_number:'123'}});
    expect(response.statusCode).toBe(400);expect(vi.mocked(provider.resolveAccount).mock.calls).toHaveLength(calls);
  });
  it('enforces the NGN 200 deposit minimum before creating provider work',async()=>{
    const response=await app.inject({method:'POST',url:'/v1/fiat/deposit-intents',headers:{...auth,'idempotency-key':'fiat-minimum'},
      payload:{currency:'NGN',target_minor:'19999'}});
    expect(response.statusCode,response.body).toBe(400);expect(response.json().code).toBe('VALIDATION_FAILED');
    expect((await db.query<{count:string}>('SELECT count(*)::text AS count FROM fiat_collection_requests')).rows[0]!.count).toBe('0');
  });
  it('creates an idempotent pending deposit and exposes instructions only after one worker call',async()=>{
    vi.mocked(provider.createCollection).mockImplementation(async input=>({id:`collection_${input.reference}`,reference:input.reference,
      currency:input.currency,accountName:'Afridict Collections',accountNumber:'1111111111',bankCode:'999',bankName:'Synthetic Bank',status:'active'}));
    const request={method:'POST' as const,url:'/v1/fiat/deposit-intents',headers:{...auth,'idempotency-key':'fiat-deposit-stable'},
      payload:{currency:'NGN',target_minor:'125050'}};
    const created=await app.inject(request),replayed=await app.inject(request);expect(created.statusCode,created.body).toBe(202);
    expect(replayed.json()).toEqual(created.json());expect(created.json()).toMatchObject({currency:'NGN',target_minor:'125050',
      state:'instruction_pending',instructions:null});
    const id=created.json<{id:string}>().id;
    await Promise.all([processFiatCollection(db,provider,id),processFiatCollection(db,provider,id)]);
    expect(provider.createCollection).toHaveBeenCalledTimes(1);
    const ready=await app.inject({method:'GET',url:`/v1/fiat/deposit-intents/${id}`,headers:auth});
    expect(ready.json()).toMatchObject({state:'instructions_available',instructions:{account_number:'1111111111',provider:'swervpay'}});
  });
  it('holds an ambiguous collection result for reconciliation without retrying',async()=>{
    vi.mocked(provider.createCollection).mockRejectedValueOnce(new Error('provider connection closed'));
    const created=await app.inject({method:'POST',url:'/v1/fiat/deposit-intents',headers:{...auth,'idempotency-key':'fiat-deposit-uncertain'},
      payload:{currency:'NGN',target_minor:'20000'}}),id=created.json<{id:string}>().id;
    const before=vi.mocked(provider.createCollection).mock.calls.length;
    await expect(processFiatCollection(db,provider,id)).rejects.toThrow('provider connection closed');
    expect(await processFiatCollection(db,provider,id)).toBe('instruction_uncertain');
    expect(vi.mocked(provider.createCollection).mock.calls).toHaveLength(before+1);
    const held=await app.inject({method:'GET',url:`/v1/fiat/deposit-intents/${id}`,headers:auth});
    expect(held.json()).toMatchObject({state:'instruction_uncertain',instructions:null});
  });
  it('authenticates, deduplicates and credits a completed SwervPay collection exactly once',async()=>{
    vi.mocked(provider.createCollection).mockImplementation(async input=>({id:`collection_${input.reference}`,reference:input.reference,
      currency:input.currency,accountName:'Afridict Collections',accountNumber:'1111111111',bankCode:'999',bankName:'Synthetic Bank',status:'active'}));
    const created=await app.inject({method:'POST',url:'/v1/fiat/deposit-intents',headers:{...auth,'idempotency-key':'fiat-webhook-deposit'},
      payload:{currency:'NGN',target_minor:'25000'}}),id=created.json<{id:string}>().id;
    await processFiatCollection(db,provider,id);
    const available=await ledgerAccount(db,traderId,'NGN','user_available'),before=await accountBalance(db,available);
    const payload={event:'collection.completed',data:{id:'txn_collection_completed',reference:id,business_id:'business_test',
      status:'COMPLETED',amount:250,charges:0,type:'CREDIT',detail:'Afridict collection',
      created_at:new Date().toISOString(),updated_at:new Date().toISOString()}};
    const invalid=await app.inject({method:'POST',url:'/v1/webhooks/swervpay',headers:{'x-swerv-secret':'wrong-webhook-secret'},payload});
    expect(invalid.statusCode,invalid.body).toBe(401);
    const first=await app.inject({method:'POST',url:'/v1/webhooks/swervpay',
      headers:{'x-swerv-secret':'synthetic-swervpay-webhook-secret'},payload});
    const duplicate=await app.inject({method:'POST',url:'/v1/webhooks/swervpay',
      headers:{'x-swerv-secret':'synthetic-swervpay-webhook-secret'},payload});
    expect(first.statusCode,first.body).toBe(202);expect(first.json()).toEqual({accepted:true,applied:true});
    expect(duplicate.statusCode,duplicate.body).toBe(202);expect(duplicate.json()).toEqual({accepted:true,applied:false});
    expect(await accountBalance(db,available)).toBe(before+25_000n);
    const settled=await app.inject({method:'GET',url:`/v1/fiat/deposit-intents/${id}`,headers:auth});
    expect(settled.json()).toMatchObject({state:'settled',target_minor:'25000'});
  });
  it('queues an idempotent NGN request for one finance administrator to approve',async()=>{
    vi.mocked(provider.createPayout).mockImplementation(async input=>({id:`payout_${input.reference}`,reference:input.reference}));
    const request={method:'POST' as const,url:'/v1/fiat/payouts',headers:{...auth,'idempotency-key':'fiat-payout-stable'},
      payload:{amount_minor:'25000',bank_code:'999',account_number:'0000000000',narration:'Afridict withdrawal'}};
    const [first,retry]=await Promise.all([app.inject(request),app.inject(request)]);expect(first.statusCode,first.body).toBe(202);expect(retry.statusCode,retry.body).toBe(202);
    expect(retry.json()).toEqual(first.json());const pending=first.json();expect(pending).toMatchObject({asset:'NGN',amount_minor:'25000',state:'reserved',rail:'swervpay'});
    expect(provider.createPayout).not.toHaveBeenCalled();
    const row=(await db.query<{destination_ref:string}>('SELECT destination_ref FROM withdrawals WHERE id=$1',[pending.id])).rows[0]!;
    expect(row.destination_ref).toContain('******0000');expect(row.destination_ref).not.toContain('0000000000');
    const stored=await db.query('SELECT * FROM private_payout_details');expect(JSON.stringify(stored.rows)).not.toContain('0000000000');
    const queue=await app.inject({method:'GET',url:'/v1/admin/fiat/payouts?state=reserved',headers:financeAuth});
    expect(queue.statusCode,queue.body).toBe(200);expect(queue.json().items[0]).toMatchObject({id:pending.id,
      bank:{account_name:'Synthetic Recipient',account_number:'0000000000'}});
    const approval={method:'POST' as const,url:`/v1/admin/fiat/payouts/${pending.id}/approve`,headers:{...financeAuth,
      'idempotency-key':'fiat-admin-approval'},payload:{reason:'Reviewed resolved account and available balance'}};
    const [approved,replayed]=await Promise.all([app.inject(approval),app.inject(approval)]);
    expect(approved.statusCode,approved.body).toBe(202);expect(replayed.statusCode,replayed.body).toBe(202);
    expect([approved.json().state,replayed.json().state]).toContain('submitted');expect(provider.createPayout).toHaveBeenCalledTimes(1);
    const submitted=approved.json().state==='submitted'?approved.json():replayed.json();
    const completed=await app.inject({method:'POST',url:`/v1/admin/fiat/payouts/${submitted.id}/complete`,headers:{...financeAuth,
      'idempotency-key':'fiat-admin-complete'},payload:{provider_reference:`payout_${submitted.id}`,reason:'Verified successful in Swervpay dashboard'}});
    expect(completed.statusCode,completed.body).toBe(200);expect(completed.json().state).toBe('finalized');
  });
  it('keeps NGN reserved when the payout response is ambiguous',async()=>{
    vi.mocked(provider.createPayout).mockRejectedValueOnce(new Error('provider connection closed'));
    const requested=await app.inject({method:'POST',url:'/v1/fiat/payouts',headers:{...auth,'idempotency-key':'fiat-payout-uncertain'},
      payload:{amount_minor:'10000',bank_code:'999',account_number:'0000000000',narration:'Afridict withdrawal'}});
    const response=await app.inject({method:'POST',url:`/v1/admin/fiat/payouts/${requested.json().id}/approve`,headers:{...financeAuth,
      'idempotency-key':'fiat-admin-uncertain'},payload:{reason:'Reviewed resolved account and available balance'}});
    expect(response.statusCode,response.body).toBe(202);expect(response.json()).toMatchObject({state:'uncertain',amount_minor:'10000'});
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth}),ngn=wallet.json().items.find((item:{currency:string})=>item.currency==='NGN');
    expect(ngn).toMatchObject({available_minor:'90000',withdrawal_pending_minor:'10000'});
  });
});
