import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth, demoConfig, seedDemo } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';
import { applyPartnerDeposit, hmacPartnerVerifier } from '../src/funding/service.js';
import { canonical } from '../src/platform/commands.js';

let db:Database,app:FastifyInstance,traderId:string;
const partnerKey=['unit','test','hmac','key'].join(':');
let sequence=0;
const auth=(persona:string)=>({authorization:`Bearer demo.${persona}`});
const post=(persona:string,url:string,payload:unknown={},key?:string)=>app.inject({method:'POST',url,
  headers:{...auth(persona),'idempotency-key':key??`finance-test-${++sequence}`},payload:payload as Record<string,unknown>});
const get=(persona:string,url:string)=>app.inject({method:'GET',url,headers:auth(persona)});

beforeAll(async()=>{
  db=await embeddedDatabase(); await migrate(db); const ids=await seedDemo(db); traderId=ids.trader!;
  await db.query("UPDATE eligibility SET status='eligible',policy_version='demo:eligible' WHERE account_id=$1",[traderId]);
  app=await buildApp(db,demoConfig,demoAuth,hmacPartnerVerifier(new Map([['partner',partnerKey]])));
});
afterAll(async()=>{await app.close();await db.close();});

describe('financial ledger, funding and reconciliation',()=>{
  it('does not expose a partner-confirmed deposit as spendable collateral',async()=>{
    const assets=await get('trader','/v1/financial-assets');
    expect(assets.json()).toEqual({items:[
      {code:'DEMO',scale:6,synthetic:true,funding_enabled:true,withdrawal_enabled:true},
      {code:'NGN',scale:2,synthetic:true,funding_enabled:true,withdrawal_enabled:true},
    ]});
    expect((await get('trader','/v1/smart-account')).json()).toMatchObject({chain_id:'46630',status:'active',recovery:'self_service',financial_mode:'synthetic'});
    const intent=await post('trader','/v1/deposit-intents',{asset:'DEMO',target_minor:'100',rail:'synthetic'});
    expect(intent.statusCode,intent.body).toBe(201); expect(intent.json().funding_instructions_available).toBe(false);
    const intentId=intent.json<{id:string}>().id;
    const confirmed=await post('finance',`/v1/admin/synthetic/deposits/${intentId}/partner-confirm`,{asset:'DEMO',amount_minor:'100'});
    expect(confirmed.statusCode,confirmed.body).toBe(200); expect(confirmed.json().state).toBe('partner_confirmed');
    expect((await get('trader','/v1/balances')).json().items).toEqual([]);
    const premature=await post('trader','/v1/withdrawals',{asset:'DEMO',amount_minor:'1',destination_ref:'demo:destination',rail:'synthetic'});
    expect(premature.json().code).toBe('INSUFFICIENT_COLLATERAL');
    const finalized=await post('finance',`/v1/admin/synthetic/deposits/${intentId}/finalize`,{});
    expect(finalized.statusCode,finalized.body).toBe(200); expect(finalized.json().state).toBe('reconciled_available');
    expect((await get('trader','/v1/balances')).json().items[0]).toMatchObject({asset:'DEMO',available_minor:'100',reserved_minor:'0'});
    expect((await get('trader','/v1/statements')).json().items[0]).toMatchObject({kind:'deposit_finalized',direction:'increase',amount_minor:'100'});
  });

  it('projects separate NGN and exact USDT-BSC wallets without combining balances',async()=>{
    const wallets=await get('trader','/v1/wallets');expect(wallets.statusCode,wallets.body).toBe(200);
    expect(wallets.json().items).toEqual([
      {asset_code:'NGN',currency:'NGN',symbol:'NGN',kind:'fiat',scale:2,network:null,deposit_address:null,
        available_minor:'0',reserved_minor:'0',withdrawal_pending_minor:'0',funding_enabled:false,withdrawal_enabled:false},
      {asset_code:'USDT_BSC',currency:'USD',symbol:'USDT',kind:'stablecoin',scale:18,
        network:{name:'BNB Smart Chain',chain_id:'56',contract_address:'0x55d398326f99059ff775485246999027b3197955'},
        deposit_address:null,available_minor:'0',reserved_minor:'0',withdrawal_pending_minor:'0',funding_enabled:false,
        withdrawal_enabled:false},
    ]);
  });

  it('serializes concurrent withdrawal reservations against one balance',async()=>{
    const [a,b]=await Promise.all([
      post('trader','/v1/withdrawals',{asset:'DEMO',amount_minor:'80',destination_ref:'demo:a',rail:'synthetic'}),
      post('trader','/v1/withdrawals',{asset:'DEMO',amount_minor:'80',destination_ref:'demo:b',rail:'synthetic'}),
    ]);
    const success=[a,b].filter(r=>r.statusCode===201),failure=[a,b].filter(r=>r.statusCode===409);
    expect(success).toHaveLength(1); expect(failure).toHaveLength(1);
    expect(failure[0]!.json().code).toBe('INSUFFICIENT_COLLATERAL');
    const held=success[0]!.json<{id:string}>();
    expect((await get('trader','/v1/balances')).json().items[0]).toMatchObject({available_minor:'20',withdrawal_pending_minor:'80'});
    const cancelled=await post('trader',`/v1/withdrawals/${held.id}/cancel`,{reason:'Cancel before submission'});
    expect(cancelled.statusCode,cancelled.body).toBe(200); expect(cancelled.json().state).toBe('cancelled');
    expect((await get('trader','/v1/balances')).json().items[0]).toMatchObject({available_minor:'100',withdrawal_pending_minor:'0'});
  });

  it('keeps uncertain withdrawal collateral held and consumes it only on finality',async()=>{
    const withdrawal=await post('trader','/v1/withdrawals',{asset:'DEMO',amount_minor:'60',destination_ref:'demo:final',rail:'synthetic'});
    expect(withdrawal.statusCode,withdrawal.body).toBe(201); const id=withdrawal.json<{id:string}>().id;
    expect((await post('finance',`/v1/admin/synthetic/withdrawals/${id}/submit`,{})).json().state).toBe('submitted');
    expect((await post('finance',`/v1/admin/synthetic/withdrawals/${id}/uncertain`,{})).json().state).toBe('uncertain');
    expect((await post('trader',`/v1/withdrawals/${id}/cancel`,{reason:'Unsafe release attempt'})).json().code).toBe('WITHDRAWAL_UNCERTAIN');
    expect((await get('trader','/v1/balances')).json().items[0]).toMatchObject({available_minor:'40',withdrawal_pending_minor:'60'});
    const finalized=await post('finance',`/v1/admin/synthetic/withdrawals/${id}/finalize`,{});
    expect(finalized.statusCode,finalized.body).toBe(200); expect(finalized.json().state).toBe('finalized');
    expect((await get('trader','/v1/balances')).json().items[0]).toMatchObject({available_minor:'40',withdrawal_pending_minor:'0'});
    expect((await post('finance',`/v1/admin/synthetic/withdrawals/${id}/finalize`,{})).statusCode).toBe(409);
  });

  it('reconciles balanced observations and opens owned exceptions for pending partner value',async()=>{
    const balanced=await post('finance','/v1/admin/reconciliation-runs',{asset:'DEMO'});
    expect(balanced.statusCode,balanced.body).toBe(201);
    expect(balanced.json()).toMatchObject({status:'balanced',escrow_ledger_minor:'40',chain_net_minor:'40',
      partner_deposits_minor:'100',finalized_deposits_minor:'100',user_claims_minor:'40',exceptions:[]});
    const pending=await post('trader','/v1/deposit-intents',{asset:'DEMO',target_minor:'7',rail:'synthetic'});
    const pendingId=pending.json<{id:string}>().id;
    await post('finance',`/v1/admin/synthetic/deposits/${pendingId}/partner-confirm`,{asset:'DEMO',amount_minor:'7'});
    const broken=await post('finance','/v1/admin/reconciliation-runs',{asset:'DEMO'});
    expect(broken.json()).toMatchObject({status:'exceptions_opened'});
    expect(broken.json().exceptions).toContain('PARTNER_DEPOSIT_PENDING_CHAIN');
    const exception=(await db.query<{owner_ref:string}>('SELECT owner_ref FROM financial_exceptions WHERE details_code=$1',['PARTNER_DEPOSIT_PENDING_CHAIN'])).rows[0];
    expect(exception?.owner_ref).toBe('finance_operations');
  });

  it('rejects an unbalanced or mutable journal at the database boundary',async()=>{
    await expect(db.transaction(async sql=>{
      await sql.query(`INSERT INTO ledger_journals(id,effect_id,asset_code,kind,reference_id,reason)
        VALUES ($1,$2,'DEMO','financial_correction','test','unbalanced test')`,[randomUUID(),`test:${randomUUID()}`]);
    })).rejects.toThrow();
    const journal=(await db.query<{id:string}>('SELECT id FROM ledger_journals LIMIT 1')).rows[0]!;
    await expect(db.query("UPDATE ledger_journals SET reason='rewrite' WHERE id=$1",[journal.id])).rejects.toThrow();
  });

  it('deduplicates signed partner events and rejects conflicting replay',async()=>{
    const intent=await post('trader','/v1/deposit-intents',{asset:'DEMO',target_minor:'9',rail:'synthetic'});
    const intentId=intent.json<{id:string}>().id,eventId='stable-event',base={partnerId:'test-partner',eventId,
      occurredAt:new Date().toISOString(),intentId,reference:'stable-reference',asset:'DEMO',amount:'9'};
    expect(await db.transaction(sql=>applyPartnerDeposit(sql,base,'req-one'))).toBe(true);
    expect(await db.transaction(sql=>applyPartnerDeposit(sql,base,'req-two'))).toBe(false);
    await expect(db.transaction(sql=>applyPartnerDeposit(sql,{...base,amount:'10'},'req-three'))).rejects.toMatchObject({code:'PARTNER_EVENT_CONFLICT'});
    expect((await db.query<{n:string}>('SELECT count(*)::text AS n FROM partner_events WHERE event_id=$1',[eventId])).rows[0]?.n).toBe('1');
  });

  it('authenticates the public partner webhook before recording its event',async()=>{
    const intent=await post('trader','/v1/deposit-intents',{asset:'DEMO',target_minor:'13',rail:'partner'});
    const body={event_type:'deposit.confirmed' as const,occurred_at:new Date().toISOString(),
      intent_id:intent.json<{id:string}>().id,partner_reference:'partner-reference',asset:'DEMO',amount_minor:'13'};
    const eventId='signed-event',timestamp=Math.floor(Date.now()/1000).toString();
    const signature=`sha256=${createHmac('sha256',partnerKey).update(`${eventId}.${timestamp}.${canonical(body)}`).digest('hex')}`;
    const call=(sig:string)=>app.inject({method:'POST',url:'/v1/webhooks/funding/partner',payload:body,
      headers:{'x-partner-event-id':eventId,'x-partner-timestamp':timestamp,'x-partner-signature':sig}});
    expect((await call(`sha256=${'0'.repeat(64)}`)).statusCode).toBe(401);
    const accepted=await call(signature); expect(accepted.statusCode,accepted.body).toBe(202);
    expect((await call(signature)).statusCode).toBe(202);
    expect((await get('trader',`/v1/deposit-intents/${body.intent_id}`)).json().state).toBe('partner_confirmed');
  });

  it('verifies partner HMAC signatures over event identity, timestamp and canonical payload',async()=>{
    const payload={amount:'10',intent_id:'example'},eventId='event-1',timestamp=Math.floor(Date.now()/1000).toString();
    const signature=`sha256=${createHmac('sha256',partnerKey).update(`${eventId}.${timestamp}.${canonical(payload)}`).digest('hex')}`;
    const verifier=hmacPartnerVerifier(new Map([['partner',partnerKey]]));
    expect(await verifier.verify({partnerId:'partner',eventId,timestamp,signature,payload})).toBe(true);
    expect(await verifier.verify({partnerId:'partner',eventId,timestamp,signature,payload:{...payload,amount:'11'}})).toBe(false);
    expect(await verifier.verify({partnerId:'unknown',eventId,timestamp,signature,payload})).toBe(false);
  });
});
