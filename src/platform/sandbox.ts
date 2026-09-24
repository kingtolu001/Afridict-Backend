import type {Account} from '../identity/auth.js';
import {grantSandboxAccess} from '../identity/sandbox.js';
import {ledgerAccount,postJournal} from '../financial/ledger.js';
import {hash} from './commands.js';
import type {Database} from './database.js';
import {submitOrder} from '../trading/service.js';
import type {MarketTerms} from '../contracts.js';
import {currentEventCategories,currentEventJurisdictions,currentEventMarkets,currentEventSources} from './current-event-markets.js';

export const sandboxMarketId='00000000-0000-4000-8000-000000000201';
const sandboxBookIds={NGN:'00000000-0000-4000-8000-000000000202',
  USDT_BSC:'00000000-0000-4000-8000-000000000203'} as const;
const sandboxCreatorId='00000000-0000-4000-8000-000000000101';
const sandboxBidderId='00000000-0000-4000-8000-000000000102';
const sandboxSellerId='00000000-0000-4000-8000-000000000103';
const africanJurisdictions=['DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER',
  'SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RW','ST',
  'SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'];

const terms:MarketTerms={
  question:'Will the Afridict NGN sandbox market resolve Yes?',market_type:'binary',template_id:'sandbox-binary',template_version:1,
  outcomes:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],category:'sandbox',jurisdictions:africanJurisdictions,
  open_at:'2020-01-01T00:00:00.000Z',trading_cutoff:'2099-01-01T00:00:00.000Z',
  expected_event_at:'2099-01-02T00:00:00.000Z',resolution_deadline:'2099-01-10T00:00:00.000Z',
  resolution:{criteria:'Sandbox-only outcome used to verify deposit, order and matching integration.',timezone:'Africa/Lagos',
    method:'bonded_proposal',primary_source:{name:'Afridict sandbox source',uri:'https://example.com/afridict-sandbox'},
    fallback_sources:[{name:'Afridict sandbox fallback',uri:'https://example.org/afridict-sandbox'}],
    correction_rule:'Use the latest sandbox fixture before the challenge window closes.',
    cancellation_rule:'Cancel when the sandbox fixture is unavailable.',
    invalid_rule:'Return sandbox collateral under the sandbox payout policy.',challenge_window_seconds:86400,timelock_seconds:3600,
    panel_size:3,adjudication_threshold:2,adjudicator_policy_ref:'sandbox:adjudication-v1',
    bond_policy_ref:'sandbox:bond-v1',payout_policy_ref:'sandbox:payout-v1'},
  risk:{classification:'standard',eligibility_policy_ref:'sandbox:eligibility-v1',exposure_limit_minor:'10000000',
    fee_bps:100,settlement_asset_ref:'sandbox:ngn-collateral-v1'},
  liquidity:{clob:true,amm_enabled:false,rfq_enabled:false,subsidy_limit_minor:'0',inventory_limit_minor:'0',
    loss_limit_minor:'0',max_slippage_bps:100},
};

async function fundMaker(db:Database,accountId:string,asset:'NGN'|'USDT_BSC',amount:bigint,purpose='sandbox-liquidity'){
  const effectId=`${purpose}:${asset}:${accountId}`;
  await db.transaction(async sql=>{
    await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
    if((await sql.query('SELECT 1 FROM ledger_journals WHERE effect_id=$1',[effectId])).rows.length)return;
    const escrow=await ledgerAccount(sql,null,asset,'escrow_asset');
    const available=await ledgerAccount(sql,accountId,asset,'user_available');
    await postJournal(sql,{effectId,asset,kind:'financial_correction',referenceId:accountId,
      reason:'Hosted sandbox liquidity only',lines:[{account:escrow,debit:amount,credit:0n},
        {account:available,debit:0n,credit:amount}]});
  });
}

type SeedOrder={marketId:string;bookId:string;asset:'NGN'|'USDT_BSC';outcome:string;side:'buy'|'sell';price:string};
async function seedOrders(db:Database,actor:Account,orders:SeedOrder[]){
  await db.transaction(async sql=>{
    await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.id]);
    for(const order of orders){
      const exists=(await sql.query(`SELECT 1 FROM clob_orders WHERE book_id=$1 AND owner_id=$2 AND outcome_id=$3
        AND side=$4 AND state='open' LIMIT 1`,[order.bookId,actor.id,order.outcome,order.side])).rows.length;
      if(exists)continue;
      await submitOrder(sql,actor,order.marketId,{asset_code:order.asset,outcome_id:order.outcome,side:order.side,
        limit_price:order.price,quantity:'100'},`hosted-liquidity:${order.marketId}:${order.asset}:${order.outcome}:${order.side}`);
    }
  });
}

export async function bootstrapSandbox(db:Database){
  const actors=await db.transaction(async sql=>{
    for(const [id,subject] of [[sandboxCreatorId,'market'],[sandboxBidderId,'bid-liquidity'],
      [sandboxSellerId,'ask-liquidity']] as const){
      await sql.query(`INSERT INTO accounts(id,issuer,subject,jurisdiction,roles) VALUES ($1,'afridict:sandbox',$2,'NG',ARRAY['user'])
        ON CONFLICT (issuer,subject) DO UPDATE SET status='active'`,[id,subject]);
      await sql.query(`INSERT INTO eligibility(account_id,status,policy_version,evidence_ref) VALUES ($1,'eligible','sandbox:v1','sandbox:test-access')
        ON CONFLICT (account_id) DO NOTHING`,[id]);
      await sql.query('INSERT INTO account_assurance(account_id) VALUES ($1) ON CONFLICT DO NOTHING',[id]);
      await grantSandboxAccess(sql,id);
    }
    const native=(await sql.query<{id:string}>("SELECT id FROM accounts WHERE issuer='afridict:native'")).rows;
    for(const account of native)await grantSandboxAccess(sql,account.id);
    await sql.query(`UPDATE financial_assets SET synthetic=true,approved=true,
      evidence_ref=CASE code WHEN 'NGN' THEN 'sandbox:swervpay-development' ELSE 'sandbox:usdt-trading' END
      WHERE code IN ('NGN','USDT_BSC')`);
    await sql.query(`UPDATE fiat_rail_registry SET approved=true,collections_enabled=true,payouts_enabled=false,
      evidence_ref='sandbox:swervpay-development',reviewed_at=now() WHERE provider='swervpay' AND asset_code='NGN'`);
    await sql.query(`INSERT INTO market_templates(id,version,market_type,approved,evidence_ref) VALUES
      ('sandbox-binary',1,'binary',true,'sandbox:test-market'),
      ('event-binary',1,'binary',true,'hosted:current-events-v1'),
      ('event-categorical',1,'categorical',true,'hosted:current-events-v1'),
      ('event-scalar',1,'scalar',true,'hosted:current-events-v1') ON CONFLICT DO NOTHING`);
    for(const jurisdiction of africanJurisdictions)await sql.query(`INSERT INTO country_policies(jurisdiction,category,policy_version,
      publication_allowed,trading_enabled,evidence_ref) VALUES ($1,'sandbox','sandbox:v1',true,true,'sandbox:test-market')
      ON CONFLICT (jurisdiction,category) DO UPDATE SET trading_enabled=true,evidence_ref='sandbox:test-market'`,[jurisdiction]);
    for(const jurisdiction of currentEventJurisdictions)for(const category of currentEventCategories)
      await sql.query(`INSERT INTO country_policies(jurisdiction,category,policy_version,publication_allowed,trading_enabled,evidence_ref)
        VALUES ($1,$2,'hosted:v1',true,true,'hosted:current-events-v1') ON CONFLICT (jurisdiction,category) DO UPDATE SET
        publication_allowed=true,trading_enabled=true,evidence_ref='hosted:current-events-v1'`,[jurisdiction,category]);
    for(const source of currentEventSources)await sql.query(`INSERT INTO evidence_sources(name,uri,approved,evidence_ref)
      VALUES ($1,$2,true,'hosted:current-events-v1') ON CONFLICT (name,uri) DO UPDATE SET approved=true`,[source.name,source.uri]);
    for(const [kind,policyRef] of [['eligibility','afridict:eligibility-v1'],['adjudication','afridict:adjudication-v1'],
      ['bond','afridict:bond-v1'],['payout','afridict:payout-v1'],['collateral','afridict:multi-currency-v1']] as const)
      await sql.query(`INSERT INTO policy_registry(kind,policy_ref,approved,evidence_ref) VALUES ($1,$2,true,'hosted:current-events-v1')
        ON CONFLICT (kind,policy_ref) DO UPDATE SET approved=true`,[kind,policyRef]);
    await sql.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
      VALUES ($1,$2,'scheduled',$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
    [sandboxMarketId,sandboxCreatorId,JSON.stringify(terms),hash(terms)]);
    await sql.query(`INSERT INTO market_discovery_settings(market_id,featured_rank,updated_by,hidden)
      VALUES ($1,NULL,$2,true) ON CONFLICT (market_id) DO UPDATE SET hidden=true,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [sandboxMarketId,sandboxCreatorId]);
    for(const market of currentEventMarkets)await sql.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
      VALUES ($1,$2,'scheduled',$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
    [market.id,sandboxCreatorId,JSON.stringify(market.terms),hash(market.terms)]);
    await sql.query(`INSERT INTO clob_asset_bindings AS binding
      (policy_ref,asset_code,contract_unit_minor,exposure_limit_minor,approved,evidence_ref) VALUES
      ('sandbox:ngn-collateral-v1','NGN',10000,10000000,true,'sandbox:test-market'),
      ('sandbox:ngn-collateral-v1','USDT_BSC',1000000000000000000,1000000000000000000000,true,'sandbox:test-market')
      ON CONFLICT (policy_ref,asset_code) DO UPDATE SET
        exposure_limit_minor=COALESCE(binding.exposure_limit_minor,EXCLUDED.exposure_limit_minor),approved=true`);
    await sql.query(`INSERT INTO clob_asset_bindings AS binding
      (policy_ref,asset_code,contract_unit_minor,exposure_limit_minor,approved,evidence_ref) VALUES
      ('afridict:multi-currency-v1','NGN',10000,10000000000,true,'hosted:current-events-v1'),
      ('afridict:multi-currency-v1','USDT_BSC',1000000000000000000,10000000000000000000000,true,'hosted:current-events-v1')
      ON CONFLICT (policy_ref,asset_code) DO UPDATE SET exposure_limit_minor=EXCLUDED.exposure_limit_minor,approved=true`);
    await sql.query(`INSERT INTO clob_markets(id,market_id,asset_code,contract_unit_minor,status,activated_by)
      VALUES ($1,$3,'NGN',10000,'open',$4),($2,$3,'USDT_BSC',1000000000000000000,'open',$4)
      ON CONFLICT (market_id,asset_code) DO NOTHING`,
    [sandboxBookIds.NGN,sandboxBookIds.USDT_BSC,sandboxMarketId,sandboxCreatorId]);
    for(const market of currentEventMarkets)await sql.query(`INSERT INTO clob_markets
      (id,market_id,asset_code,contract_unit_minor,status,activated_by) VALUES
      ($1,$3,'NGN',10000,'open',$4),($2,$3,'USDT_BSC',1000000000000000000,'open',$4)
      ON CONFLICT (market_id,asset_code) DO NOTHING`,[market.books.NGN,market.books.USDT_BSC,market.id,sandboxCreatorId]);
    return (await sql.query<Account>(`SELECT * FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[sandboxBidderId,sandboxSellerId]])).rows;
  });
  for(const [asset,amount] of [['NGN',5_000_000n],['USDT_BSC',500n*10n**18n]] as const){
    await fundMaker(db,sandboxBidderId,asset,amount);await fundMaker(db,sandboxSellerId,asset,amount);
  }
  for(const [asset,amount] of [['NGN',1_000_000_000n],['USDT_BSC',20_000n*10n**18n]] as const){
    await fundMaker(db,sandboxBidderId,asset,amount,'hosted-catalog-liquidity-v1');
    await fundMaker(db,sandboxSellerId,asset,amount,'hosted-catalog-liquidity-v1');
  }
  const bidder=actors.find(actor=>actor.id===sandboxBidderId)!;
  const seller=actors.find(actor=>actor.id===sandboxSellerId)!;
  const bids:SeedOrder[]=[],asks:SeedOrder[]=[];
  for(const outcome of ['yes','no']){
    for(const asset of ['NGN','USDT_BSC'] as const){
      bids.push({marketId:sandboxMarketId,bookId:sandboxBookIds[asset],asset,outcome,side:'buy',price:'450000'});
      asks.push({marketId:sandboxMarketId,bookId:sandboxBookIds[asset],asset,outcome,side:'sell',price:'550000'});
    }
  }
  for(const market of currentEventMarkets){
    const now=Date.now();if(now<Date.parse(market.terms.open_at)||now>=Date.parse(market.terms.trading_cutoff))continue;
    for(const outcome of market.terms.outcomes)for(const asset of ['NGN','USDT_BSC'] as const){
      bids.push({marketId:market.id,bookId:market.books[asset],asset,outcome:outcome.id,side:'buy',price:market.bid});
      asks.push({marketId:market.id,bookId:market.books[asset],asset,outcome:outcome.id,side:'sell',price:market.ask});
    }
  }
  await seedOrders(db,bidder,bids);await seedOrders(db,seller,asks);
}
