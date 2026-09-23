import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo,terms} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {ledgerAccount,postJournal} from '../src/financial/ledger.js';
import {publishConversionRate} from '../src/funding/conversion.js';
import {hash} from '../src/platform/commands.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,trader:string,proposer:string,finance:string,ngnMarket:string,usdtMarket:string,dualMarket:string;
let key=0;
const auth={authorization:'Bearer demo.trader'};
const post=(persona:string,url:string,payload:unknown)=>app.inject({method:'POST',url,
  headers:{authorization:`Bearer demo.${persona}`,'idempotency-key':`multi-currency-${++key}`},payload:payload as Record<string,unknown>});

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);trader=ids.trader!;proposer=ids.proposer!;finance=ids.finance!;
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible',policy_version='synthetic:eligible' WHERE account_id IN ($1,$2)",[trader,proposer]);
  await db.query("UPDATE financial_assets SET synthetic=true,approved=true,evidence_ref='synthetic-multi-currency' WHERE code='USDT_BSC'");
  await db.query("UPDATE token_asset_registry SET approved=true,evidence_ref='synthetic-multi-currency' WHERE asset_code='USDT_BSC'");
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,contract_unit_minor,approved,evidence_ref) VALUES
    ('synthetic:ngn-market','NGN',10000,true,'synthetic-ngn-contract'),
    ('synthetic:usdt-market','USDT_BSC',1000000000000000000,true,'synthetic-usdt-contract'),
    ('synthetic:dual-market','NGN',10000,true,'synthetic-dual-ngn-contract'),
    ('synthetic:dual-market','USDT_BSC',1000000000000000000,true,'synthetic-dual-usdt-contract')`);
  const createMarket=async(assetRef:string,exposure:string)=>{const policy=terms();policy.risk.settlement_asset_ref=assetRef;
    policy.risk.exposure_limit_minor=exposure;policy.open_at=new Date(Date.now()-10_000).toISOString();
    policy.trading_cutoff=new Date(Date.now()+3_600_000).toISOString();policy.expected_event_at=new Date(Date.now()+7_200_000).toISOString();
    policy.resolution_deadline=new Date(Date.now()+86_400_000).toISOString();const id=randomUUID();
    await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at) VALUES($1,$2,'scheduled',$3,$4,now())`,
      [id,ids.creator,JSON.stringify(policy),hash(policy)]);return id;};
  ngnMarket=await createMarket('synthetic:ngn-market','1000000');
  usdtMarket=await createMarket('synthetic:usdt-market',(10n**20n).toString());
  dualMarket=await createMarket('synthetic:dual-market',(10n**20n).toString());
  await db.transaction(async sql=>{
    for(const [asset,amount] of [['NGN',200_000n],['USDT_BSC',2n*10n**18n]] as const){
      const custody=await ledgerAccount(sql,null,asset,'escrow_asset'),available=await ledgerAccount(sql,trader,asset,'user_available');
      await postJournal(sql,{effectId:`multi-currency-funding:${asset}`,asset,kind:'financial_correction',referenceId:trader,
        reason:'Synthetic multi-currency test funding',lines:[{account:custody,debit:amount,credit:0n},{account:available,debit:0n,credit:amount}]});
      const proposerAvailable=await ledgerAccount(sql,proposer,asset,'user_available');
      await postJournal(sql,{effectId:`multi-currency-proposer-funding:${asset}`,asset,kind:'financial_correction',referenceId:proposer,
        reason:'Synthetic multi-currency counterparty funding',lines:[{account:custody,debit:amount,credit:0n},
          {account:proposerAvailable,debit:0n,credit:amount}]});
    }
    await publishConversionRate(sql,finance,{sourceAsset:'USDT_BSC',destinationAsset:'NGN',rateNumerator:'160000',
      rateDenominator:(10n**18n).toString(),feeBps:100,minimumSourceMinor:(10n**18n).toString(),
      sourceRef:'synthetic-rate:usdt-ngn-market',expiresAt:new Date(Date.now()+3_600_000),reason:'Synthetic market wallet rate'},'multi-rate');
  });
  app=await buildApp(db,demoConfig,demoAuth);
});
afterAll(async()=>{await app.close();await db.close();});

describe('multi-currency market collateral',()=>{
  it('derives NGN collateral from governance and exposes the caller wallet path',async()=>{
    const activated=await post('approver',`/v1/admin/markets/${ngnMarket}/trading/activate`,{});
    expect(activated.statusCode,activated.body).toBe(200);expect(activated.json()).toMatchObject({asset_code:'NGN',asset_scale:2,
      contract_unit_minor:'10000',price_scale:'1000000',status:'open'});
    const policy=await app.inject({method:'GET',url:`/v1/markets/${ngnMarket}/collateral-policy`});
    expect(policy.statusCode,policy.body).toBe(200);expect(policy.json()).toEqual({market_id:ngnMarket,asset_code:'NGN',
      asset_scale:2,contract_unit_minor:'10000',price_scale:'1000000',trading_status:'open'});
    const collateral=await app.inject({method:'GET',url:`/v1/markets/${ngnMarket}/collateral`,headers:auth});
    expect(collateral.statusCode,collateral.body).toBe(200);expect(collateral.json()).toMatchObject({asset_code:'NGN',asset_scale:2,
      contract_unit_minor:'10000',available_minor:'200000',conversion_sources:['USDT_BSC']});
    const order=await post('trader',`/v1/markets/${ngnMarket}/orders`,{outcome_id:'yes',side:'buy',limit_price:'500000',quantity:'2'});
    expect(order.statusCode,order.body).toBe(201);expect(order.json().order).toMatchObject({asset_code:'NGN',
      contract_unit_minor:'10000',quantity:'2'});
    const updated=await app.inject({method:'GET',url:`/v1/markets/${ngnMarket}/collateral`,headers:auth});
    expect(updated.json()).toMatchObject({available_minor:'189900',reserved_minor:'10100'});
  });

  it('uses USDT token units and rejects an asset outside the published policy',async()=>{
    const rejected=await post('approver',`/v1/admin/markets/${usdtMarket}/trading/activate`,{asset_code:'NGN'});
    expect(rejected.statusCode).toBe(403);expect(rejected.json().code).toBe('ASSET_NOT_APPROVED');
    const activated=await post('approver',`/v1/admin/markets/${usdtMarket}/trading/activate`,{});
    expect(activated.statusCode,activated.body).toBe(200);expect(activated.json()).toMatchObject({asset_code:'USDT_BSC',asset_scale:18,
      contract_unit_minor:'1000000000000000000'});
    const order=await post('trader',`/v1/markets/${usdtMarket}/orders`,{outcome_id:'yes',side:'buy',limit_price:'500000',quantity:'1'});
    expect(order.statusCode,order.body).toBe(201);
    const collateral=await app.inject({method:'GET',url:`/v1/markets/${usdtMarket}/collateral`,headers:auth});
    expect(collateral.json()).toMatchObject({available_minor:'1495000000000000000',reserved_minor:'505000000000000000'});
  });

  it('isolates matching and sequences by the selected wallet on one market',async()=>{
    for(const asset_code of ['NGN','USDT_BSC']){
      const activated=await post('approver',`/v1/admin/markets/${dualMarket}/trading/activate`,{asset_code});
      expect(activated.statusCode,activated.body).toBe(200);expect(activated.json()).toMatchObject({asset_code,sequence:'1'});
    }
    const ambiguous=await app.inject({method:'GET',url:`/v1/markets/${dualMarket}/collateral-policy`});
    expect(ambiguous.statusCode).toBe(422);expect(ambiguous.json().code).toBe('ASSET_REQUIRED');
    const ngnAsk=await post('trader',`/v1/markets/${dualMarket}/orders`,
      {asset_code:'NGN',outcome_id:'yes',side:'sell',limit_price:'500000',quantity:'1'});
    expect(ngnAsk.statusCode,ngnAsk.body).toBe(201);
    const usdtBid=await post('proposer',`/v1/markets/${dualMarket}/orders`,
      {asset_code:'USDT_BSC',outcome_id:'yes',side:'buy',limit_price:'500000',quantity:'1'});
    expect(usdtBid.statusCode,usdtBid.body).toBe(201);expect(usdtBid.json().fills).toEqual([]);
    const ngnBid=await post('proposer',`/v1/markets/${dualMarket}/orders`,
      {asset_code:'NGN',outcome_id:'yes',side:'buy',limit_price:'500000',quantity:'1'});
    expect(ngnBid.statusCode,ngnBid.body).toBe(201);expect(ngnBid.json().fills).toHaveLength(1);
    const ngnBook=await app.inject({method:'GET',url:`/v1/markets/${dualMarket}/book/yes?asset_code=NGN`});
    const usdtBook=await app.inject({method:'GET',url:`/v1/markets/${dualMarket}/book/yes?asset_code=USDT_BSC`});
    expect(ngnBook.json()).toMatchObject({asset_code:'NGN',sequence:'4'});
    expect(usdtBook.json()).toMatchObject({asset_code:'USDT_BSC',sequence:'2',bids:[{price:'500000',quantity:'1'}]});
  });

  it('prevents changing an approved binding contract unit after publication',async()=>{
    await expect(db.query("UPDATE clob_asset_bindings SET contract_unit_minor=1 WHERE policy_ref='synthetic:ngn-market'"))
      .rejects.toThrow(/immutable/);
  });
});
