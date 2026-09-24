import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth, demoConfig, seedDemo, terms } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { ledgerAccount, accountBalance, postJournal } from '../src/financial/ledger.js';
import { marketEscrowBalance,publicMarketCandles,publicMarketTrades } from '../src/trading/service.js';
import { reconcile } from '../src/financial/reconciliation.js';
import { hash } from '../src/platform/commands.js';
import { migrate } from '../src/platform/migrations.js';
import { postgres, type Database } from '../src/platform/database.js';

let db:Database,app:FastifyInstance,marketId:string,postgresSchema:string|undefined;
let key=0;
let identities:Record<string,string>;
const headers=(who:string)=>({authorization:`Bearer demo.${who}`});
const post=(who:string,url:string,payload:unknown,once?:string)=>app.inject({method:'POST',url,
  headers:{...headers(who),'idempotency-key':once??`trading-key-${++key}`},payload:payload as Record<string,unknown>});
const get=(who:string,url:string)=>app.inject({method:'GET',url,headers:headers(who)});
const submit=(who:string,side:'buy'|'sell',price:string,quantity:string,once?:string,outcome='yes')=>
  post(who,`/v1/markets/${marketId}/orders`,{outcome_id:outcome,side,limit_price:price,quantity},once);
const balance=async(who:string,bucket:'user_available'|'user_reserved')=>
  accountBalance(db,await ledgerAccount(db,identities[who]!, 'DEMO',bucket));

beforeAll(async()=>{
  const testUrl=process.env.TEST_DATABASE_URL;
  if(testUrl){
    if(new URL(testUrl).pathname!=='/afridict_test')throw new Error('Refusing to run against a non-test database');
    // CI runs multiple suites against this server. Isolate their seeded accounts,
    // migrations and fixture balances while keeping real PostgreSQL lock behavior.
    postgresSchema=`clob_test_${randomUUID().replaceAll('-','')}`;
    const admin=postgres(testUrl);
    try{await admin.query(`CREATE SCHEMA ${postgresSchema}`);}finally{await admin.close();}
    const scoped=new URL(testUrl);
    scoped.searchParams.set('options',`-csearch_path=${postgresSchema}`);
    db=postgres(scoped.toString());
  }else db=await embeddedDatabase();
  await migrate(db);identities=await seedDemo(db);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id = ANY($1::uuid[])",
    [[identities.trader,identities.proposer,identities.creator,identities.other_creator]]);
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES ('demo:collateral','DEMO',true,'synthetic-demo-only')`);
  const policy=terms();
  policy.open_at=new Date(Date.now()-10_000).toISOString();
  policy.trading_cutoff=new Date(Date.now()+3600_000).toISOString();
  policy.expected_event_at=new Date(Date.now()+7200_000).toISOString();
  policy.resolution_deadline=new Date(Date.now()+86400_000*7).toISOString();
  policy.risk.exposure_limit_minor='100000000';
  marketId=randomUUID();
  // Controlled fixture: governed publication is tested independently in integration.test.ts.
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES ($1,$2,'scheduled',$3,$4,now())`,[marketId,identities.creator,JSON.stringify(policy),hash(policy)]);
  for(const who of ['trader','proposer','creator','other_creator']){
    const escrow=await ledgerAccount(db,null,'DEMO','escrow_asset');
    const available=await ledgerAccount(db,identities[who]!,'DEMO','user_available');
    await db.transaction(sql=>postJournal(sql,{effectId:`trading-fixture:${who}`,asset:'DEMO',kind:'deposit_finalized',
      referenceId:marketId,reason:'Synthetic matching test funding',lines:[
        {account:escrow,debit:20_000_000n,credit:0n},
        {account:available,debit:0n,credit:20_000_000n},
      ]}));
  }
  app=await buildApp(db,demoConfig,demoAuth);
});
afterAll(async()=>{
  if(app)await app.close();if(db)await db.close();
  if(postgresSchema){
    const admin=postgres(process.env.TEST_DATABASE_URL!);
    try{await admin.query(`DROP SCHEMA ${postgresSchema} CASCADE`);}finally{await admin.close();}
  }
});

describe('collateralized synthetic order book',()=>{
  it('requires governed activation and exposes a sequenced empty snapshot',async()=>{
    const before=await submit('trader','buy','600000','2');
    expect(before.json().code).toBe('MARKET_NOT_OPEN');
    const denied=await post('trader',`/v1/admin/markets/${marketId}/trading/activate`,{});
    expect(denied.statusCode).toBe(403);
    const active=await post('approver',`/v1/admin/markets/${marketId}/trading/activate`,{});
    expect(active.statusCode,active.body).toBe(200);
    expect(active.json()).toMatchObject({market_id:marketId,status:'open',sequence:'1'});
    const book=await get('trader',`/v1/markets/${marketId}/book/yes`);
    expect(book.json()).toMatchObject({sequence:'1',status:'open',bids:[],asks:[]});
    const events=await get('trader',`/v1/markets/${marketId}/trading/events?after=0`);
    expect(events.json()).toMatchObject({items:[{sequence:'1',event_type:'activated'}],next_sequence:'1'});
  });

  it('never crosses an account against its own resting order',async()=>{
    const bid=await submit('trader','buy','500000','1');
    const ask=await submit('trader','sell','500000','1');
    expect(bid.statusCode,bid.body).toBe(201);
    expect(ask.statusCode,ask.body).toBe(201);
    expect(ask.json().fills).toEqual([]);
    expect(ask.json().order.state).toBe('open');
    for(const order of [bid,ask]){
      expect((await post('trader',`/v1/markets/${marketId}/orders/${order.json().order.id}/cancel`,{})).statusCode).toBe(200);
    }
    expect(await balance('trader','user_reserved')).toBe(0n);
  });

  it('matches at resting price, refunds improvement, and releases only unmatched collateral',async()=>{
    const baseline=(await get('trader',`/v1/markets/${marketId}/book/yes`)).json().sequence as string;
    const maker=await submit('proposer','sell','550000','3','maker-three');
    expect(maker.statusCode,maker.body).toBe(201);
    const makerId=maker.json().order.id as string;
    const makerReplay=await submit('proposer','sell','550000','3','maker-three');
    expect(makerReplay.body).toBe(maker.body);
    expect(await balance('proposer','user_reserved')).toBe(1_363_500n);
    const taker=await submit('trader','buy','650000','2','taker-two');
    expect(taker.statusCode,taker.body).toBe(201);
    expect(taker.json().fills).toMatchObject([{maker_order_id:makerId,price:'550000',quantity:'2'}]);
    expect(taker.json().order).toMatchObject({remaining:'0',state:'filled'});
    expect(await balance('trader','user_reserved')).toBe(0n);
    expect(await balance('proposer','user_reserved')).toBe(454_500n);
    expect(await marketEscrowBalance(db,'DEMO')).toBe(2_000_000n);
    const fees=await accountBalance(db,await ledgerAccount(db,null,'DEMO','protocol_fee'));
    expect(fees).toBe(20_000n);
    const cancel=await post('proposer',`/v1/markets/${marketId}/orders/${makerId}/cancel`,{});
    expect(cancel.statusCode,cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({state:'cancelled',remaining:'1'});
    expect(await balance('proposer','user_reserved')).toBe(0n);
    expect((await post('proposer',`/v1/markets/${marketId}/orders/${makerId}/cancel`,{})).json().code).toBe('ORDER_NOT_OPEN');
    expect((await get('proposer',`/v1/markets/${marketId}/orders`)).json().items[0]).toMatchObject({id:makerId,state:'cancelled'});
    expect((await get('trader',`/v1/markets/${marketId}/fills`)).json().items[0]).toMatchObject({price:'550000'});
    expect((await get('trader',`/v1/markets/${marketId}/positions`)).json().items).toMatchObject([
      {market_id:marketId,outcome_id:'yes',side:'buy',quantity:'2',collateral_minor:'1100000',fees_minor:'11000'},
    ]);
    const book=(await get('trader',`/v1/markets/${marketId}/book/yes`)).json();
    expect(book).toMatchObject({bids:[],asks:[]});
    const stream=(await get('trader',`/v1/markets/${marketId}/trading/events?after=${baseline}`)).json();
    expect(stream.items.map((item:{event_type:string})=>item.event_type)).toEqual([
      'order_accepted','order_accepted','fill','order_cancelled']);
    expect(stream.next_sequence).toBe(book.sequence);
  });

  it('serializes competing takers and never fills beyond a maker reservation',async()=>{
    const maker=await submit('creator','sell','400000','1');
    expect(maker.statusCode,maker.body).toBe(201);
    await db.query("UPDATE clob_asset_bindings SET approved=false WHERE policy_ref='demo:collateral'");
    expect((await submit('trader','buy','500000','1')).json().code).toBe('ASSET_NOT_APPROVED');
    await db.query("UPDATE clob_asset_bindings SET approved=true WHERE policy_ref='demo:collateral'");
    const [first,second]=await Promise.all([
      submit('trader','buy','500000','1'),submit('other_creator','buy','500000','1'),
    ]);
    expect(first.statusCode,first.body).toBe(201);
    expect(second.statusCode,second.body).toBe(201);
    const results=[first,second].map(response=>response.json().fills.length as number);
    expect(results.sort()).toEqual([0,1]);
    const fills=(await db.query<{n:string}>(`SELECT count(*)::text AS n FROM clob_fills
      WHERE maker_order_id=$1`,[maker.json().order.id])).rows[0]!;
    expect(fills.n).toBe('1');
    expect(await balance('creator','user_reserved')).toBe(0n);
    expect(await marketEscrowBalance(db,'DEMO')).toBe(3_000_000n);
    const accounting=await db.transaction(sql=>reconcile(sql,'DEMO',identities.finance!,'synthetic-trading-test'));
    expect(accounting).toMatchObject({market_collateral_minor:'3000000',protocol_fee_minor:'30000'});
    expect(accounting.exceptions).not.toContain('CLAIMS_COLLATERAL_MISMATCH');
  });

  it('projects exact market-wide candles and anonymous execution pages',async()=>{
    const raw=(await db.query<{id:string;price:string;quantity:string;sequence:string;created_at:Date}>(
      "SELECT id,price::text,quantity::text,sequence::text,created_at FROM clob_fills WHERE outcome_id='yes' ORDER BY created_at,sequence")).rows;
    expect(raw.length).toBeGreaterThan(1);
    const from=new Date(Date.now()-86_400_000),to=new Date(Date.now()+86_400_000);
    const candles=await publicMarketCandles(db,marketId,{assetCode:'DEMO',outcomeId:'yes',interval:'1d',
      from:from.toISOString(),to:to.toISOString()});
    expect(candles).toMatchObject({market_id:marketId,asset_code:'DEMO',outcome_id:'yes',price_scale:'1000000',interval:'1d'});
    expect(candles.items).toHaveLength(1);
    expect(candles.items[0]).toMatchObject({open:raw[0]!.price,close:raw.at(-1)!.price,
      high:raw.reduce((value,row)=>BigInt(row.price)>BigInt(value)?row.price:value,raw[0]!.price),
      low:raw.reduce((value,row)=>BigInt(row.price)<BigInt(value)?row.price:value,raw[0]!.price),
      volume:raw.reduce((value,row)=>value+BigInt(row.quantity),0n).toString(),trade_count:String(raw.length)});
    const first=await publicMarketTrades(db,marketId,{assetCode:'DEMO',outcomeId:'yes',limit:1});
    expect(first.items).toHaveLength(1);expect(first.next_before_sequence).toBe(first.items[0]!.sequence);
    expect(first.items[0]!.execution_id).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(first.items[0]!).sort()).toEqual(['executed_at','execution_id','outcome_id','price','quantity','sequence']);
    const second=await publicMarketTrades(db,marketId,{assetCode:'DEMO',outcomeId:'yes',limit:1,
      beforeSequence:first.next_before_sequence!});
    expect(BigInt(second.items[0]!.sequence)).toBeLessThan(BigInt(first.items[0]!.sequence));
  });

  it('fences cancellation against matching and refuses a restricted resting counterparty',async()=>{
    const restricted=await submit('other_creator','sell','400000','1',undefined,'no');
    expect(restricted.statusCode,restricted.body).toBe(201);
    await db.query("UPDATE eligibility SET status='restricted' WHERE account_id=$1",[identities.other_creator]);
    expect((await submit('trader','buy','400000','1',undefined,'no')).json().code).toBe('TRADING_NOT_ELIGIBLE');
    await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=$1",[identities.other_creator]);
    expect((await post('other_creator',`/v1/markets/${marketId}/orders/${restricted.json().order.id}/cancel`,{})).statusCode).toBe(200);

    const maker=await submit('creator','sell','450000','1',undefined,'no');
    expect(maker.statusCode,maker.body).toBe(201);
    const makerId=maker.json().order.id as string;
    const [cancel,taker]=await Promise.all([
      post('creator',`/v1/markets/${marketId}/orders/${makerId}/cancel`,{}),
      submit('trader','buy','450000','1',undefined,'no'),
    ]);
    expect(taker.statusCode,taker.body).toBe(201);
    expect([200,409]).toContain(cancel.statusCode);
    const fills=(await db.query<{n:string}>(`SELECT count(*)::text AS n FROM clob_fills WHERE maker_order_id=$1`,
      [makerId])).rows[0]!;
    expect(fills.n).toBe(cancel.statusCode===200?'0':'1');
    expect(await balance('creator','user_reserved')).toBe(0n);
  });

  it('halts further admissions and preserves immutable execution history',async()=>{
    const halted=await post('approver',`/v1/admin/markets/${marketId}/trading/halt`,{});
    expect(halted.statusCode,halted.body).toBe(200);
    expect((await submit('trader','buy','500000','1')).json().code).toBe('MARKET_NOT_OPEN');
    const open=(await db.query<{id:string}>(`SELECT id FROM clob_orders WHERE state='open'
      AND owner_id=$1 LIMIT 1`,[identities.trader])).rows[0];
    if(open)expect((await post('trader',`/v1/markets/${marketId}/orders/${open.id}/cancel`,{})).statusCode).toBe(200);
    expect((await post('approver',`/v1/admin/markets/${marketId}/trading/activate`,{})).statusCode).toBe(409);
    const fill=(await db.query<{id:string}>('SELECT id FROM clob_fills LIMIT 1')).rows[0]!;
    await expect(db.query('DELETE FROM clob_fills WHERE id=$1',[fill.id])).rejects.toThrow();
    const order=(await db.query<{id:string}>('SELECT id FROM clob_orders LIMIT 1')).rows[0]!;
    await expect(db.query('UPDATE clob_orders SET quantity=quantity+1 WHERE id=$1',[order.id])).rejects.toThrow();
  });
});
