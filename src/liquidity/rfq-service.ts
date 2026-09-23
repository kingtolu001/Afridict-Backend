import {createHash,createPublicKey,randomUUID,verify} from 'node:crypto';
import type {Account} from '../identity/auth.js';
import {accountAssurance} from '../identity/capabilities.js';
import {ledgerAccount,lockOwnerAsset,postJournal} from '../financial/ledger.js';
import {reserve} from '../financial/reservations.js';
import {getMarket,type MarketRow} from '../markets/service.js';
import {record} from '../platform/commands.js';
import type {Sql} from '../platform/database.js';
import {AppError,requireCondition} from '../platform/errors.js';
import {contractCollateral,executionFee,parseOrderAmount,parsePrice,type OrderSide} from '../trading/model.js';

interface EntityRow {id:string;legal_name:string;status:'pending'|'active'|'suspended';exposure_limit_minor:string;
  created_by:string;approved_by:string|null;approved_at:Date|null;created_at:Date;updated_at:Date}
interface MembershipRow {entity_id:string;account_id:string;role:'requester'|'dealer';signing_public_key:string|null;
  signing_key_fingerprint:string|null}
interface RequestRow {id:string;entity_id:string;owner_id:string;market_id:string;asset_code:string;outcome_id:string;side:OrderSide;
  quantity:string;expires_at:Date;state:'open'|'accepted'|'cancelled'|'expired';accepted_quote_id:string|null;
  created_at:Date;updated_at:Date}
interface QuoteRow {id:string;request_id:string;dealer_entity_id:string;dealer_owner_id:string;price:string;
  expires_at:Date;nonce:string;signing_key_fingerprint:string;signature:string;payload_hash:string;
  state:'open'|'accepted'|'rejected'|'expired';created_at:Date;updated_at:Date}
interface FillRow {id:string;request_id:string;quote_id:string;market_id:string;asset_code:string;requester_entity_id:string;
  dealer_entity_id:string;requester_owner_id:string;dealer_owner_id:string;requester_side:OrderSide;outcome_id:string;
  price:string;quantity:string;buyer_collateral:string;seller_collateral:string;buyer_fee:string;seller_fee:string;
  journal_id:string;sequence:string;created_at:Date}
type Collateral={asset_code:string;contract_unit_minor:string};

const iso=(value:Date)=>new Date(value).toISOString();
const publicEntity=(row:EntityRow)=>({...row,approved_at:row.approved_at?iso(row.approved_at):null,
  created_at:iso(row.created_at),updated_at:iso(row.updated_at)});
const publicRequest=(row:RequestRow,collateral:Collateral,now=new Date())=>({id:row.id,entity_id:row.entity_id,market_id:row.market_id,
  asset_code:collateral.asset_code,contract_unit_minor:collateral.contract_unit_minor,
  outcome_id:row.outcome_id,side:row.side,quantity:row.quantity,expires_at:iso(row.expires_at),
  state:row.state==='open'&&row.expires_at<=now?'expired':row.state,
  accepted_quote_id:row.accepted_quote_id,created_at:iso(row.created_at),updated_at:iso(row.updated_at)});
const publicQuote=(row:QuoteRow,collateral:Collateral,now=new Date())=>({id:row.id,request_id:row.request_id,dealer_entity_id:row.dealer_entity_id,
  asset_code:collateral.asset_code,contract_unit_minor:collateral.contract_unit_minor,
  price:row.price,expires_at:iso(row.expires_at),nonce:row.nonce,signing_key_fingerprint:row.signing_key_fingerprint,
  signature:row.signature,payload_hash:row.payload_hash,state:row.state==='open'&&row.expires_at<=now?'expired':row.state,
  created_at:iso(row.created_at),updated_at:iso(row.updated_at)});
export const publicRfqFill=(row:FillRow,collateral:Collateral)=>({id:row.id,request_id:row.request_id,quote_id:row.quote_id,
  asset_code:collateral.asset_code,contract_unit_minor:collateral.contract_unit_minor,
  market_id:row.market_id,outcome_id:row.outcome_id,requester_side:row.requester_side,price:row.price,
  quantity:row.quantity,sequence:row.sequence,created_at:iso(row.created_at)});

export function rfqSigningPayload(input:{requestId:string;price:string;expiresAt:string;nonce:string}){
  return JSON.stringify({version:1,request_id:input.requestId,price:input.price,
    expires_at:new Date(input.expiresAt).toISOString(),nonce:input.nonce});
}
export function signingKeyFingerprint(publicKey:string){
  try{
    const key=createPublicKey({key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'});
    requireCondition(key.asymmetricKeyType==='ed25519',422,'INVALID_SIGNING_KEY','Use an Ed25519 SPKI public key.');
    return createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  }catch(error){
    if(error instanceof AppError)throw error;
    throw new AppError(422,'INVALID_SIGNING_KEY','Use a base64-encoded Ed25519 SPKI public key.');
  }
}

export async function createRfqEntity(sql:Sql,actor:Account,legalName:string,exposure:string,request:string){
  const limit=parseOrderAmount(exposure,'exposure_limit_minor');
  const row=(await sql.query<EntityRow>(`INSERT INTO rfq_entities(id,legal_name,exposure_limit_minor,created_by)
    VALUES($1,$2,$3,$4) RETURNING *`,[randomUUID(),legalName.trim(),limit.toString(),actor.id])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'compliance_officer',action:'rfq.entity_created',resource:row.id,
    request,reason:'Begin institutional RFQ onboarding',after:{legal_name:row.legal_name,exposure_limit_minor:limit.toString()}});
  return publicEntity(row);
}
export async function approveRfqEntity(sql:Sql,actor:Account,id:string,request:string){
  const entity=(await sql.query<EntityRow>('SELECT * FROM rfq_entities WHERE id=$1 FOR UPDATE',[id])).rows[0];
  requireCondition(entity,404,'RFQ_ENTITY_NOT_FOUND','RFQ entity not found.');
  requireCondition(entity.status==='pending',409,'RFQ_ENTITY_STATE','Only a pending RFQ entity can be approved.');
  requireCondition(entity.created_by!==actor.id,403,'SEPARATION_OF_DUTIES','A different compliance officer must approve this entity.');
  const row=(await sql.query<EntityRow>(`UPDATE rfq_entities SET status='active',approved_by=$2,approved_at=now(),
    updated_at=now() WHERE id=$1 RETURNING *`,[id,actor.id])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'compliance_officer',action:'rfq.entity_approved',resource:id,
    request,reason:'Approve institutional RFQ participation',after:{status:'active'}});
  return publicEntity(row);
}
export async function addRfqMember(sql:Sql,actor:Account,entityId:string,accountId:string,role:'requester'|'dealer',
  publicKey:string|undefined,request:string){
  const entity=(await sql.query<EntityRow>('SELECT * FROM rfq_entities WHERE id=$1 FOR SHARE',[entityId])).rows[0];
  requireCondition(entity?.status==='active',409,'RFQ_ENTITY_STATE','Membership requires an active RFQ entity.');
  requireCondition((await sql.query('SELECT id FROM accounts WHERE id=$1',[accountId])).rows[0],422,'ACCOUNT_NOT_FOUND','Account not found.');
  requireCondition((role==='dealer'&&Boolean(publicKey))||(role==='requester'&&!publicKey),422,'INVALID_SIGNING_KEY',
    'Dealer memberships require a signing key; requester memberships must omit it.');
  const fingerprint=role==='dealer'?signingKeyFingerprint(publicKey!):null;
  await sql.query(`INSERT INTO rfq_entity_memberships(entity_id,account_id,role,signing_public_key,
    signing_key_fingerprint,added_by) VALUES($1,$2,$3,$4,$5,$6)`,
  [entityId,accountId,role,role==='dealer'?publicKey:null,fingerprint,actor.id]);
  await record(sql,{actor:actor.id,authority:'compliance_officer',action:'rfq.member_added',resource:entityId,
    request,reason:'Authorize institutional RFQ account',after:{account_id:accountId,role,
      signing_key_fingerprint:fingerprint}});
  return {entity_id:entityId,account_id:accountId,role,signing_key_fingerprint:fingerprint};
}
export async function listRfqEntities(sql:Sql){
  const rows=(await sql.query<EntityRow>('SELECT * FROM rfq_entities ORDER BY created_at,id LIMIT 100')).rows;
  return {items:rows.map(publicEntity)};
}
export async function listRfqMembers(sql:Sql,entityId:string){
  requireCondition((await sql.query('SELECT id FROM rfq_entities WHERE id=$1',[entityId])).rows[0],404,
    'RFQ_ENTITY_NOT_FOUND','RFQ entity not found.');
  const rows=(await sql.query<MembershipRow>(`SELECT * FROM rfq_entity_memberships WHERE entity_id=$1
    ORDER BY created_at,account_id,role LIMIT 100`,[entityId])).rows;
  return {items:rows.map(row=>({entity_id:row.entity_id,account_id:row.account_id,role:row.role,
    signing_key_fingerprint:row.signing_key_fingerprint}))};
}

async function membership(sql:Sql,accountId:string,entityId:string,role:'requester'|'dealer'){
  const row=(await sql.query<MembershipRow>(`SELECT m.* FROM rfq_entity_memberships m JOIN rfq_entities e ON e.id=m.entity_id
    WHERE m.account_id=$1 AND m.entity_id=$2 AND m.role=$3 AND e.status='active' FOR SHARE`,
  [accountId,entityId,role])).rows[0];
  requireCondition(row,403,'RFQ_MEMBERSHIP_REQUIRED',`An active institutional ${role} membership is required.`);
  return row;
}
async function eligible(sql:Sql,market:MarketRow,actor:Account){
  const assurance=await accountAssurance(sql,actor);
  requireCondition(actor.status==='active'&&assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
    403,'TRADING_NOT_ELIGIBLE','Trading requires an active, verified, eligible account.');
  requireCondition(market.terms.jurisdictions.includes(actor.jurisdiction),403,'COUNTRY_POLICY_BLOCKED',
    'This market is not available in your jurisdiction.');
  const policy=(await sql.query<{trading_enabled:boolean}>(`SELECT trading_enabled FROM country_policies
    WHERE jurisdiction=$1 AND category=$2 FOR SHARE`,[actor.jurisdiction,market.terms.category])).rows[0];
  requireCondition(policy?.trading_enabled,403,'COUNTRY_POLICY_BLOCKED','Trading is not enabled for this jurisdiction and category.');
}
async function entityExposure(sql:Sql,entityId:string,marketId:string,assetCode:string){
  const row=(await sql.query<{amount:string}>(`SELECT COALESCE(sum(f.quantity*m.contract_unit_minor),0)::text AS amount
    FROM rfq_fills f JOIN clob_markets m ON m.market_id=f.market_id AND m.asset_code=f.asset_code
    WHERE f.market_id=$1 AND f.asset_code=$2 AND (f.requester_entity_id=$3 OR f.dealer_entity_id=$3)`,
    [marketId,assetCode,entityId])).rows[0]!;
  return BigInt(row.amount);
}
async function collateralBook(sql:Sql,marketId:string,assetCode?:string,lock=false){
  const books=(await sql.query<{id:string;asset_code:string;contract_unit_minor:string;status:string}>(
    `SELECT id,asset_code,contract_unit_minor::text,status FROM clob_markets WHERE market_id=$1
     ${assetCode?'AND asset_code=$2':''} ORDER BY asset_code${lock?' FOR UPDATE':''}`,
    assetCode?[marketId,assetCode]:[marketId])).rows;
  requireCondition(assetCode||books.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for this RFQ.');
  const book=books[0];
  requireCondition(book,404,'NOT_FOUND','Trading market not found.');
  return book;
}
async function marketReady(sql:Sql,marketId:string,now:Date,assetCode?:string){
  const book=await collateralBook(sql,marketId,assetCode,true);
  requireCondition(book?.status==='open',409,'MARKET_NOT_OPEN','The trading market is not open.');
  const market=await getMarket(sql,marketId);
  requireCondition(market.terms.liquidity.rfq_enabled&&now.getTime()>=Date.parse(market.terms.open_at)&&
    now.getTime()<Date.parse(market.terms.trading_cutoff),409,'RFQ_NOT_OPEN','RFQ is not enabled in the published trading window.');
  return {book,market};
}

export async function createRfqRequest(sql:Sql,actor:Account,input:{entityId:string;marketId:string;outcomeId:string;
  side:OrderSide;quantity:string;expiresAt:Date;assetCode?:string},request:string,now=new Date()){
  await membership(sql,actor.id,input.entityId,'requester');
  const {book,market}=await marketReady(sql,input.marketId,now,input.assetCode);await eligible(sql,market,actor);
  requireCondition(market.terms.outcomes.some(outcome=>outcome.id===input.outcomeId),422,'INVALID_OUTCOME','Choose a published outcome.');
  const quantity=parseOrderAmount(input.quantity,'quantity'),unit=BigInt(book.contract_unit_minor),exposure=quantity*unit;
  requireCondition(input.expiresAt>now&&input.expiresAt.getTime()<=Date.parse(market.terms.trading_cutoff),
    422,'INVALID_RFQ_EXPIRY','RFQ expiry must be in the current published trading window.');
  const entity=(await sql.query<EntityRow>('SELECT * FROM rfq_entities WHERE id=$1 FOR SHARE',[input.entityId])).rows[0]!;
  const open=(await sql.query<{amount:string}>(`SELECT COALESCE(sum(quantity),0)::text AS amount FROM rfq_requests
    WHERE entity_id=$1 AND market_id=$2 AND asset_code=$3 AND state='open' AND expires_at>$4`,
    [input.entityId,input.marketId,book.asset_code,now])).rows[0]!;
  requireCondition(await entityExposure(sql,input.entityId,input.marketId,book.asset_code)+BigInt(open.amount)*unit+exposure<=BigInt(entity.exposure_limit_minor),
    409,'RFQ_EXPOSURE_LIMIT','The entity RFQ exposure limit would be exceeded.');
  const row=(await sql.query<RequestRow>(`INSERT INTO rfq_requests(id,entity_id,owner_id,market_id,asset_code,outcome_id,side,
    quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),input.entityId,actor.id,
    input.marketId,book.asset_code,input.outcomeId,input.side,quantity.toString(),input.expiresAt])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'rfq_requester',action:'rfq.request_created',resource:row.id,request,
    reason:'Request an institutional synthetic quote',after:{market_id:input.marketId,outcome_id:input.outcomeId,
      side:input.side,quantity:quantity.toString(),expires_at:input.expiresAt.toISOString()}});
  return publicRequest(row,book);
}

export async function createRfqQuote(sql:Sql,actor:Account,input:{entityId:string;requestId:string;price:string;
  expiresAt:Date;nonce:string;signature:string},request:string,now=new Date()){
  const member=await membership(sql,actor.id,input.entityId,'dealer');
  let rfq=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1',[input.requestId])).rows[0];
  requireCondition(rfq?.state==='open'&&rfq.expires_at>now,409,'RFQ_REQUEST_NOT_OPEN','The RFQ request is not open.');
  const {book,market}=await marketReady(sql,rfq.market_id,now,rfq.asset_code);await eligible(sql,market,actor);
  rfq=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1 FOR SHARE',[input.requestId])).rows[0];
  requireCondition(rfq?.state==='open'&&rfq.expires_at>now,409,'RFQ_REQUEST_NOT_OPEN','The RFQ request is not open.');
  requireCondition(rfq.entity_id!==input.entityId&&rfq.owner_id!==actor.id,403,'RFQ_SELF_DEAL','Requester and dealer must be independent.');
  const price=parsePrice(input.price),expiresAt=input.expiresAt.toISOString();
  requireCondition(input.expiresAt>now&&input.expiresAt<=rfq.expires_at&&input.expiresAt.getTime()<=now.getTime()+300_000,
    422,'INVALID_RFQ_EXPIRY','Dealer quote expiry must be within five minutes and before the request expires.');
  const payload=rfqSigningPayload({requestId:rfq.id,price:price.toString(),expiresAt,nonce:input.nonce});
  let valid=false;
  try{valid=verify(null,Buffer.from(payload),createPublicKey({key:Buffer.from(member.signing_public_key!,'base64'),
    format:'der',type:'spki'}),Buffer.from(input.signature,'base64'));}catch{valid=false;}
  requireCondition(valid,422,'INVALID_RFQ_SIGNATURE','The quote signature does not match the approved dealer key.');
  requireCondition(!(await sql.query('SELECT id FROM rfq_quotes WHERE dealer_entity_id=$1 AND nonce=$2',
    [input.entityId,input.nonce])).rows[0],409,'RFQ_NONCE_REUSED','The dealer nonce has already been used.');
  const row=(await sql.query<QuoteRow>(`INSERT INTO rfq_quotes(id,request_id,dealer_entity_id,dealer_owner_id,
    price,expires_at,nonce,signing_key_fingerprint,signature,payload_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),rfq.id,input.entityId,actor.id,
    price.toString(),input.expiresAt,input.nonce,member.signing_key_fingerprint,input.signature,
    createHash('sha256').update(payload).digest('hex')])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'rfq_dealer',action:'rfq.quote_created',resource:row.id,request,
    reason:'Submit a signed institutional synthetic quote',after:{request_id:rfq.id,price:price.toString(),
      expires_at:expiresAt,payload_hash:row.payload_hash,signing_key_fingerprint:row.signing_key_fingerprint}});
  return publicQuote(row,book);
}

export async function acceptRfqQuote(sql:Sql,actor:Account,requestId:string,quoteId:string,command:string,now=new Date()){
  let rfq=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1',[requestId])).rows[0];
  requireCondition(rfq&&rfq.owner_id===actor.id,404,'RFQ_REQUEST_NOT_FOUND','RFQ request not found.');
  const ready=await marketReady(sql,rfq.market_id,now,rfq.asset_code);
  rfq=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
  requireCondition(rfq&&rfq.owner_id===actor.id,404,'RFQ_REQUEST_NOT_FOUND','RFQ request not found.');
  requireCondition(rfq.state==='open'&&rfq.expires_at>now,409,'RFQ_REQUEST_NOT_OPEN','The RFQ request is not open.');
  const quote=(await sql.query<QuoteRow>('SELECT * FROM rfq_quotes WHERE id=$1 AND request_id=$2 FOR UPDATE',[quoteId,requestId])).rows[0];
  requireCondition(quote?.state==='open'&&quote.expires_at>now,409,'RFQ_QUOTE_NOT_OPEN','The RFQ quote is expired or terminal.');
  const {book,market}=ready;
  const dealer=(await sql.query<Account>('SELECT * FROM accounts WHERE id=$1 FOR SHARE',[quote.dealer_owner_id])).rows[0]!;
  await membership(sql,actor.id,rfq.entity_id,'requester');await membership(sql,dealer.id,quote.dealer_entity_id,'dealer');
  await eligible(sql,market,actor);await eligible(sql,market,dealer);
  const entities=(await sql.query<EntityRow>('SELECT * FROM rfq_entities WHERE id=ANY($1::uuid[]) FOR SHARE',
    [[rfq.entity_id,quote.dealer_entity_id].sort()])).rows;
  const unit=BigInt(book.contract_unit_minor),exposure=BigInt(rfq.quantity)*unit;
  for(const entity of entities)requireCondition(await entityExposure(sql,entity.id,rfq.market_id,rfq.asset_code)+exposure<=BigInt(entity.exposure_limit_minor),
    409,'RFQ_EXPOSURE_LIMIT','An entity RFQ exposure limit changed before acceptance.');
  const price=BigInt(quote.price),quantity=BigInt(rfq.quantity),collateral=contractCollateral(quantity,price,unit);
  const feeBps=BigInt(market.terms.risk.fee_bps),buyerFee=executionFee('buy',quantity,price,feeBps,unit),
    sellerFee=executionFee('sell',quantity,price,feeBps,unit);
  const buyer=rfq.side==='buy'?actor:dealer,seller=rfq.side==='sell'?actor:dealer;
  for(const owner of [buyer.id,seller.id].sort())await lockOwnerAsset(sql,owner,book.asset_code);
  const buyerReservation=await reserve(sql,{owner:buyer.id,asset:book.asset_code,purpose:'rfq',
    reference:`${quote.id}:buyer`,amount:(collateral.buyer+buyerFee).toString()});
  const sellerReservation=await reserve(sql,{owner:seller.id,asset:book.asset_code,purpose:'rfq',
    reference:`${quote.id}:seller`,amount:(collateral.seller+sellerFee).toString()});
  const buyerHeld=await ledgerAccount(sql,buyer.id,book.asset_code,'user_reserved');
  const sellerHeld=await ledgerAccount(sql,seller.id,book.asset_code,'user_reserved');
  const escrow=await ledgerAccount(sql,null,book.asset_code,'market_escrow');
  const fees=await ledgerAccount(sql,null,book.asset_code,'protocol_fee');
  const fillId=randomUUID();
  const journal=await postJournal(sql,{effectId:`rfq:${fillId}:execution`,asset:book.asset_code,kind:'rfq_execution',referenceId:fillId,
    reason:'Execute signed institutional synthetic quote',lines:[
      {account:buyerHeld,debit:collateral.buyer+buyerFee,credit:0n},
      {account:sellerHeld,debit:collateral.seller+sellerFee,credit:0n},
      {account:escrow,debit:0n,credit:collateral.total},
      ...((buyerFee+sellerFee)>0n?[{account:fees,debit:0n,credit:buyerFee+sellerFee}]:[]),
    ]});
  for(const reservation of [buyerReservation,sellerReservation])await sql.query(
    "UPDATE collateral_reservations SET consumed=amount,state='consumed',updated_at=now() WHERE id=$1",[reservation.id]);
  const event=(await sql.query<{id:string;sequence:string}>(`UPDATE clob_markets SET next_sequence=next_sequence+1,updated_at=now()
    WHERE market_id=$1 AND asset_code=$2 RETURNING id,(next_sequence-1)::text AS sequence`,
    [rfq.market_id,rfq.asset_code])).rows[0]!;
  const fill=(await sql.query<FillRow>(`INSERT INTO rfq_fills(id,request_id,quote_id,market_id,asset_code,requester_entity_id,
    dealer_entity_id,requester_owner_id,dealer_owner_id,requester_side,outcome_id,price,quantity,buyer_collateral,
    seller_collateral,buyer_fee,seller_fee,journal_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,[fillId,rfq.id,quote.id,rfq.market_id,rfq.asset_code,rfq.entity_id,quote.dealer_entity_id,actor.id,dealer.id,rfq.side,
    rfq.outcome_id,quote.price,rfq.quantity,collateral.buyer.toString(),collateral.seller.toString(),buyerFee.toString(),
    sellerFee.toString(),journal,event.sequence])).rows[0]!;
  await sql.query("UPDATE rfq_quotes SET state='accepted',updated_at=now() WHERE id=$1",[quote.id]);
  await sql.query("UPDATE rfq_quotes SET state='rejected',updated_at=now() WHERE request_id=$1 AND id<>$2 AND state='open'",[rfq.id,quote.id]);
  await sql.query("UPDATE rfq_requests SET state='accepted',accepted_quote_id=$2,updated_at=now() WHERE id=$1",[rfq.id,quote.id]);
  await sql.query("INSERT INTO clob_events(book_id,market_id,sequence,event_type,fill_id) VALUES($1,$2,$3,'rfq_execution',$4)",
    [event.id,rfq.market_id,event.sequence,fill.id]);
  const result=publicRfqFill(fill,book);
  await record(sql,{actor:actor.id,authority:'rfq_requester',action:'rfq.quote_accepted',resource:quote.id,request:command,
    reason:'Accept a signed fully collateralized institutional quote',after:result});
  return result;
}

export async function cancelRfqRequest(sql:Sql,actor:Account,id:string,command:string){
  const row=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  requireCondition(row&&row.owner_id===actor.id,404,'RFQ_REQUEST_NOT_FOUND','RFQ request not found.');
  requireCondition(row.state==='open'&&row.expires_at>new Date(),409,'RFQ_REQUEST_NOT_OPEN','Only an unexpired open RFQ request can be cancelled.');
  const after=(await sql.query<RequestRow>("UPDATE rfq_requests SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0]!;
  await sql.query("UPDATE rfq_quotes SET state='rejected',updated_at=now() WHERE request_id=$1 AND state='open'",[id]);
  await record(sql,{actor:actor.id,authority:'rfq_requester',action:'rfq.request_cancelled',resource:id,request:command,
    reason:'Cancel an open institutional RFQ request',after:{state:'cancelled'}});
  const collateral=(await sql.query<Collateral>(`SELECT asset_code,contract_unit_minor::text FROM clob_markets
    WHERE market_id=$1 AND asset_code=$2`,[row.market_id,row.asset_code])).rows[0]!;
  return publicRequest(after,collateral);
}

export async function listRfqRequests(sql:Sql,actor:Account,marketId:string,assetCode?:string){
  const collateral=await collateralBook(sql,marketId,assetCode);
  const dealer=(await sql.query(`SELECT 1 FROM rfq_entity_memberships m JOIN rfq_entities e ON e.id=m.entity_id
    WHERE m.account_id=$1 AND m.role='dealer' AND e.status='active' LIMIT 1`,[actor.id])).rows[0];
  const rows=(await sql.query<RequestRow>(`SELECT * FROM rfq_requests WHERE market_id=$1 AND asset_code=$2 AND
    (owner_id=$3 OR ($4::boolean AND state='open' AND expires_at>now())) ORDER BY created_at DESC,id DESC LIMIT 100`,
  [marketId,collateral.asset_code,actor.id,Boolean(dealer)])).rows;
  return {items:rows.map(row=>publicRequest(row,collateral))};
}
export async function listRfqQuotes(sql:Sql,actor:Account,requestId:string){
  const rfq=(await sql.query<RequestRow>('SELECT * FROM rfq_requests WHERE id=$1',[requestId])).rows[0];
  requireCondition(rfq,404,'RFQ_REQUEST_NOT_FOUND','RFQ request not found.');
  const rows=(await sql.query<QuoteRow>(`SELECT * FROM rfq_quotes WHERE request_id=$1 AND
    (dealer_owner_id=$2 OR $3::boolean) ORDER BY created_at,id LIMIT 100`,[requestId,actor.id,rfq.owner_id===actor.id])).rows;
  requireCondition(rfq.owner_id===actor.id||rows.length>0,403,'RFQ_NOT_VISIBLE','This RFQ is not visible to the caller.');
  const collateral=(await sql.query<Collateral>(`SELECT asset_code,contract_unit_minor::text FROM clob_markets
    WHERE market_id=$1 AND asset_code=$2`,[rfq.market_id,rfq.asset_code])).rows[0]!;
  return {items:rows.map(row=>publicQuote(row,collateral))};
}
export async function listRfqFills(sql:Sql,actor:Account,marketId:string,assetCode?:string){
  const collateral=await collateralBook(sql,marketId,assetCode);
  const rows=(await sql.query<FillRow>(`SELECT * FROM rfq_fills WHERE market_id=$1 AND asset_code=$2 AND
    (requester_owner_id=$3 OR dealer_owner_id=$3) ORDER BY sequence DESC LIMIT 100`,
    [marketId,collateral.asset_code,actor.id])).rows;
  return {items:rows.map(row=>publicRfqFill(row,collateral))};
}
