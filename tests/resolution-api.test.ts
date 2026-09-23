import { generateKeyPairSync,randomUUID,sign } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth,demoConfig,seedDemo,terms } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { hash } from '../src/platform/commands.js';
import { ledgerAccount,accountBalance,postJournal } from '../src/financial/ledger.js';
import { migrate } from '../src/platform/migrations.js';
import { postgres,type Database } from '../src/platform/database.js';
import type { MarketTerms } from '../src/contracts.js';
import type {SettlementDependencies,SettlementObservation} from '../src/settlement/service.js';
import type {Address,Hex} from 'viem';
import {rfqSigningPayload,signingKeyFingerprint} from '../src/liquidity/rfq-service.js';

let db:Database,app:FastifyInstance,schema:string|undefined;
let identities:Record<string,string>,clockNow=new Date(),key=0;
let resolutionMarket:{id:string;policy:MarketTerms},resolutionEvidenceId:string;
const settlementContract='0x1111111111111111111111111111111111111111' as Address;
const settlementCodeHash=`0x${'2'.repeat(64)}` as Hex;
let settlementObservation:SettlementObservation|null=null,settlementAttempt=0;
let settlementSignerUncertain=false,settlementRecovered:{transactionHash:Hex;nonce:bigint}|null=null;
const rfqKey=generateKeyPairSync('ed25519');
const rfqPublicKey=rfqKey.publicKey.export({format:'der',type:'spki'}).toString('base64');
const settlementDependencies:SettlementDependencies={
  submitter:{async submit(){settlementAttempt+=1;if(settlementSignerUncertain)return {state:'uncertain' as const};
    return {state:'submitted' as const,transactionHash:`0x${settlementAttempt.toString(16).padStart(64,'0')}` as Hex,
      nonce:BigInt(settlementAttempt)};},async lookup(){return settlementRecovered;}},
  observers:['rpc-primary','rpc-independent'].map(id=>({id,async observe(){return settlementObservation;}})),
};
const headers=(who:string)=>({authorization:`Bearer demo.${who}`});
const remoteAddress=(who:string)=>`192.0.2.${[...who].reduce((sum,value)=>sum+value.charCodeAt(0),0)%250+1}`;
const post=(who:string,url:string,payload:unknown,once?:string)=>app.inject({method:'POST',url,
  headers:{...headers(who),'idempotency-key':once??`resolution-key-${++key}`},
  payload:payload as Record<string,unknown>,remoteAddress:remoteAddress(who)});
const get=(who:string,url:string)=>app.inject({method:'GET',url,headers:headers(who),remoteAddress:remoteAddress(who)});
const balance=async(who:string,bucket:'user_available'|'user_reserved')=>
  accountBalance(db,await ledgerAccount(db,identities[who]!,'DEMO',bucket));
const evidence=(marketId:string,who:string,digest:string)=>post(who,
  `/v1/admin/markets/${marketId}/resolution/evidence`,{
    source_name:'Synthetic primary source',source_uri:'https://example.com/synthetic/primary',
    artifact_ref:`archive:synthetic-${digest.slice(0,8)}`,document_sha256:digest,
    observed_at:new Date(clockNow.getTime()-60_000).toISOString(),
  });

async function createMarket(type:'binary'|'categorical'='binary',amm=false){
  const policy=terms(type),now=Date.now(),id=randomUUID();
  policy.open_at=new Date(now-60_000).toISOString();
  policy.trading_cutoff=new Date(now+3600_000).toISOString();
  policy.expected_event_at=new Date(now+7200_000).toISOString();
  policy.resolution_deadline=new Date(now+86400_000).toISOString();
  policy.resolution.challenge_window_seconds=60;
  policy.resolution.timelock_seconds=60;
  policy.risk.exposure_limit_minor='100000000';
  if(amm)policy.liquidity={...policy.liquidity,amm_enabled:true,inventory_limit_minor:'20',
    subsidy_limit_minor:'10000000',loss_limit_minor:'8000000',max_slippage_bps:500};
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES ($1,$2,'scheduled',$3,$4,now())`,[id,identities.creator,JSON.stringify(policy),hash(policy)]);
  expect((await post('approver',`/v1/admin/markets/${id}/trading/activate`,{})).statusCode).toBe(200);
  return {id,policy};
}
async function trade(marketId:string,outcome:string,quantity='2',assetCode?:string){
  const sell=await post('proposer',`/v1/markets/${marketId}/orders`,{
    ...(assetCode?{asset_code:assetCode}:{}),outcome_id:outcome,side:'sell',limit_price:'600000',quantity});
  expect(sell.statusCode,sell.body).toBe(201);
  const buy=await post('trader',`/v1/markets/${marketId}/orders`,{
    ...(assetCode?{asset_code:assetCode}:{}),outcome_id:outcome,side:'buy',limit_price:'600000',quantity});
  expect(buy.statusCode,buy.body).toBe(201);
  expect(buy.json().fills).toHaveLength(1);
}
async function close(marketId:string,policy:MarketTerms){
  clockNow=new Date(Date.parse(policy.expected_event_at)+60_000);
  const result=await post('approver',`/v1/admin/markets/${marketId}/resolution/close-book`,{});
  expect(result.statusCode,result.body).toBe(200);
  expect(result.json().remaining).toBe('0');
}
async function vote(marketId:string,who:string,decision:'proposal'|'challenge'|'recuse',evidenceId:string){
  return post(who,`/v1/admin/markets/${marketId}/resolution/ballots`,{
    decision,reason:'Synthetic evidence assessment',evidence_id:evidenceId,
  });
}

beforeAll(async()=>{
  const testUrl=process.env.TEST_DATABASE_URL;
  if(testUrl){
    if(new URL(testUrl).pathname!=='/afridict_test')throw new Error('Refusing a non-test database');
    schema=`resolution_test_${randomUUID().replaceAll('-','')}`;
    const admin=postgres(testUrl);
    try{await admin.query(`CREATE SCHEMA ${schema}`);}finally{await admin.close();}
    const scoped=new URL(testUrl);scoped.searchParams.set('options',`-csearch_path=${schema}`);
    db=postgres(scoped.toString());
  }else db=await embeddedDatabase();
  await migrate(db);identities=await seedDemo(db);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=ANY($1::uuid[])",
    [[identities.trader,identities.proposer]]);
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES ('demo:collateral','DEMO',true,'synthetic-demo-only')`);
  await db.query(`INSERT INTO resolution_policy_bindings
    (bond_policy_ref,payout_policy_ref,asset_code,bond_minor,invalid_payout,approved,evidence_ref)
    VALUES ('demo:bond-v1','demo:payout-v1','DEMO',1000,'refund_recorded_collateral',true,'synthetic-demo-only')`);
  await db.query(`INSERT INTO chain_settlement_bindings(asset_code,chain_id,contract_address,
    collateral_token_address,contract_code_hash,finality_policy_ref,confirmations,observer_quorum,approved,evidence_ref)
    VALUES ('DEMO',46630,$1,$2,$3,'demo:finality-v1',3,2,true,'synthetic-testnet-only')`,
    [settlementContract,'0x2222222222222222222222222222222222222222',settlementCodeHash]);
  for(const who of ['trader','proposer','resolution_proposer','resolution_challenger']){
    const escrow=await ledgerAccount(db,null,'DEMO','escrow_asset');
    const available=await ledgerAccount(db,identities[who]!,'DEMO','user_available');
    await db.transaction(sql=>postJournal(sql,{effectId:`resolution-fixture:${who}`,asset:'DEMO',
      kind:'deposit_finalized',referenceId:'synthetic-resolution-test',reason:'Synthetic resolution fixture',lines:[
        {account:escrow,debit:10_000_000n,credit:0n},{account:available,debit:0n,credit:10_000_000n},
      ]}));
  }
  app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,undefined,undefined,()=>clockNow,settlementDependencies);
});
afterAll(async()=>{
  if(app)await app.close();if(db)await db.close();
  if(schema){const admin=postgres(process.env.TEST_DATABASE_URL!);
    try{await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.close();}}
});

describe('governed synthetic resolution and exactly-once redemption',()=>{
  it('closes unmatched orders, archives source hashes and rejects premature proposal',async()=>{
    const market=await createMarket();
    await trade(market.id,'yes');
    const unmatched=await post('trader',`/v1/markets/${market.id}/orders`,{
      outcome_id:'no',side:'buy',limit_price:'500000',quantity:'1'});
    expect(unmatched.statusCode,unmatched.body).toBe(201);
    const early=await post('approver',`/v1/admin/markets/${market.id}/resolution/close-book`,{});
    expect(early.json().code).toBe('TRADING_WINDOW_OPEN');
    await close(market.id,market.policy);
    expect((await get('trader',`/v1/markets/${market.id}/orders`)).json().items[0]).toMatchObject({state:'cancelled'});
    const archived=await evidence(market.id,'resolution_proposer','a'.repeat(64));
    expect(archived.statusCode,archived.body).toBe(201);
    expect(archived.json().record_hash).toMatch(/^[a-f0-9]{64}$/);
    resolutionEvidenceId=archived.json().id;
    const duplicate=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/evidence`,{
      source_name:'Synthetic primary source',source_uri:'https://example.com/synthetic/primary',
      artifact_ref:'archive:synthetic-aaaaaaaa',document_sha256:'a'.repeat(64),
      observed_at:new Date(clockNow.getTime()-60_000).toISOString(),
    });
    expect(duplicate.json().code).toBe('EVIDENCE_ALREADY_ARCHIVED');
    await expect(db.query('DELETE FROM resolution_evidence WHERE id=$1',[archived.json().id])).rejects.toThrow();
    const foreign=await post('resolution_challenger',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Wrong proposer'},
    );
    expect(foreign.json().code).toBe('EVIDENCE_REQUIRED');
    const proposed=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Observed result'},'first-proposal');
    expect(proposed.statusCode,proposed.body).toBe(201);
    expect(proposed.json()).toMatchObject({state:'proposed',proposal:{kind:'outcome',outcome_id:'yes'}});
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Observed result'},'first-proposal')).body).toBe(proposed.body);
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Another proposal'})).json().code)
      .toBe('RESOLUTION_ALREADY_PROPOSED');
    const until=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,{reason:'Too early'});
    expect(until.json().code).toBe('RESOLUTION_TIMELOCK');
    expect(await balance('resolution_proposer','user_reserved')).toBe(1000n);
    resolutionMarket=market;
  });

  it('requires a complete independent quorum, then redeems each fill once',async()=>{
    const market=resolutionMarket;
    expect((await vote(market.id,'resolution_proposer','proposal',resolutionEvidenceId)).statusCode).toBe(403);
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).json().code).toBe('CHALLENGE_WINDOW_OPEN');
    clockNow=new Date(clockNow.getTime()+61_000);
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+180_000);
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Incomplete panel'})).json().code).toBe('PANEL_INCOMPLETE');
    for(const who of ['resolution_judge_two','resolution_judge_three']){
      expect((await vote(market.id,who,'proposal',resolutionEvidenceId)).statusCode).toBe(201);
    }
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).json().code).toBe('PANEL_COMPLETE');
    const finalized=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Independent quorum selected documented result'});
    expect(finalized.statusCode,finalized.body).toBe(200);
    expect(finalized.json()).toMatchObject({state:'finalized',final_result:{kind:'outcome',outcome_id:'yes'}});
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Duplicate finalization'})).json().code).toBe('RESOLUTION_STATE_CONFLICT');
    expect(await balance('resolution_proposer','user_reserved')).toBe(0n);
    const escrow=await ledgerAccount(db,null,'DEMO','market_escrow');
    expect(await accountBalance(db,escrow)).toBe(2_000_000n);
    const before=await balance('trader','user_available');
    const [one,two]=await Promise.all([
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'first-redemption'),
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'second-redemption'),
    ]);
    expect(one.statusCode,one.body).toBe(200);
    expect(two.statusCode,two.body).toBe(200);
    expect([one.json().fill_count,two.json().fill_count].sort()).toEqual([0,1]);
    const paid=one.json().fill_count===1?one:two;
    const paidKey=one.json().fill_count===1?'first-redemption':'second-redemption';
    expect(paid.json()).toMatchObject({fill_count:1,paid_by_asset:[{asset_code:'DEMO',amount_minor:'2000000'}],remaining:'0'});
    expect(await balance('trader','user_available')).toBe(before+2_000_000n);
    expect(await accountBalance(db,escrow)).toBe(0n);
    const replay=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},paidKey);
    expect(replay.body).toBe(paid.body);
    const empty=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(empty.json()).toMatchObject({fill_count:0,paid_by_asset:[],remaining:'0'});
    expect((await get('trader',`/v1/markets/${market.id}/redemptions`)).json().items).toMatchObject([
      {amount_minor:'2000000'},
    ]);
    expect((await get('trader',`/v1/markets/${market.id}/positions`)).json().items).toEqual([]);
    const record=(await db.query<{fill_id:string}>('SELECT fill_id FROM resolution_redemptions LIMIT 1')).rows[0]!;
    await expect(db.query('DELETE FROM resolution_redemptions WHERE fill_id=$1',[record.fill_id])).rejects.toThrow();
    await expect(db.query("UPDATE resolution_cases SET final_result='{}'::jsonb WHERE market_id=$1",
      [market.id])).rejects.toThrow();
  });

  it('adjudicates a challenged categorical result with separated roles',async()=>{
    clockNow=new Date();
    const market=await createMarket('categorical');
    await trade(market.id,'dry','1');
    await close(market.id,market.policy);
    const proposalEvidence=await evidence(market.id,'resolution_proposer','b'.repeat(64));
    const challengeEvidence=await evidence(market.id,'resolution_challenger','c'.repeat(64));
    const proposed=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'dry'},evidence_id:proposalEvidence.json().id,reason:'Initial edition'});
    expect(proposed.statusCode,proposed.body).toBe(201);
    const challenge=await post('resolution_challenger',`/v1/admin/markets/${market.id}/resolution/challenge`,{
      result:{kind:'outcome',outcome_id:'normal'},evidence_id:challengeEvidence.json().id,reason:'Corrected edition'});
    expect(challenge.statusCode,challenge.body).toBe(200);
    expect(challenge.json().state).toBe('challenged');
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/challenge`,{
      result:{kind:'outcome',outcome_id:'wet'},evidence_id:proposalEvidence.json().id,reason:'Self challenge'})).statusCode).toBe(409);
    for(const [who,decision] of [['resolution','challenge'],['resolution_judge_two','challenge'],
      ['resolution_judge_three','recuse']] as const){
      expect((await vote(market.id,who,decision,challengeEvidence.json().id)).statusCode).toBe(201);
    }
    clockNow=new Date(clockNow.getTime()+180_000);
    const final=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Challenge achieved published quorum'});
    expect(final.statusCode,final.body).toBe(200);
    expect(final.json().final_result).toMatchObject({kind:'outcome',outcome_id:'normal'});
    expect(await balance('resolution_challenger','user_reserved')).toBe(0n);
    const paid=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(paid.json()).toMatchObject({fill_count:1,paid_by_asset:[{asset_code:'DEMO',amount_minor:'1000000'}],remaining:'0'});
    expect((await get('proposer',`/v1/markets/${market.id}/redemptions`)).json().items[0]).toMatchObject({amount_minor:'1000000'});
  });

  it('returns recorded matched collateral for an invalid result without minting value',async()=>{
    clockNow=new Date();
    const market=await createMarket();
    const buyerBefore=await balance('trader','user_available');
    const sellerBefore=await balance('proposer','user_available');
    await trade(market.id,'yes','1');
    await close(market.id,market.policy);
    const proof=await evidence(market.id,'resolution_proposer','d'.repeat(64));
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'invalid'},evidence_id:proof.json().id,reason:'No valid observation'})).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    for(const who of ['resolution','resolution_judge_two','resolution_judge_three']){
      expect((await vote(market.id,who,'proposal',proof.json().id)).statusCode).toBe(201);
    }
    clockNow=new Date(clockNow.getTime()+120_000);
    const final=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Invalid outcome achieved published quorum'});
    expect(final.statusCode,final.body).toBe(200);
    expect(final.json().final_result).toEqual({kind:'invalid'});
    const settled=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(settled.json()).toMatchObject({fill_count:1,paid_by_asset:[{asset_code:'DEMO',amount_minor:'1000000'}],remaining:'0'});
    expect(await balance('trader','user_available')).toBe(buyerBefore-6_000n);
    expect(await balance('proposer','user_available')).toBe(sellerBefore-4_000n);
  });

  it('redeems an AMM quote exactly once and makes its user payout settlement-ready',async()=>{
    clockNow=new Date();
    const market=await createMarket('binary',true);
    expect((await post('approver',`/v1/admin/markets/${market.id}/amm/yes/activate`,
      {impact_bps:100})).statusCode).toBe(200);
    expect((await post('finance',`/v1/admin/markets/${market.id}/amm/yes/funding`,
      {amount_minor:'8000000'})).statusCode).toBe(200);
    const observed=new Date();
    expect((await post('approver',`/v1/admin/markets/${market.id}/amm/yes/reference-prices`,{
      price:'500000',observed_at:new Date(observed.getTime()-1000).toISOString(),
      expires_at:new Date(observed.getTime()+60_000).toISOString(),source_ref:'approved-feed:resolution-amm'})).statusCode).toBe(201);
    const quote=await post('trader',`/v1/markets/${market.id}/amm/yes/quotes`,{
      side:'buy',quantity:'2',limit_price:'600000'});
    expect(quote.statusCode,quote.body).toBe(201);
    expect((await post('trader',`/v1/amm/quotes/${quote.json().id}/execute`,{})).statusCode).toBe(200);
    expect((await get('trader',`/v1/markets/${market.id}/positions`)).json().items).toMatchObject([
      {outcome_id:'yes',side:'buy',quantity:'2'}]);
    await close(market.id,market.policy);
    const proof=await evidence(market.id,'resolution_proposer','e'.repeat(64));
    expect(proof.statusCode,proof.body).toBe(201);
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:proof.json().id,reason:'Observed synthetic result'})).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    for(const who of ['resolution','resolution_judge_two','resolution_judge_three'])
      expect((await vote(market.id,who,'proposal',proof.json().id)).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+120_000);
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Independent quorum selected documented result'})).statusCode).toBe(200);
    const before=await balance('trader','user_available');
    const [first,second]=await Promise.all([
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'amm-redeem-one'),
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'amm-redeem-two')]);
    expect([first.json().fill_count,second.json().fill_count].sort()).toEqual([0,1]);
    expect(await balance('trader','user_available')).toBe(before+2_000_000n);
    expect((await get('trader',`/v1/markets/${market.id}/positions`)).json().items).toEqual([]);
    expect((await get('trader',`/v1/markets/${market.id}/redemptions`)).json().items).toMatchObject([
      {fill_id:quote.json().id,amount_minor:'2000000'}]);
    const prepared=await post('finance',`/v1/admin/markets/${market.id}/settlement-batches`,{},'amm-settlement');
    expect(prepared.statusCode,prepared.body).toBe(201);
    expect(prepared.json()).toMatchObject({item_count:1,total_minor:'2000000'});
  });

  it('redeems a signed RFQ fill exactly once and exposes its winning settlement claim',async()=>{
    clockNow=new Date();const market=await createMarket();
    const requesterEntity=randomUUID(),dealerEntity=randomUUID();
    for(const [id,name] of [[requesterEntity,'Resolution RFQ Requester'],[dealerEntity,'Resolution RFQ Dealer']])
      await db.query(`INSERT INTO rfq_entities(id,legal_name,status,exposure_limit_minor,created_by,approved_by,approved_at)
        VALUES($1,$2,'active',10000000,$3,$4,now())`,[id,name,identities.compliance,identities.other_compliance]);
    await db.query(`INSERT INTO rfq_entity_memberships(entity_id,account_id,role,added_by)
      VALUES($1,$2,'requester',$3)`,[requesterEntity,identities.trader,identities.other_compliance]);
    await db.query(`INSERT INTO rfq_entity_memberships(entity_id,account_id,role,signing_public_key,
      signing_key_fingerprint,added_by) VALUES($1,$2,'dealer',$3,$4,$5)`,
    [dealerEntity,identities.proposer,rfqPublicKey,signingKeyFingerprint(rfqPublicKey),identities.other_compliance]);
    const requestExpiry=new Date(Date.now()+120_000).toISOString();
    const request=await post('trader',`/v1/markets/${market.id}/rfqs`,{entity_id:requesterEntity,
      outcome_id:'yes',side:'buy',quantity:'1',expires_at:requestExpiry});
    expect(request.statusCode,request.body).toBe(201);
    const quoteExpiry=new Date(Date.now()+60_000).toISOString(),nonce='resolution-rfq-quote';
    const payload=rfqSigningPayload({requestId:request.json().id,price:'500000',expiresAt:quoteExpiry,nonce});
    const quote=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'500000',expires_at:quoteExpiry,nonce,signature:sign(null,Buffer.from(payload),rfqKey.privateKey).toString('base64')});
    expect(quote.statusCode,quote.body).toBe(201);
    const fill=await post('trader',`/v1/rfqs/${request.json().id}/quotes/${quote.json().id}/accept`,{});
    expect(fill.statusCode,fill.body).toBe(200);
    await close(market.id,market.policy);
    const proof=await evidence(market.id,'resolution_proposer','f'.repeat(64));
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:proof.json().id,reason:'Observed RFQ market result'})).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    for(const who of ['resolution','resolution_judge_two','resolution_judge_three'])
      expect((await vote(market.id,who,'proposal',proof.json().id)).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+120_000);
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Independent quorum selected documented result'})).statusCode).toBe(200);
    const before=await balance('trader','user_available');
    const [first,second]=await Promise.all([
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'rfq-redeem-one'),
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'rfq-redeem-two')]);
    expect([first.json().fill_count,second.json().fill_count].sort()).toEqual([0,1]);
    expect(await balance('trader','user_available')).toBe(before+1_000_000n);
    expect((await get('trader',`/v1/markets/${market.id}/positions`)).json().items).toEqual([]);
    expect((await get('trader',`/v1/markets/${market.id}/redemptions`)).json().items).toMatchObject([
      {fill_id:fill.json().id,amount_minor:'1000000'}]);
    const prepared=await post('finance',`/v1/admin/markets/${market.id}/settlement-batches`,{},'rfq-settlement');
    expect(prepared.statusCode,prepared.body).toBe(201);
    expect(prepared.json()).toMatchObject({item_count:1,total_minor:'1000000'});
    await expect(db.query('DELETE FROM rfq_redemptions WHERE fill_id=$1',[fill.json().id])).rejects.toThrow();
  });

  it('prepares one deterministic chain claim, verifies quorum and detects later divergence',async()=>{
    const market=resolutionMarket;
    const [one,two]=await Promise.all([
      post('finance',`/v1/admin/markets/${market.id}/settlement-batches`,{},'settlement-prepare-one'),
      post('finance',`/v1/admin/markets/${market.id}/settlement-batches`,{},'settlement-prepare-two'),
    ]);
    expect([one.statusCode,two.statusCode],[one.body,two.body].join('\n')).toContain(201);
    const prepared=[one,two].find(result=>result.statusCode===201)!;
    const rejected=[one,two].find(result=>result.statusCode!==201)!;
    expect(prepared.json()).toMatchObject({market_id:market.id,chain_id:'46630',contract_address:settlementContract,
      state:'prepared',item_count:1,total_minor:'2000000',submission:null});
    expect(rejected.json().code).toBe('NO_SETTLEMENT_PAYOUTS');
    const batchId=prepared.json().id as string;
    await expect(db.query(`UPDATE settlement_batches SET manifest_hash=$2 WHERE id=$1`,[batchId,'f'.repeat(64)]))
      .rejects.toThrow();
    await expect(db.query(`UPDATE chain_settlement_bindings SET confirmations=1 WHERE asset_code='DEMO'`))
      .rejects.toThrow();
    const row=(await db.query<{calldata_hash:Hex}>(`SELECT calldata_hash FROM settlement_batches WHERE id=$1`,[batchId])).rows[0]!;
    const submitted=await post('finance',`/v1/admin/settlement-batches/${batchId}/submit`,{});
    expect(submitted.statusCode,submitted.body).toBe(202);
    expect(submitted.json()).toMatchObject({state:'submitted',submission:{state:'submitted',attempt:1}});
    settlementObservation={transactionHash:submitted.json().submission.transaction_hash,blockNumber:10n,
      blockHash:`0x${'3'.repeat(64)}`,headNumber:11n,contractAddress:settlementContract,
      calldataHash:row.calldata_hash,receiptSuccess:true,contractCodeHash:settlementCodeHash};
    const confirmed=await post('finance',`/v1/admin/settlement-batches/${batchId}/refresh`,{});
    expect(confirmed.statusCode,confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({observer_count:2,confirmations:'2',required_confirmations:'3',
      batch:{state:'confirmed',submission:{state:'confirmed'}}});
    settlementObservation={...settlementObservation,headNumber:12n};
    const finalized=await post('finance',`/v1/admin/settlement-batches/${batchId}/refresh`,{});
    expect(finalized.json()).toMatchObject({observer_count:2,confirmations:'3',batch:{state:'finalized',
      submission:{state:'finalized'}}});
    const claims=await get('trader',`/v1/markets/${market.id}/settlement-claims`);
    expect(claims.json().items[0]).toMatchObject({batch_id:batchId,amount_minor:'2000000',claim_ready:true});
    expect(claims.json().items[0].proof).toEqual([]);
    expect((await get('proposer',`/v1/markets/${market.id}/settlement-claims`)).json().items).toEqual([]);
    settlementDependencies.observers[1]={id:'rpc-independent',async observe(){return settlementObservation?{
      ...settlementObservation,blockHash:`0x${'4'.repeat(64)}`}:null;}};
    const divergent=await post('finance',`/v1/admin/settlement-batches/${batchId}/refresh`,{});
    expect(divergent.json().batch).toMatchObject({state:'exception',submission:{state:'reorged'}});
    expect((await get('trader',`/v1/markets/${market.id}/settlement-claims`)).json().items[0].claim_ready).toBe(false);
    settlementSignerUncertain=true;
    const replacement=await post('finance',`/v1/admin/settlement-batches/${batchId}/submit`,{});
    expect(replacement.json()).toMatchObject({state:'submitted',submission:{state:'uncertain',attempt:2,
      transaction_hash:null}});
    expect((await post('finance',`/v1/admin/settlement-batches/${batchId}/submit`,{})).json().code)
      .toBe('SETTLEMENT_ALREADY_SUBMITTED');
    settlementRecovered={transactionHash:`0x${'5'.repeat(64)}`,nonce:2n};
    settlementObservation={...settlementObservation,transactionHash:settlementRecovered.transactionHash,
      blockHash:`0x${'6'.repeat(64)}`,headNumber:12n};
    settlementDependencies.observers[1]={id:'rpc-independent',async observe(){return settlementObservation;}};
    const recovered=await post('finance',`/v1/admin/settlement-batches/${batchId}/refresh`,{});
    expect(recovered.json().batch).toMatchObject({state:'finalized',submission:{state:'finalized',attempt:2,
      transaction_hash:settlementRecovered.transactionHash}});
    settlementObservation={...settlementObservation,headNumber:11n};
    const regressed=await post('finance',`/v1/admin/settlement-batches/${batchId}/refresh`,{});
    expect(regressed.json().batch).toMatchObject({state:'exception',submission:{state:'reorged',attempt:2}});
    expect((await get('trader',`/v1/markets/${market.id}/settlement-claims`)).json().items[0].claim_ready).toBe(false);
  });

  it('resolves one event while preserving separate NGN and USDT payouts and settlement batches',async()=>{
    clockNow=new Date();
    await db.query("UPDATE financial_assets SET synthetic=true,approved=true,evidence_ref='synthetic-dual-resolution' WHERE code='USDT_BSC'");
    await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,contract_unit_minor,approved,evidence_ref) VALUES
      ('demo:collateral','NGN',10000,true,'synthetic-dual-resolution'),
      ('demo:collateral','USDT_BSC',1000000000000000000,true,'synthetic-dual-resolution')`);
    await db.query(`INSERT INTO resolution_policy_bindings
      (bond_policy_ref,payout_policy_ref,asset_code,bond_minor,invalid_payout,approved,evidence_ref)
      VALUES
      ('demo:bond-v1','demo:payout-v1','NGN',1000,'refund_recorded_collateral',true,'synthetic-dual-resolution'),
      ('demo:bond-v1','demo:payout-v1','USDT_BSC',1000000000000000000,'refund_recorded_collateral',true,
        'synthetic-dual-resolution')`);
    await db.query(`INSERT INTO chain_settlement_bindings(asset_code,chain_id,contract_address,
      collateral_token_address,contract_code_hash,finality_policy_ref,confirmations,observer_quorum,approved,evidence_ref)
      VALUES ('USDT_BSC',46630,$1,$2,$3,'demo:finality-v1',3,2,true,'synthetic-dual-resolution')`,
      ['0x4444444444444444444444444444444444444444','0x3333333333333333333333333333333333333333',settlementCodeHash]);
    await db.query(`INSERT INTO chain_settlement_bindings(asset_code,chain_id,contract_address,
      collateral_token_address,contract_code_hash,finality_policy_ref,confirmations,observer_quorum,approved,evidence_ref)
      VALUES ('NGN',46630,$1,$2,$3,'demo:finality-v1',3,2,true,'synthetic-dual-resolution')`,
      ['0x5555555555555555555555555555555555555555','0x6666666666666666666666666666666666666666',settlementCodeHash]);
    await db.transaction(async sql=>{
      for(const who of ['trader','proposer','resolution_proposer'])for(const [asset,amount] of [['NGN',3_000_000n],['USDT_BSC',3n*10n**18n]] as const){
        const escrow=await ledgerAccount(sql,null,asset,'escrow_asset');
        const available=await ledgerAccount(sql,identities[who]!,asset,'user_available');
        await postJournal(sql,{effectId:`dual-resolution:${asset}:${who}`,asset,kind:'deposit_finalized',
          referenceId:'synthetic-dual-resolution',reason:'Synthetic dual-currency resolution fixture',lines:[
            {account:escrow,debit:amount,credit:0n},{account:available,debit:0n,credit:amount},
          ]});
      }
    });
    const policy=terms(),marketId=randomUUID(),now=clockNow.getTime();
    policy.open_at=new Date(now-60_000).toISOString();policy.trading_cutoff=new Date(now+3_600_000).toISOString();
    policy.expected_event_at=new Date(now+7_200_000).toISOString();policy.resolution_deadline=new Date(now+86_400_000).toISOString();
    policy.resolution.challenge_window_seconds=60;policy.resolution.timelock_seconds=60;
    policy.risk.exposure_limit_minor=(10n**20n).toString();
    await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
      VALUES ($1,$2,'scheduled',$3,$4,now())`,[marketId,identities.creator,JSON.stringify(policy),hash(policy)]);
    for(const asset_code of ['NGN','USDT_BSC']){
      const activated=await post('approver',`/v1/admin/markets/${marketId}/trading/activate`,{asset_code});
      expect(activated.statusCode,activated.body).toBe(200);
      await trade(marketId,'yes','1',asset_code);
    }
    await close(marketId,policy);
    const proof=await evidence(marketId,'resolution_proposer','9'.repeat(64));
    expect(proof.statusCode,proof.body).toBe(201);
    const proposed=await post('resolution_proposer',`/v1/admin/markets/${marketId}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:proof.json().id,reason:'Dual-currency documented result'});
    expect(proposed.statusCode,proposed.body).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    for(const who of ['resolution','resolution_judge_two','resolution_judge_three'])
      expect((await vote(marketId,who,'proposal',proof.json().id)).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    const finalized=await post('resolution_finalizer',`/v1/admin/markets/${marketId}/resolution/finalize`,
      {reason:'One governed result applies to both collateral books'});
    expect(finalized.statusCode,finalized.body).toBe(200);
    const redeemed=await post('finance',`/v1/admin/markets/${marketId}/resolution/redeem-batch`,{});
    expect(redeemed.statusCode,redeemed.body).toBe(200);
    expect(redeemed.json()).toMatchObject({fill_count:2,remaining:'0',paid_by_asset:[
      {asset_code:'NGN',amount_minor:'10000'},
      {asset_code:'USDT_BSC',amount_minor:'1000000000000000000'},
    ]});
    const ambiguous=await post('finance',`/v1/admin/markets/${marketId}/settlement-batches`,{},'dual-settlement-ambiguous');
    expect(ambiguous.statusCode).toBe(422);expect(ambiguous.json().code).toBe('ASSET_REQUIRED');
    const demoBatch=await post('finance',`/v1/admin/markets/${marketId}/settlement-batches`,
      {asset_code:'NGN'},'dual-settlement-ngn');
    const usdtBatch=await post('finance',`/v1/admin/markets/${marketId}/settlement-batches`,
      {asset_code:'USDT_BSC'},'dual-settlement-usdt');
    expect(demoBatch.statusCode,demoBatch.body).toBe(201);expect(demoBatch.json()).toMatchObject({asset:'NGN',total_minor:'10000'});
    expect(usdtBatch.statusCode,usdtBatch.body).toBe(201);expect(usdtBatch.json()).toMatchObject({asset:'USDT_BSC',
      total_minor:'1000000000000000000'});
  });
});
