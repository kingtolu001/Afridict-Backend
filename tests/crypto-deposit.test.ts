import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import type {CryptoDepositObserver,MissingTokenTransfer,VerifiedTokenTransfer} from '../src/funding/crypto-deposit.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,traderId:string;
const auth={authorization:'Bearer demo.trader'},finance={authorization:'Bearer demo.finance'};
const address=`0x${'a'.repeat(40)}`,contract='0x55d398326f99059ff775485246999027b3197955';
const tx1=`0x${'1'.repeat(64)}`,tx2=`0x${'2'.repeat(64)}`,tx3=`0x${'3'.repeat(64)}`;
const blockHash=`0x${'b'.repeat(64)}`;
const observations=new Map<string,VerifiedTokenTransfer|MissingTokenTransfer>();
const transfer=(transactionHash:string,state:VerifiedTokenTransfer['state'],amountMinor='2000000000000000000',confirmations=4):VerifiedTokenTransfer=>({
  state,chainId:'56',contractAddress:contract,recipient:address,amountMinor,transactionHash,logIndex:0,blockNumber:'12345',
  blockHash,confirmations,finalityPolicyRef:'bsc:independent-rpc:12-confirmations-v1',
});
const observer:CryptoDepositObserver={async observe(input){const row=observations.get(input.transactionHash);
  if(!row)throw new Error('missing synthetic chain observation');return row;}};
const post=(url:string,payload:unknown,key:string,headers=auth)=>app.inject({method:'POST',url,payload:payload as Record<string,unknown>,
  headers:{...headers,'idempotency-key':key}});

beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);traderId=ids.trader!;
  await db.query("UPDATE eligibility SET status='eligible',policy_version='synthetic:eligible' WHERE account_id=$1",[traderId]);
  await db.query("UPDATE financial_assets SET synthetic=true,approved=true,evidence_ref='synthetic-usdt-deposit' WHERE code='USDT_BSC'");
  await db.query("UPDATE token_asset_registry SET approved=true,evidence_ref='synthetic-usdt-deposit' WHERE asset_code='USDT_BSC'");
  app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,observer);
});
afterAll(async()=>{await app.close();await db.close();});

describe('USDT-BSC wallet and independently observed deposits',()=>{
  it('always exposes separate NGN and USD wallet projections',async()=>{
    const before=await app.inject({method:'GET',url:'/v1/wallets',headers:auth});expect(before.statusCode,before.body).toBe(200);
    expect(before.json().items).toMatchObject([
      {asset_code:'NGN',currency:'NGN',symbol:'NGN',kind:'fiat',scale:2,network:null,deposit_address:null},
      {asset_code:'USDT_BSC',currency:'USD',symbol:'USDT',kind:'stablecoin',scale:18,
        network:{name:'BNB Smart Chain',chain_id:'56',contract_address:contract},deposit_address:null,funding_enabled:false},
    ]);
  });

  it('lets finance register one custody-controlled address without exposing custody metadata',async()=>{
    const created=await post('/v1/admin/crypto/deposit-addresses',{owner_id:traderId,asset:'USDT_BSC',chain_id:'56',address,
      custody_reference:'custody-allocation-0001',evidence_ref:'custody/allocation/0001',reason:'Approved test custody allocation'},
    'usdt-address-provision',finance);
    expect(created.statusCode,created.body).toBe(201);expect(created.json()).toMatchObject({asset:'USDT_BSC',chain_id:'56',
      address,state:'active'});expect(created.body).not.toContain('custody-allocation');
    const duplicate=await post('/v1/admin/crypto/deposit-addresses',{owner_id:traderId,asset:'USDT_BSC',chain_id:'56',
      address:`0x${'c'.repeat(40)}`,custody_reference:'custody-allocation-0002',evidence_ref:'custody/allocation/0002',
      reason:'Duplicate address attempt'},'usdt-address-duplicate',finance);
    expect(duplicate.statusCode).toBe(409);expect(duplicate.json()).toMatchObject({code:'DEPOSIT_ADDRESS_ALREADY_ACTIVE'});
    const addresses=await app.inject({method:'GET',url:'/v1/crypto/deposit-addresses',headers:auth});
    expect(addresses.json().items).toHaveLength(1);
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth});
    expect(wallet.json().items[1]).toMatchObject({asset_code:'USDT_BSC',deposit_address:address,funding_enabled:true});
  });

  it('keeps confirming deposits unavailable and enforces the one-USDT minimum',async()=>{
    observations.set(tx1,transfer(tx1,'confirming','2000000000000000000',4));
    const confirming=await post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx1,log_index:0},'usdt-confirming');
    expect(confirming.statusCode,confirming.body).toBe(200);expect(confirming.json()).toMatchObject({state:'confirming',
      amount_minor:'2000000000000000000',confirmations:4});
    observations.set(tx2,transfer(tx2,'finalized','999999999999999999',12));
    const tooSmall=await post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx2,log_index:0},'usdt-too-small');
    expect(tooSmall.statusCode).toBe(422);expect(tooSmall.json()).toMatchObject({code:'DEPOSIT_MINIMUM_NOT_MET'});
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth});
    expect(wallet.json().items[1].available_minor).toBe('0');
  });

  it('credits one finalized transfer exactly once under concurrent retries',async()=>{
    observations.set(tx1,transfer(tx1,'finalized','2000000000000000000',12));
    const replay=await post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx1,log_index:0},'usdt-confirming');
    expect(replay.json()).toMatchObject({state:'confirming',confirmations:4});
    const request=(key:string)=>post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx1,log_index:0},key);
    const [first,retry]=await Promise.all([request('usdt-finalize-a'),request('usdt-finalize-b')]);
    expect(first.statusCode,first.body).toBe(200);expect(retry.statusCode,retry.body).toBe(200);
    expect(first.json()).toMatchObject({state:'finalized',amount_minor:'2000000000000000000'});
    expect(retry.json()).toMatchObject({id:first.json().id,state:'finalized'});
    const journals=await db.query<{count:string}>("SELECT count(*)::text AS count FROM ledger_journals WHERE kind='deposit_finalized' AND reference_id=$1",[first.json().id]);
    expect(journals.rows[0]?.count).toBe('1');
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth});
    expect(wallet.json().items[1]).toMatchObject({available_minor:'2000000000000000000',reserved_minor:'0'});
  });

  it('marks a pre-final reorg without credit and opens an exception for a post-final contradiction',async()=>{
    observations.set(tx3,transfer(tx3,'reverted','3000000000000000000',0));
    const reverted=await post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx3,log_index:0},'usdt-reverted');
    expect(reverted.statusCode,reverted.body).toBe(200);expect(reverted.json().state).toBe('reverted');
    await db.query("UPDATE token_asset_registry SET approved=false WHERE asset_code='USDT_BSC'");
    await db.query("UPDATE crypto_deposit_addresses SET state='retired',updated_at=now() WHERE owner_id=$1 AND asset_code='USDT_BSC'",
      [traderId]);
    observations.set(tx1,{state:'missing',chainId:'56',transactionHash:tx1,logIndex:0,
      finalityPolicyRef:'bsc:independent-rpc:12-confirmations-v1'});
    const exception=await post('/v1/crypto/deposits',{asset:'USDT_BSC',transaction_hash:tx1,log_index:0},'usdt-finality-exception');
    expect(exception.statusCode,exception.body).toBe(200);expect(exception.json().state).toBe('exception');
    const financial=await db.query<{severity:string;details_code:string}>(`SELECT severity,details_code FROM financial_exceptions
      WHERE scope='crypto_deposit' AND reference_id=$1`,[exception.json().id]);
    expect(financial.rows).toEqual([{severity:'critical',details_code:'FINALIZED_DEPOSIT_REORG'}]);
    const wallet=await app.inject({method:'GET',url:'/v1/wallets',headers:auth});
    expect(wallet.json().items[1].available_minor).toBe('2000000000000000000');
  });
});
