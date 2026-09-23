import { randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { AppError, requireCondition } from '../platform/errors.js';
import { record } from '../platform/commands.js';
import type { Account } from '../identity/auth.js';
import { accountAssurance } from '../identity/capabilities.js';
import { accountBalance, ledgerAccount, lockOwnerAsset, postJournal } from '../financial/ledger.js';
import { markReleasePending, releaseReservation, reserve } from '../financial/reservations.js';
import { integer } from '../financial/model.js';
import { getMarket, type MarketRow } from '../markets/service.js';
import { contractCollateral, executionFee, matchPriceTime, parseOrderAmount, parsePrice,
  PRICE_SCALE, reservationRequired, type OrderSide, type RestingOrder } from './model.js';

interface ClobMarket {id:string;market_id:string;asset_code:string;asset_scale?:number;contract_unit_minor:string;
  status:'halted'|'open';next_sequence:string}
interface OrderRow { id:string; book_id:string; market_id:string; owner_id:string; reservation_id:string; outcome_id:string;
  side:OrderSide; limit_price:string; quantity:string; remaining:string; reserved_per_share:string;
  state:'open'|'filled'|'cancelled'; sequence:string; created_at:Date; updated_at:Date }
interface FillRow { id:string; book_id:string; market_id:string; maker_order_id:string; taker_order_id:string; outcome_id:string;
  price:string; quantity:string; buyer_collateral:string; seller_collateral:string; buyer_fee:string;
  seller_fee:string; sequence:string; created_at:Date }

export const publicOrder=(order:OrderRow,book:ClobMarket)=>({id:order.id,market_id:order.market_id,asset_code:book.asset_code,
  contract_unit_minor:book.contract_unit_minor,outcome_id:order.outcome_id,
  side:order.side,limit_price:order.limit_price,quantity:order.quantity,remaining:order.remaining,
  state:order.state,sequence:order.sequence,created_at:new Date(order.created_at).toISOString(),
  updated_at:new Date(order.updated_at).toISOString()});
export const publicFill=(fill:FillRow,book:ClobMarket)=>({id:fill.id,market_id:fill.market_id,asset_code:book.asset_code,
  contract_unit_minor:book.contract_unit_minor,
  maker_order_id:fill.maker_order_id,taker_order_id:fill.taker_order_id,outcome_id:fill.outcome_id,
  price:fill.price,quantity:fill.quantity,sequence:fill.sequence,created_at:new Date(fill.created_at).toISOString()});

async function sequence(sql:Sql, bookId:string) {
  const row=(await sql.query<{sequence:string}>(`UPDATE clob_markets SET next_sequence=next_sequence+1,updated_at=now()
    WHERE id=$1 RETURNING (next_sequence-1)::text AS sequence`,[bookId])).rows[0];
  if (!row) throw new Error('Market sequence unavailable');
  return row.sequence;
}
async function event(sql:Sql,book:ClobMarket,kind:string,orderId:string|null=null,fillId:string|null=null) {
  const next=await sequence(sql,book.id);
  await sql.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type,order_id,fill_id)
    VALUES ($1,$2,$3,$4,$5,$6)`,[book.id,book.market_id,next,kind,orderId,fillId]);
  return next;
}

async function marketBook(sql:Sql,marketId:string,assetCode?:string,lock=false,
  missing:{status:number;code:string;message:string}={status:404,code:'NOT_FOUND',message:'Trading book not found.'}){
  const rows=(await sql.query<ClobMarket>(`SELECT m.*,a.scale AS asset_scale FROM clob_markets m
    JOIN financial_assets a ON a.code=m.asset_code WHERE m.market_id=$1
    ${assetCode?'AND m.asset_code=$2':''} ORDER BY m.asset_code${lock?' FOR UPDATE OF m':''}`,
    assetCode?[marketId,assetCode]:[marketId])).rows;
  requireCondition(rows.length>0,missing.status,missing.code,missing.message);
  requireCondition(assetCode||rows.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for this market book.');
  return rows[0]!;
}

async function assertMarketEligibility(sql:Sql,market:MarketRow,actor:Account) {
  await sql.query('SELECT account_id FROM eligibility WHERE account_id=$1 FOR SHARE',[actor.id]);
  await sql.query('SELECT account_id FROM account_assurance WHERE account_id=$1 FOR SHARE',[actor.id]);
  const assurance=await accountAssurance(sql,actor);
  requireCondition(actor.status==='active' && assurance.emailVerifiedAt && assurance.phoneVerifiedAt &&
    assurance.identityStatus==='VERIFIED' && assurance.fundingEligible,403,'TRADING_NOT_ELIGIBLE',
    'Trading requires an active, verified, eligible account.');
  requireCondition(market.terms.jurisdictions.includes(actor.jurisdiction),403,'COUNTRY_POLICY_BLOCKED',
    'This market is not available in your jurisdiction.');
  const country=(await sql.query<{trading_enabled:boolean}>(`SELECT trading_enabled FROM country_policies
    WHERE jurisdiction=$1 AND category=$2 FOR SHARE`,[actor.jurisdiction,market.terms.category])).rows[0];
  requireCondition(country?.trading_enabled,403,'COUNTRY_POLICY_BLOCKED','Trading is not enabled for this jurisdiction and category.');
}

export async function activateClob(sql:Sql,actor:Account,marketId:string,request:string,assetCode?:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.state==='scheduled' && market.published_at && market.terms.liquidity.clob,409,
    'MARKET_NOT_PUBLISHED','A published CLOB market is required.');
  requireCondition(Date.now()>=Date.parse(market.terms.open_at) && Date.now()<Date.parse(market.terms.trading_cutoff),
    409,'MARKET_NOT_OPEN','Activation must occur inside the published trading window.');
  const bindings=(await sql.query<{asset_code:string;scale:number;contract_unit_minor:string;approved:boolean;synthetic:boolean;asset_approved:boolean}>(`SELECT b.asset_code,
    b.contract_unit_minor::text,b.approved,a.scale,a.synthetic,a.approved AS asset_approved FROM clob_asset_bindings b
    JOIN financial_assets a ON a.code=b.asset_code WHERE b.policy_ref=$1 ${assetCode?'AND b.asset_code=$2':''}
    ORDER BY b.asset_code FOR SHARE`,assetCode?[market.terms.risk.settlement_asset_ref,assetCode]:
      [market.terms.risk.settlement_asset_ref])).rows;
  requireCondition(assetCode||bindings.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC to activate a market book.');
  const binding=bindings[0];
  requireCondition(binding?.approved && binding.synthetic && binding.asset_approved,403,'ASSET_NOT_APPROVED',
    'The synthetic collateral asset must have an approved binding to the published policy.');
  for (const jurisdiction of market.terms.jurisdictions) {
    const country=(await sql.query<{trading_enabled:boolean}>(`SELECT trading_enabled FROM country_policies
      WHERE jurisdiction=$1 AND category=$2 FOR SHARE`,[jurisdiction,market.terms.category])).rows[0];
    requireCondition(country?.trading_enabled,403,'COUNTRY_POLICY_BLOCKED','Trading requires all published jurisdictions to be enabled.');
  }
  await sql.query(`INSERT INTO clob_markets(id,market_id,asset_code,contract_unit_minor,status,activated_by)
    VALUES ($1,$2,$3,$4,'halted',$5) ON CONFLICT (market_id,asset_code) DO NOTHING`,
    [randomUUID(),marketId,binding.asset_code,binding.contract_unit_minor,actor.id]);
  const book=await marketBook(sql,marketId,binding.asset_code,true);
  requireCondition(book.status==='halted'&&book.asset_code===binding.asset_code&&book.contract_unit_minor===binding.contract_unit_minor,409,'MARKET_STATE_CONFLICT',
    'The market is already open or uses a different collateral asset.');
  // A halt is terminal until a future governed recovery workflow reviews outstanding orders.
  requireCondition(String(book.next_sequence)==='1',409,'MARKET_STATE_CONFLICT','A halted book cannot be reopened automatically.');
  await sql.query("UPDATE clob_markets SET status='open',updated_at=now() WHERE id=$1",[book.id]);
  const next=await event(sql,book,'activated');
  await record(sql,{actor:actor.id,authority:'market_approver',action:'market.trading_activated',
    resource:marketId,request,reason:'Activate governed synthetic CLOB',after:{asset_code:binding.asset_code,
      contract_unit_minor:binding.contract_unit_minor,sequence:next}});
  return {market_id:marketId,asset_code:binding.asset_code,asset_scale:binding.scale,
    contract_unit_minor:binding.contract_unit_minor,price_scale:PRICE_SCALE.toString(),status:'open' as const,sequence:next};
}

export async function haltClob(sql:Sql,actor:Account,marketId:string,request:string,assetCode?:string) {
  const book=await marketBook(sql,marketId,assetCode,true);
  requireCondition(book?.status==='open',409,'MARKET_STATE_CONFLICT','The market is not open.');
  await sql.query("UPDATE clob_markets SET status='halted',updated_at=now() WHERE id=$1",[book.id]);
  const next=await event(sql,book,'halted');
  await record(sql,{actor:actor.id,authority:'market_approver',action:'market.trading_halted',
    resource:marketId,request,reason:'Stop synthetic trading pending review',after:{sequence:next}});
  return {market_id:marketId,asset_code:book.asset_code,asset_scale:book.asset_scale!,contract_unit_minor:book.contract_unit_minor,
    price_scale:PRICE_SCALE.toString(),status:'halted' as const,sequence:next};
}

async function chargeFill(sql:Sql,book:ClobMarket,order:OrderRow,quantity:bigint,price:bigint,feeBps:bigint,fillId:string) {
  await lockOwnerAsset(sql,order.owner_id,book.asset_code);
  const held=await ledgerAccount(sql,order.owner_id,book.asset_code,'user_reserved');
  const available=await ledgerAccount(sql,order.owner_id,book.asset_code,'user_available');
  const escrow=await ledgerAccount(sql,null,book.asset_code,'market_escrow');
  const fees=await ledgerAccount(sql,null,book.asset_code,'protocol_fee');
  const unit=BigInt(book.contract_unit_minor),collateral=contractCollateral(quantity,price,unit)[order.side==='buy'?'buyer':'seller'];
  const fee=executionFee(order.side,quantity,price,feeBps,unit);
  const reserved=BigInt(order.reserved_per_share)*quantity;
  const actual=collateral+fee;
  requireCondition(actual<=reserved,409,'RESERVATION_CONFLICT','Execution exceeds the reserved limit.');
  const improvement=reserved-actual;
  await postJournal(sql,{effectId:`clob:${fillId}:${order.id}`,asset:book.asset_code,kind:'clob_execution',
    referenceId:fillId,reason:'Matched collateral and per-share execution fee',lines:[
      {account:held,debit:reserved,credit:0n},
      {account:escrow,debit:0n,credit:collateral},
      ...(fee>0n?[{account:fees,debit:0n,credit:fee}]:[]),
      ...(improvement>0n?[{account:available,debit:0n,credit:improvement}]:[]),
    ]});
  const updated=(await sql.query<{state:string}>(`UPDATE collateral_reservations
    SET consumed=consumed+$2::numeric,released=released+$3::numeric,
      state=CASE WHEN consumed+released+$2::numeric+$3::numeric=amount THEN 'consumed'
        ELSE 'partially_consumed' END,updated_at=now()
    WHERE id=$1 AND consumed+released+$2::numeric+$3::numeric<=amount RETURNING state`,
  [order.reservation_id,actual.toString(),improvement.toString()])).rows[0];
  requireCondition(updated,409,'RESERVATION_CONFLICT','Order reservation was consumed by another financial effect.');
}

export async function submitOrder(sql:Sql,actor:Account,marketId:string,input:{outcome_id:string;side:OrderSide;
  limit_price:string;quantity:string;asset_code?:string},request:string) {
  let quantity:bigint,price:bigint;
  try {quantity=parseOrderAmount(input.quantity,'quantity');price=parsePrice(input.limit_price);}
  catch {throw new AppError(422,'INVALID_ORDER','Quantity and price must be positive exact integers within the price scale.');}
  const book=await marketBook(sql,marketId,input.asset_code,true,
    {status:409,code:'MARKET_NOT_OPEN',message:'The order book is not open.'});
  requireCondition(book?.status==='open',409,'MARKET_NOT_OPEN','The order book is not open.');
  const market=await getMarket(sql,marketId);
  requireCondition(market.state==='scheduled' && market.terms.outcomes.some(o=>o.id===input.outcome_id),
    422,'INVALID_OUTCOME','Choose a published outcome.');
  requireCondition(Date.now()>=Date.parse(market.terms.open_at) && Date.now()<Date.parse(market.terms.trading_cutoff),
    409,'MARKET_NOT_OPEN','The published trading window is closed.');
  await assertMarketEligibility(sql,market,actor);
  const binding=(await sql.query<{approved:boolean;asset_approved:boolean;synthetic:boolean}>(`
    SELECT b.approved,a.approved AS asset_approved,a.synthetic
    FROM clob_asset_bindings b JOIN financial_assets a ON a.code=b.asset_code
    WHERE b.policy_ref=$1 AND b.asset_code=$2 FOR SHARE`,
    [market.terms.risk.settlement_asset_ref,book.asset_code])).rows[0];
  requireCondition(binding?.approved && binding.asset_approved && binding.synthetic,403,'ASSET_NOT_APPROVED',
    'The market collateral binding is no longer approved.');
  const unit=BigInt(book.contract_unit_minor),exposure=quantity*unit,limit=integer(market.terms.risk.exposure_limit_minor);
  requireCondition(exposure<=limit,409,'EXPOSURE_LIMIT','Order quantity exceeds the published exposure limit.');
  const existing=(await sql.query<{exposure:string}>(`SELECT
    COALESCE((SELECT sum(CASE WHEN o.state='open' THEN o.quantity ELSE o.quantity-o.remaining END)
      FROM clob_orders o WHERE o.book_id=$1 AND o.owner_id=$2),0)::text AS exposure`,
    [book.id,actor.id])).rows[0];
  // Count each open order's full quantity; filled and cancelled orders retain only matched exposure.
  requireCondition(BigInt(existing?.exposure??'0')*unit+exposure<=limit,409,'EXPOSURE_LIMIT',
    'Open orders, matched positions and the new order exceed the published exposure limit.');
  const feeBps=BigInt(market.terms.risk.fee_bps);
  const required=reservationRequired(input.side,quantity,price,feeBps,unit);
  const id=randomUUID();
  const reservation=await reserve(sql,{owner:actor.id,asset:book.asset_code,purpose:'clob',reference:id,amount:required.total.toString()});
  const next=await sequence(sql,book.id);
  let incoming=(await sql.query<OrderRow>(`INSERT INTO clob_orders(id,book_id,market_id,owner_id,reservation_id,outcome_id,side,
    limit_price,quantity,remaining,reserved_per_share,sequence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING *`,
  [id,book.id,marketId,actor.id,reservation.id,input.outcome_id,input.side,price.toString(),quantity.toString(),
    (required.total/quantity).toString(),next])).rows[0]!;
  await sql.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type,order_id)
    VALUES ($1,$2,$3,'order_accepted',$4)`,[book.id,marketId,next,id]);

  const resting=(await sql.query<OrderRow>(`SELECT * FROM clob_orders WHERE book_id=$1 AND outcome_id=$2
    AND side<>$3 AND state='open' AND owner_id<>$4 AND id<>$5`,
  [book.id,input.outcome_id,input.side,actor.id,id])).rows;
  const plan=matchPriceTime(input.side,price,quantity,resting.map((o):RestingOrder=>({
    id:o.id,side:o.side,price:BigInt(o.limit_price),remaining:BigInt(o.remaining),sequence:BigInt(o.sequence)})));
  const fills:ReturnType<typeof publicFill>[]=[];
  for (const match of plan.matches) {
    const maker=resting.find(o=>o.id===match.makerId)!;
    const counterparty=(await sql.query<Account>('SELECT * FROM accounts WHERE id=$1 FOR SHARE',[maker.owner_id])).rows[0]!;
    await assertMarketEligibility(sql,market,counterparty);
    const fillId=randomUUID(),counterpart=contractCollateral(match.quantity,match.price,unit);
    const buyer=input.side==='buy'?incoming:maker,seller=input.side==='sell'?incoming:maker;
    // Lock accounts in stable owner order before any ledger changes.
    for (const owner of [buyer.owner_id,seller.owner_id].sort()) await lockOwnerAsset(sql,owner,book.asset_code);
    await chargeFill(sql,book,buyer,match.quantity,match.price,feeBps,fillId);
    await chargeFill(sql,book,seller,match.quantity,match.price,feeBps,fillId);
    const fillSequence=await sequence(sql,book.id);
    const fill=(await sql.query<FillRow>(`INSERT INTO clob_fills(id,book_id,market_id,maker_order_id,taker_order_id,
      outcome_id,price,quantity,buyer_collateral,seller_collateral,buyer_fee,seller_fee,sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [fillId,book.id,marketId,maker.id,id,input.outcome_id,match.price.toString(),match.quantity.toString(),
      counterpart.buyer.toString(),counterpart.seller.toString(),
      executionFee('buy',match.quantity,match.price,feeBps,unit).toString(),
      executionFee('sell',match.quantity,match.price,feeBps,unit).toString(),fillSequence])).rows[0]!;
    await sql.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type,order_id,fill_id)
      VALUES ($1,$2,$3,'fill',$4,$5)`,[book.id,marketId,fillSequence,id,fillId]);
    await sql.query(`UPDATE clob_orders SET remaining=remaining-$2::numeric,
      state=CASE WHEN remaining=$2::numeric THEN 'filled' ELSE 'open' END,updated_at=now()
      WHERE id=$1`,[maker.id,match.quantity.toString()]);
    fills.push(publicFill(fill,book));
  }
  if(plan.remaining!==quantity) incoming=(await sql.query<OrderRow>(`UPDATE clob_orders SET remaining=$2,
    state=CASE WHEN $2::numeric=0 THEN 'filled' ELSE 'open' END,updated_at=now()
    WHERE id=$1 RETURNING *`,[id,plan.remaining.toString()])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'account_owner',action:'clob.order_accepted',resource:id,
    request,reason:'Synthetic limit order with reserved collateral',
    after:{market_id:marketId,outcome_id:input.outcome_id,side:input.side,quantity:input.quantity,
      limit_price:input.limit_price,sequence:next,fill_count:fills.length}});
  return {order:publicOrder(incoming,book),fills};
}

export async function cancelOrder(sql:Sql,actor:Account,marketId:string,orderId:string,request:string) {
  const reference=(await sql.query<{market_id:string;book_id:string}>(`SELECT market_id,book_id FROM clob_orders
    WHERE id=$1 AND owner_id=$2 AND market_id=$3`,[orderId,actor.id,marketId])).rows[0];
  requireCondition(reference,404,'NOT_FOUND','Order not found.');
  const book=(await sql.query<ClobMarket>('SELECT * FROM clob_markets WHERE id=$1 FOR UPDATE',[reference.book_id])).rows[0]!;
  const row=(await sql.query<OrderRow>('SELECT * FROM clob_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0]!;
  requireCondition(row.state==='open' && BigInt(row.remaining)>0n,409,'ORDER_NOT_OPEN','Only an open order can be cancelled.');
  await markReleasePending(sql,row.reservation_id);
  await releaseReservation(sql,row.reservation_id,(BigInt(row.remaining)*BigInt(row.reserved_per_share)).toString(),orderId);
  const after=(await sql.query<OrderRow>(`UPDATE clob_orders SET state='cancelled',updated_at=now()
    WHERE id=$1 RETURNING *`,[orderId])).rows[0]!;
  const next=await event(sql,book,'order_cancelled',orderId);
  await record(sql,{actor:actor.id,authority:'account_owner',action:'clob.order_cancelled',resource:orderId,
    request,reason:'Cancel unmatched order quantity',after:{sequence:next,remaining:row.remaining}});
  return publicOrder(after,book);
}

export async function orderBook(sql:Sql,marketId:string,outcomeId:string,assetCode?:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.published_at && market.terms.outcomes.some(o=>o.id===outcomeId),404,'NOT_FOUND','Order book not found.');
  const book=await marketBook(sql,marketId,assetCode);
  const rows=(await sql.query<{side:OrderSide;price:string;quantity:string}>(`SELECT side,limit_price::text AS price,
    sum(remaining)::text AS quantity FROM clob_orders WHERE book_id=$1 AND outcome_id=$2 AND state='open'
    GROUP BY side,limit_price ORDER BY side,limit_price`,[book.id,outcomeId])).rows;
  return {market_id:marketId,outcome_id:outcomeId,asset_code:book?.asset_code??null,asset_scale:book?.asset_scale??null,
    contract_unit_minor:book?.contract_unit_minor??null,price_scale:PRICE_SCALE.toString(),status:book?.status??'halted',
    sequence:book?String(BigInt(book.next_sequence)-1n):'0',bids:rows.filter(r=>r.side==='buy')
      .sort((a,b)=>BigInt(a.price)>BigInt(b.price)?-1:1).map(({price,quantity})=>({price,quantity})),
    asks:rows.filter(r=>r.side==='sell').map(({price,quantity})=>({price,quantity}))};
}

export async function marketEvents(sql:Sql,marketId:string,after:string,assetCode?:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.published_at,404,'NOT_FOUND','Market not found.');
  const cursor=integer(after);
  const book=await marketBook(sql,marketId,assetCode);
  const latest=BigInt(book.next_sequence)-1n;
  requireCondition(cursor<=latest,409,'CURSOR_AHEAD','The event cursor is ahead of the market sequence. Refetch the current snapshot.');
  const rows=(await sql.query<{sequence:string;event_type:string;order_id:string|null;fill_id:string|null}>(`
    SELECT sequence::text,event_type,order_id,fill_id FROM clob_events
    WHERE book_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 101`,[book.id,cursor.toString()])).rows;
  const items=rows.slice(0,100);
  return {market_id:marketId,asset_code:book.asset_code,items,next_sequence:items.at(-1)?.sequence??after,has_more:rows.length>100};
}

export async function marketCollateralPolicy(sql:Sql,marketId:string,assetCode?:string){
  const market=await getMarket(sql,marketId);requireCondition(market.published_at,404,'NOT_FOUND','Market not found.');
  const rows=(await sql.query<{asset_code:string;asset_scale:number;contract_unit_minor:string;status:string}>(`SELECT b.asset_code,
    a.scale AS asset_scale,b.contract_unit_minor::text,COALESCE(m.status,'halted') AS status FROM clob_asset_bindings b
    JOIN financial_assets a ON a.code=b.asset_code LEFT JOIN clob_markets m ON m.market_id=$2 AND m.asset_code=b.asset_code
    WHERE b.policy_ref=$1 AND b.approved=true AND a.approved=true ${assetCode?'AND b.asset_code=$3':''}
    ORDER BY b.asset_code`,assetCode?[market.terms.risk.settlement_asset_ref,marketId,assetCode]:
      [market.terms.risk.settlement_asset_ref,marketId])).rows;
  requireCondition(assetCode||rows.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for the collateral projection.');
  const row=rows[0];
  requireCondition(row,409,'MARKET_COLLATERAL_UNAVAILABLE','The market has no approved collateral binding.');
  return {market_id:marketId,asset_code:row.asset_code,asset_scale:row.asset_scale,
    contract_unit_minor:row.contract_unit_minor,price_scale:PRICE_SCALE.toString(),trading_status:row.status};
}

export async function marketCollateral(sql:Sql,ownerId:string,marketId:string,assetCode?:string){
  const row=await marketCollateralPolicy(sql,marketId,assetCode);
  const balances=(await sql.query<{bucket:string;amount:string}>(`SELECT a.bucket,
    COALESCE(sum(CASE WHEN a.normal_side='debit' THEN e.debit-e.credit ELSE e.credit-e.debit END),0)::text AS amount
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.owner_id=$1 AND a.asset_code=$2
    GROUP BY a.bucket`,[ownerId,row.asset_code])).rows;
  const balance=(bucket:string)=>balances.find(item=>item.bucket===bucket)?.amount??'0';
  const sources=(await sql.query<{source_asset:string}>(`SELECT DISTINCT r.source_asset FROM conversion_rate_snapshots r
    JOIN financial_assets source ON source.code=r.source_asset AND source.approved=true
    JOIN ledger_accounts a ON a.owner_id=$1 AND a.asset_code=r.source_asset AND a.bucket='user_available'
    JOIN ledger_entries e ON e.account_id=a.id WHERE r.destination_asset=$2 AND r.expires_at>now()
    GROUP BY r.source_asset HAVING sum(e.credit-e.debit)>0 ORDER BY r.source_asset`,[ownerId,row.asset_code])).rows;
  return {...row,
    available_minor:balance('user_available'),reserved_minor:balance('user_reserved'),
    withdrawal_pending_minor:balance('user_withdrawal_pending'),conversion_sources:sources.map(source=>source.source_asset)};
}

export async function listOrders(sql:Sql,ownerId:string,marketId:string,assetCode?:string) {
  const book=await marketBook(sql,marketId,assetCode);
  return {items:(await sql.query<OrderRow>(`SELECT * FROM clob_orders WHERE owner_id=$1 AND book_id=$2
    ORDER BY sequence DESC LIMIT 100`,[ownerId,book.id])).rows.map(row=>publicOrder(row,book))};
}

export async function listFills(sql:Sql,ownerId:string,marketId:string,assetCode?:string) {
  const book=await marketBook(sql,marketId,assetCode);
  return {items:(await sql.query<FillRow>(`SELECT f.* FROM clob_fills f
    JOIN clob_orders maker ON maker.id=f.maker_order_id JOIN clob_orders taker ON taker.id=f.taker_order_id
    WHERE f.book_id=$1 AND (maker.owner_id=$2 OR taker.owner_id=$2)
    ORDER BY f.sequence DESC LIMIT 100`,[book.id,ownerId])).rows.map(row=>publicFill(row,book))};
}

export async function listPositions(sql:Sql,ownerId:string,marketId:string,assetCode?:string) {
  const book=await marketBook(sql,marketId,assetCode);
  const rows=(await sql.query<{outcome_id:string;side:OrderSide;quantity:string;collateral_minor:string;
    fees_minor:string}>(`WITH positions AS (SELECT f.outcome_id,o.side,f.quantity,
      CASE WHEN o.side='buy' THEN f.buyer_collateral ELSE f.seller_collateral END AS collateral_minor,
      CASE WHEN o.side='buy' THEN f.buyer_fee ELSE f.seller_fee END AS fees_minor
    FROM clob_fills f JOIN clob_orders o ON o.id IN (f.maker_order_id,f.taker_order_id)
    WHERE f.book_id=$3 AND o.owner_id=$2 AND NOT EXISTS
      (SELECT 1 FROM resolution_redemptions r WHERE r.fill_id=f.id)
    UNION ALL
    SELECT q.outcome_id,q.side,q.quantity,q.user_collateral,q.fee FROM amm_quotes q
    JOIN amm_pools p ON p.market_id=q.market_id AND p.outcome_id=q.outcome_id
    WHERE q.market_id=$1 AND p.asset_code=$4 AND q.owner_id=$2 AND q.state='executed' AND NOT EXISTS
      (SELECT 1 FROM amm_redemptions r WHERE r.quote_id=q.id)
    UNION ALL
    SELECT f.outcome_id,
      CASE WHEN f.requester_owner_id=$2 THEN f.requester_side
        WHEN f.requester_side='buy' THEN 'sell' ELSE 'buy' END AS side,
      f.quantity,
      CASE WHEN (f.requester_owner_id=$2 AND f.requester_side='buy') OR
        (f.dealer_owner_id=$2 AND f.requester_side='sell') THEN f.buyer_collateral ELSE f.seller_collateral END,
      CASE WHEN (f.requester_owner_id=$2 AND f.requester_side='buy') OR
        (f.dealer_owner_id=$2 AND f.requester_side='sell') THEN f.buyer_fee ELSE f.seller_fee END
    FROM rfq_fills f JOIN ledger_journals j ON j.id=f.journal_id
    WHERE f.market_id=$1 AND j.asset_code=$4 AND (f.requester_owner_id=$2 OR f.dealer_owner_id=$2)
      AND NOT EXISTS (SELECT 1 FROM rfq_redemptions r WHERE r.fill_id=f.id))
    SELECT outcome_id,side,sum(quantity)::text AS quantity,
      sum(collateral_minor)::text AS collateral_minor,sum(fees_minor)::text AS fees_minor
    FROM positions GROUP BY outcome_id,side ORDER BY outcome_id,side`,
  [marketId,ownerId,book.id,book.asset_code])).rows;
  return {items:rows.map(row=>({market_id:marketId,asset_code:book.asset_code,
    contract_unit_minor:book.contract_unit_minor,...row}))};
}

export async function marketEscrowBalance(sql:Sql,asset:string) {
  return accountBalance(sql,await ledgerAccount(sql,null,asset,'market_escrow'));
}
