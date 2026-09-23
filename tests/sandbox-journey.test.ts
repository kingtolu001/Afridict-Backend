import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {buildApp} from '../src/app.js';
import {ledgerAccount,postJournal} from '../src/financial/ledger.js';
import {processFiatCollection} from '../src/funding/fiat.js';
import type {FiatRailProvider} from '../src/funding/swervpay.js';
import type {Config} from '../src/platform/config.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';
import {bootstrapSandbox,sandboxMarketId} from '../src/platform/sandbox.js';

let db:Database,app:FastifyInstance,token:string,accountId:string;
const provider:FiatRailProvider={listBanks:vi.fn(async()=>[]),resolveAccount:vi.fn(),
  createCollection:vi.fn(async input=>({id:`collection_${input.reference}`,reference:input.reference,currency:'NGN' as const,
    accountName:'Afridict Sandbox',accountNumber:'1111111111',bankCode:'999',bankName:'Sandbox Bank',status:'active'})),
  createPayout:vi.fn(),getPayout:vi.fn()};
const cfg:Config={environment:'test',host:'127.0.0.1',port:3000,authMode:'native',corsOrigins:[],docs:false,logger:false,
  financialMode:'sandbox',authMethods:['password']};

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);await bootstrapSandbox(db);
  app=await buildApp(db,cfg,undefined,undefined,undefined,undefined,{provider,environment:'sandbox',businessId:'business_test',
    webhookSecret:'sandbox-webhook-secret-with-thirty-two-characters',dataHashKey:'sandbox-hash-key-with-thirty-two-characters',
    dataEncryptionKey:Buffer.alloc(32,9),keyVersion:'sandbox-test-v1'});
  const registered=await app.inject({method:'POST',url:'/v1/auth/register',payload:{jurisdiction:'NG',first_name:'Ada',last_name:'Nwosu',
    email:'ada.sandbox@example.com',phone_number:'+2348012345678',password:'SecurePassword123',terms_version:'sandbox-v1',
    privacy_version:'sandbox-v1',accepted:true}});
  expect(registered.statusCode,registered.body).toBe(201);
  const registration=registered.json<{access_token:string;account:{id:string}}>();
  token=registration.access_token;accountId=registration.account.id;
});
afterAll(async()=>{await app.close();await db.close();});

const auth=()=>({authorization:`Bearer ${token}`});
const post=(url:string,payload:unknown,key:string)=>app.inject({method:'POST',url,
  headers:{...auth(),'idempotency-key':key},payload:payload as Record<string,unknown>});

describe('hosted multi-currency sandbox journey',()=>{
  it('restarts without duplicating liquidity funding or resting orders',async()=>{
    await Promise.all([bootstrapSandbox(db),bootstrapSandbox(db)]);
    const funding=(await db.query<{count:string}>("SELECT count(*)::text AS count FROM ledger_journals WHERE effect_id LIKE 'sandbox-liquidity:%'")).rows[0]!;
    const orders=(await db.query<{count:string}>('SELECT count(*)::text AS count FROM clob_orders WHERE market_id=$1',[sandboxMarketId])).rows[0]!;
    expect(funding.count).toBe('4');expect(orders.count).toBe('8');
  });

  it('exposes deposit and trading while keeping withdrawals and crypto disabled',async()=>{
    const capabilities=await app.inject({method:'GET',url:'/v1/me/capabilities',headers:auth()});
    expect(capabilities.statusCode,capabilities.body).toBe(200);
    expect(capabilities.json()).toMatchObject({TRADE:{allowed:true},DEPOSIT_NGN:{allowed:true},
      DEPOSIT_CRYPTO:{allowed:false},WITHDRAW_NGN:{allowed:false},WITHDRAW_CRYPTO:{allowed:false}});
    const markets=await app.inject({method:'GET',url:'/v1/markets?category=sandbox'});
    expect(markets.statusCode,markets.body).toBe(200);
    expect(markets.json().items).toContainEqual(expect.objectContaining({id:sandboxMarketId,trading_enabled:true}));
    for(const [asset_code,contract_unit_minor] of [['NGN','10000'],['USDT_BSC','1000000000000000000']]){
      const policy=await app.inject({method:'GET',url:`/v1/markets/${sandboxMarketId}/collateral-policy?asset_code=${asset_code}`});
      expect(policy.statusCode,policy.body).toBe(200);
      expect(policy.json()).toMatchObject({asset_code,contract_unit_minor,trading_status:'open'});
    }
  });

  it('credits one SwervPay Development deposit and executes both order sides',async()=>{
    const created=await post('/v1/fiat/deposit-intents',{currency:'NGN',target_minor:'20000'},'sandbox-deposit');
    expect(created.statusCode,created.body).toBe(202);const id=created.json<{id:string}>().id;
    await processFiatCollection(db,provider,id);
    const payload={event:'collection.completed',data:{id:'sandbox_txn_1',reference:id,business_id:'business_test',status:'COMPLETED',
      amount:200,charges:0,type:'CREDIT',detail:'Sandbox collection',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}};
    const settled=await app.inject({method:'POST',url:'/v1/webhooks/swervpay',
      headers:{'x-swerv-secret':'sandbox-webhook-secret-with-thirty-two-characters'},payload});
    expect(settled.statusCode,settled.body).toBe(202);expect(settled.json()).toEqual({accepted:true,applied:true});
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth()});
    expect(wallet.json().items.find((item:{asset_code:string})=>item.asset_code==='NGN')).toMatchObject({available_minor:'20000'});
    const buy=await post(`/v1/markets/${sandboxMarketId}/orders`,{asset_code:'NGN',outcome_id:'yes',side:'buy',
      limit_price:'550000',quantity:'1'},'sandbox-buy');
    expect(buy.statusCode,buy.body).toBe(201);expect(buy.json().fills).toHaveLength(1);
    const sell=await post(`/v1/markets/${sandboxMarketId}/orders`,{asset_code:'NGN',outcome_id:'yes',side:'sell',
      limit_price:'450000',quantity:'1'},'sandbox-sell');
    expect(sell.statusCode,sell.body).toBe(201);expect(sell.json().fills).toHaveLength(1);
    const payout=await post('/v1/fiat/payouts',{amount_minor:'100',bank_code:'999',account_number:'0000000000',
      narration:'blocked sandbox payout'},'sandbox-payout');
    expect(payout.statusCode,payout.body).toBe(403);expect(payout.json().code).toBe('WITHDRAWALS_NOT_ACTIVE');
  });

  it('executes USD-wallet orders on the isolated USDT book',async()=>{
    await db.transaction(async sql=>{
      const escrow=await ledgerAccount(sql,null,'USDT_BSC','escrow_asset');
      const available=await ledgerAccount(sql,accountId,'USDT_BSC','user_available');
      await postJournal(sql,{effectId:'sandbox-user-usdt',asset:'USDT_BSC',kind:'financial_correction',referenceId:accountId,
        reason:'Hosted sandbox test funding',lines:[{account:escrow,debit:2n*10n**18n,credit:0n},
          {account:available,debit:0n,credit:2n*10n**18n}]});
    });
    const buy=await post(`/v1/markets/${sandboxMarketId}/orders`,{asset_code:'USDT_BSC',outcome_id:'yes',side:'buy',
      limit_price:'550000',quantity:'1'},'sandbox-usdt-buy');
    expect(buy.statusCode,buy.body).toBe(201);expect(buy.json().fills).toHaveLength(1);
    expect(buy.json().order).toMatchObject({asset_code:'USDT_BSC',contract_unit_minor:'1000000000000000000'});
    const sell=await post(`/v1/markets/${sandboxMarketId}/orders`,{asset_code:'USDT_BSC',outcome_id:'yes',side:'sell',
      limit_price:'450000',quantity:'1'},'sandbox-usdt-sell');
    expect(sell.statusCode,sell.body).toBe(201);expect(sell.json().fills).toHaveLength(1);
  });
});
