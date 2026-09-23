import { randomUUID } from 'node:crypto';
import type { Account } from '../identity/auth.js';
import { accountAssurance } from '../identity/capabilities.js';
import { accountBalance, ledgerAccount, lockOwnerAsset, postJournal } from '../financial/ledger.js';
import { reserve } from '../financial/reservations.js';
import { getMarket } from '../markets/service.js';
import type { Sql } from '../platform/database.js';
import { AppError,requireCondition } from '../platform/errors.js';
import { parseOrderAmount, parsePrice, type OrderSide } from '../trading/model.js';
import { previewAmmQuote, type AmmExposure, type AmmLimits } from './amm-model.js';

interface PoolRow {
  market_id:string;outcome_id:string;asset_code:string;status:'open'|'halted';inventory_limit:string;
  subsidy_limit:string;loss_limit:string;max_slippage_bps:number;impact_bps:number;fee_bps:number;
  shares_committed:string;subsidy_committed:string;worst_case_loss_committed:string;funded_minor:string;contract_unit_minor:string;
}
interface ReferenceRow {id:string;market_id:string;outcome_id:string;asset_code:string;price:string;observed_at:Date;expires_at:Date;source_ref:string}
interface QuoteRow {id:string;owner_id:string;market_id:string;outcome_id:string;asset_code:string;side:OrderSide;quantity:string;
  reference_price_id:string;price:string;user_collateral:string;amm_collateral:string;fee:string;user_total:string;
  expires_at:Date;state:'quoted'|'executed'|'expired';created_at:Date;executed_at:Date|null}

const limits=(row:PoolRow):AmmLimits=>({inventoryLimit:BigInt(row.inventory_limit),subsidyLimit:BigInt(row.subsidy_limit),
  lossLimit:BigInt(row.loss_limit),maxSlippageBps:BigInt(row.max_slippage_bps),impactBps:BigInt(row.impact_bps),
  feeBps:BigInt(row.fee_bps)});
const exposure=(row:PoolRow):AmmExposure=>({sharesCommitted:BigInt(row.shares_committed),
  subsidyCommitted:BigInt(row.subsidy_committed),worstCaseLossCommitted:BigInt(row.worst_case_loss_committed)});
const publicQuote=(row:QuoteRow,pool:PoolRow)=>({...row,asset_code:pool.asset_code,contract_unit_minor:pool.contract_unit_minor,
  expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString(),
  executed_at:row.executed_at?new Date(row.executed_at).toISOString():null});

async function poolFor(sql:Sql,marketId:string,outcomeId:string,assetCode?:string,lock:'SHARE'|'UPDATE'|null=null){
  const rows=(await sql.query<PoolRow>(`SELECT * FROM amm_pools WHERE market_id=$1 AND outcome_id=$2
    ${assetCode?'AND asset_code=$3':''} ORDER BY asset_code${lock?` FOR ${lock}`:''}`,
    assetCode?[marketId,outcomeId,assetCode]:[marketId,outcomeId])).rows;
  requireCondition(rows.length>0,404,'AMM_NOT_FOUND','AMM pool not found.');
  requireCondition(assetCode||rows.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for this AMM pool.');
  return rows[0]!;
}

export async function activateAmm(sql:Sql,actor:Account,marketId:string,outcomeId:string,impactBps:number,assetCode?:string){
  const market=await getMarket(sql,marketId,true);
  requireCondition(market.state==='scheduled'&&market.published_at&&market.terms.liquidity.amm_enabled,
    409,'AMM_NOT_APPROVED','The published market does not approve an AMM backstop.');
  requireCondition(market.terms.outcomes.some(outcome=>outcome.id===outcomeId),422,'INVALID_OUTCOME','Choose a published outcome.');
  const bindings=(await sql.query<{asset_code:string;contract_unit_minor:string;approved:boolean;synthetic:boolean}>(`SELECT b.asset_code,
    b.contract_unit_minor::text,b.approved,a.synthetic FROM clob_asset_bindings b JOIN financial_assets a ON a.code=b.asset_code
    WHERE b.policy_ref=$1 AND a.approved=true ${assetCode?'AND b.asset_code=$2':''} ORDER BY b.asset_code FOR SHARE`,
    assetCode?[market.terms.risk.settlement_asset_ref,assetCode]:[market.terms.risk.settlement_asset_ref])).rows;
  requireCondition(assetCode||bindings.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for this AMM pool.');
  const binding=bindings[0];
  requireCondition(binding?.approved&&binding.synthetic,403,'ASSET_NOT_APPROVED','AMM collateral requires an approved synthetic binding.');
  const trading=(await sql.query<{asset_code:string;contract_unit_minor:string}>(
    'SELECT asset_code,contract_unit_minor::text FROM clob_markets WHERE market_id=$1 AND asset_code=$2 FOR SHARE',
    [marketId,binding.asset_code])).rows[0];
  requireCondition(trading?.asset_code===binding.asset_code&&trading.contract_unit_minor===binding.contract_unit_minor,409,'TRADING_NOT_ACTIVE',
    'Activate the governed trading market with the same collateral asset before its AMM.');
  const liquidity=market.terms.liquidity;
  return (await sql.query<PoolRow>(`INSERT INTO amm_pools(market_id,outcome_id,asset_code,contract_unit_minor,inventory_limit,subsidy_limit,
    loss_limit,max_slippage_bps,impact_bps,fee_bps,activated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [marketId,outcomeId,binding.asset_code,binding.contract_unit_minor,liquidity.inventory_limit_minor,liquidity.subsidy_limit_minor,
    liquidity.loss_limit_minor,liquidity.max_slippage_bps,impactBps,market.terms.risk.fee_bps,actor.id])).rows[0]!;
}

export async function fundAmm(sql:Sql,actor:Account,marketId:string,outcomeId:string,amountText:string,request:string,assetCode?:string){
  const amount=parseOrderAmount(amountText,'amount');
  const pool=await poolFor(sql,marketId,outcomeId,assetCode,'UPDATE');
  requireCondition(BigInt(pool.funded_minor)+amount<=BigInt(pool.subsidy_limit),409,'AMM_SUBSIDY_LIMIT','Funding exceeds the approved subsidy.');
  const custody=await ledgerAccount(sql,null,pool.asset_code,'escrow_asset');
  const treasury=await ledgerAccount(sql,null,pool.asset_code,'liquidity_reserve');
  await postJournal(sql,{effectId:`amm:${marketId}:${outcomeId}:fund:${request}`,asset:pool.asset_code,kind:'amm_treasury_funded',
    referenceId:marketId,reason:'Governed synthetic AMM treasury funding',lines:[
      {account:custody,debit:amount,credit:0n},{account:treasury,debit:0n,credit:amount},
    ]});
  await sql.query(`UPDATE amm_pools SET funded_minor=funded_minor+$4::numeric,updated_at=now()
    WHERE market_id=$1 AND outcome_id=$2 AND asset_code=$3`,[marketId,outcomeId,pool.asset_code,amount.toString()]);
  return {market_id:marketId,outcome_id:outcomeId,asset_code:pool.asset_code,
    funded_minor:(BigInt(pool.funded_minor)+amount).toString()};
}

export async function recordAmmReference(sql:Sql,actor:Account,input:{marketId:string;outcomeId:string;price:string;
  observedAt:Date;expiresAt:Date;sourceRef:string;assetCode?:string}){
  const price=parsePrice(input.price);
  const pool=await poolFor(sql,input.marketId,input.outcomeId,input.assetCode,'SHARE');
  requireCondition(pool?.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  requireCondition(input.observedAt<=new Date()&&input.expiresAt>new Date()&&input.expiresAt>input.observedAt,
    422,'INVALID_REFERENCE_PRICE','Reference price must be observed and currently fresh.');
  return (await sql.query<ReferenceRow>(`INSERT INTO amm_reference_prices(id,market_id,outcome_id,asset_code,price,observed_at,
    expires_at,source_ref,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [randomUUID(),input.marketId,input.outcomeId,pool.asset_code,price.toString(),input.observedAt,input.expiresAt,input.sourceRef,actor.id])).rows[0]!;
}

export async function createAmmQuote(sql:Sql,actor:Account,input:{marketId:string;outcomeId:string;side:OrderSide;
  quantity:string;limitPrice:string;assetCode?:string},now=new Date()){
  const pool=await poolFor(sql,input.marketId,input.outcomeId,input.assetCode,'SHARE');
  requireCondition(pool?.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  const market=await getMarket(sql,input.marketId);
  requireCondition(now.getTime()>=Date.parse(market.terms.open_at)&&now.getTime()<Date.parse(market.terms.trading_cutoff),
    409,'MARKET_NOT_OPEN','The published trading window is closed.');
  requireCondition(market.terms.jurisdictions.includes(actor.jurisdiction),403,'COUNTRY_POLICY_BLOCKED',
    'This market is not available in your jurisdiction.');
  const country=(await sql.query<{trading_enabled:boolean}>(`SELECT trading_enabled FROM country_policies
    WHERE jurisdiction=$1 AND category=$2 FOR SHARE`,[actor.jurisdiction,market.terms.category])).rows[0];
  requireCondition(country?.trading_enabled,403,'COUNTRY_POLICY_BLOCKED','Trading is not enabled for this jurisdiction and category.');
  const assurance=await accountAssurance(sql,actor);
  requireCondition(actor.status==='active'&&assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
    403,'TRADING_NOT_ELIGIBLE','Trading requires an active, verified, eligible account.');
  const reference=(await sql.query<ReferenceRow>(`SELECT * FROM amm_reference_prices WHERE market_id=$1 AND outcome_id=$2
    AND asset_code=$3 AND observed_at<=$4 AND expires_at>$4 ORDER BY observed_at DESC,id DESC LIMIT 1`,
    [input.marketId,input.outcomeId,pool.asset_code,now])).rows[0];
  requireCondition(reference,409,'AMM_REFERENCE_STALE','No fresh approved AMM reference price is available.');
  let quote:ReturnType<typeof previewAmmQuote>;
  try{quote=previewAmmQuote(limits(pool),exposure(pool),{side:input.side,
    quantity:parseOrderAmount(input.quantity,'quantity'),referencePrice:BigInt(reference.price),
    limitPrice:parsePrice(input.limitPrice),contractUnit:BigInt(pool.contract_unit_minor)});}catch(error){
    throw new AppError(409,'AMM_QUOTE_REJECTED',error instanceof Error?error.message:'AMM quote rejected.');
  }
  requireCondition(BigInt(pool.funded_minor)>=quote.nextExposure.subsidyCommitted,409,'AMM_TREASURY_UNFUNDED',
    'The AMM treasury does not fund this quote.');
  const expiresAt=new Date(Math.min(reference.expires_at.getTime(),now.getTime()+15_000));
  const row=(await sql.query<QuoteRow>(`INSERT INTO amm_quotes(id,owner_id,market_id,outcome_id,asset_code,side,quantity,
    reference_price_id,price,user_collateral,amm_collateral,fee,user_total,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[randomUUID(),actor.id,input.marketId,
    input.outcomeId,pool.asset_code,input.side,quote.quantity.toString(),reference.id,quote.price.toString(),quote.userCollateral.toString(),
    quote.ammCollateral.toString(),quote.fee.toString(),quote.userTotal.toString(),expiresAt])).rows[0]!;
  return publicQuote(row,pool);
}

export async function listAmmQuotes(sql:Sql,owner:string,marketId:string,assetCode?:string){
  const pools=(await sql.query<PoolRow>(`SELECT * FROM amm_pools WHERE market_id=$1 ${assetCode?'AND asset_code=$2':''}
    ORDER BY asset_code,outcome_id`,assetCode?[marketId,assetCode]:[marketId])).rows;
  requireCondition(pools.length>0,404,'AMM_NOT_FOUND','AMM pool not found.');
  requireCondition(assetCode||new Set(pools.map(pool=>pool.asset_code)).size===1,422,'ASSET_REQUIRED',
    'Choose NGN or USDT_BSC for AMM quotes.');
  const pool=pools[0]!;
  const rows=(await sql.query<QuoteRow>(`SELECT * FROM amm_quotes WHERE owner_id=$1 AND market_id=$2
    AND asset_code=$3 ORDER BY created_at DESC,id DESC LIMIT 100`,[owner,marketId,pool.asset_code])).rows;
  return {items:rows.map(row=>publicQuote(row,pool))};
}

export async function executeAmmQuote(sql:Sql,actor:Account,quoteId:string,request:string,now=new Date()){
  const quote=(await sql.query<QuoteRow>('SELECT * FROM amm_quotes WHERE id=$1 FOR UPDATE',[quoteId])).rows[0];
  requireCondition(quote&&quote.owner_id===actor.id,404,'AMM_QUOTE_NOT_FOUND','AMM quote not found.');
  requireCondition(quote.state==='quoted',409,'AMM_QUOTE_TERMINAL','AMM quote is no longer executable.');
  requireCondition(new Date(quote.expires_at)>now,409,'AMM_QUOTE_EXPIRED','AMM quote expired.');
  const trading=(await sql.query<{status:string}>(
    'SELECT status FROM clob_markets WHERE market_id=$1 AND asset_code=$2 FOR UPDATE',[quote.market_id,quote.asset_code])).rows[0];
  const market=await getMarket(sql,quote.market_id);
  requireCondition(trading?.status==='open'&&now.getTime()<Date.parse(market.terms.trading_cutoff),
    409,'MARKET_NOT_OPEN','The published trading window is closed.');
  const pool=await poolFor(sql,quote.market_id,quote.outcome_id,quote.asset_code,'UPDATE');
  requireCondition(pool.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  const assurance=await accountAssurance(sql,actor);
  requireCondition(actor.status==='active'&&assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
    403,'TRADING_NOT_ELIGIBLE','Trading requires an active, verified, eligible account.');
  const nextShares=BigInt(pool.shares_committed)+BigInt(quote.quantity);
  const nextSubsidy=BigInt(pool.subsidy_committed)+BigInt(quote.amm_collateral);
  const nextLoss=BigInt(pool.worst_case_loss_committed)+BigInt(quote.amm_collateral);
  requireCondition(nextShares<=BigInt(pool.inventory_limit)&&nextSubsidy<=BigInt(pool.subsidy_limit)&&
    nextLoss<=BigInt(pool.loss_limit)&&nextSubsidy<=BigInt(pool.funded_minor),409,'AMM_LIMIT_CHANGED',
    'AMM capacity changed after this quote was created.');
  await lockOwnerAsset(sql,actor.id,pool.asset_code);
  const reservation=await reserve(sql,{owner:actor.id,asset:pool.asset_code,purpose:'amm',reference:quote.id,amount:quote.user_total});
  const userHeld=await ledgerAccount(sql,actor.id,pool.asset_code,'user_reserved');
  const treasury=await ledgerAccount(sql,null,pool.asset_code,'liquidity_reserve');
  requireCondition(await accountBalance(sql,treasury)>=BigInt(quote.amm_collateral),409,'AMM_TREASURY_UNFUNDED','AMM treasury balance is insufficient.');
  const escrow=await ledgerAccount(sql,null,pool.asset_code,'market_escrow');
  const fees=await ledgerAccount(sql,null,pool.asset_code,'protocol_fee');
  await postJournal(sql,{effectId:`amm:${quote.id}:execution`,asset:pool.asset_code,kind:'amm_execution',referenceId:quote.id,
    reason:'Execute bounded synthetic AMM quote',lines:[
      {account:userHeld,debit:BigInt(quote.user_total),credit:0n},{account:treasury,debit:BigInt(quote.amm_collateral),credit:0n},
      {account:escrow,debit:0n,credit:BigInt(quote.user_collateral)+BigInt(quote.amm_collateral)},
      ...(BigInt(quote.fee)>0n?[{account:fees,debit:0n,credit:BigInt(quote.fee)}]:[]),
    ]});
  await sql.query("UPDATE collateral_reservations SET consumed=amount,state='consumed',updated_at=now() WHERE id=$1",[reservation.id]);
  await sql.query(`UPDATE amm_pools SET shares_committed=$3,subsidy_committed=$4,worst_case_loss_committed=$5,
    updated_at=now() WHERE market_id=$1 AND outcome_id=$2 AND asset_code=$6`,[quote.market_id,quote.outcome_id,nextShares.toString(),
    nextSubsidy.toString(),nextLoss.toString(),quote.asset_code]);
  const row=(await sql.query<QuoteRow>("UPDATE amm_quotes SET state='executed',executed_at=$2 WHERE id=$1 RETURNING *",
    [quote.id,now])).rows[0]!;
  const event=(await sql.query<{sequence:string}>(`UPDATE clob_markets SET next_sequence=next_sequence+1,updated_at=now()
    WHERE market_id=$1 AND asset_code=$2 RETURNING id,(next_sequence-1)::text AS sequence`,
    [quote.market_id,quote.asset_code])).rows[0] as {id:string;sequence:string};
  await sql.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type,fill_id)
    VALUES($1,$2,$3,'amm_execution',$4)`,[event.id,quote.market_id,event.sequence,quote.id]);
  return publicQuote(row,pool);
}
