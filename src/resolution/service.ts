import { randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { AppError,requireCondition } from '../platform/errors.js';
import { hash,record } from '../platform/commands.js';
import type { Account } from '../identity/auth.js';
import { getMarket,type MarketRow } from '../markets/service.js';
import { ledgerAccount,lockOwnerAsset,postJournal } from '../financial/ledger.js';
import { markReleasePending,releaseReservation,reserve } from '../financial/reservations.js';
import { payoutForFill,validateResult,type ResolutionResult } from './model.js';

interface EvidenceRow {id:string;market_id:string;submitted_by:string;source_name:string;source_uri:string;
  artifact_ref:string;document_sha256:string;record_hash:string;observed_at:Date;created_at:Date}
interface CaseRow {market_id:string;proposed_by:string;proposal:ResolutionResult;proposal_evidence_id:string;
  proposal_bond_id:string;proposed_at:Date;challenge_deadline:Date;timelock_until:Date;
  state:'proposed'|'challenged'|'finalized';challenged_by:string|null;challenge:ResolutionResult|null;
  challenge_evidence_id:string|null;challenge_bond_id:string|null;final_result:ResolutionResult|null;
  final_result_hash:string|null;finalized_by:string|null;finalized_at:Date|null}
interface Binding {asset_code:string;bond_minor:string;approved:boolean;invalid_payout:string;synthetic:boolean;asset_approved:boolean}
interface Fill {id:string;asset_code:string;contract_unit_minor:string;book_id:string;outcome_id:string;quantity:string;buyer_collateral:string;seller_collateral:string;
  maker_owner:string;taker_owner:string;maker_side:'buy'|'sell';taker_side:'buy'|'sell'}
interface AmmFill {id:string;asset_code:string;contract_unit_minor:string;owner_id:string;outcome_id:string;side:'buy'|'sell';quantity:string;
  buyer_collateral:string;seller_collateral:string}
interface RfqFill {id:string;asset_code:string;contract_unit_minor:string;outcome_id:string;quantity:string;buyer_collateral:string;seller_collateral:string;
  requester_owner_id:string;dealer_owner_id:string;requester_side:'buy'|'sell'}

const iso=(date:Date)=>new Date(date).toISOString();
export const publicEvidence=(row:EvidenceRow)=>({id:row.id,market_id:row.market_id,
  source_name:row.source_name,source_uri:row.source_uri,artifact_ref:row.artifact_ref,
  document_sha256:row.document_sha256,record_hash:row.record_hash,observed_at:iso(row.observed_at),
  created_at:iso(row.created_at)});
export const publicCase=(row:CaseRow)=>({market_id:row.market_id,state:row.state,proposal:row.proposal,
  proposal_evidence_id:row.proposal_evidence_id,proposed_at:iso(row.proposed_at),
  challenge_deadline:iso(row.challenge_deadline),timelock_until:iso(row.timelock_until),
  challenge:row.challenge,challenge_evidence_id:row.challenge_evidence_id,
  final_result:row.final_result,final_result_hash:row.final_result_hash,
  finalized_at:row.finalized_at?iso(row.finalized_at):null});

async function book(sql:Sql,marketId:string) {
  return (await sql.query<{asset_code:string;contract_unit_minor:string;status:string;next_sequence:string}>(
    `SELECT asset_code,contract_unit_minor::text,status,next_sequence FROM clob_markets
     WHERE market_id=$1 ORDER BY asset_code FOR UPDATE`,[marketId])).rows[0];
}
async function marketEvent(sql:Sql,marketId:string,type:string,orderId:string|null=null,bookId?:string) {
  const rows=(await sql.query<{id:string;sequence:string}>(`UPDATE clob_markets SET next_sequence=next_sequence+1,
    updated_at=now() WHERE market_id=$1 ${bookId?'AND id=$2':''}
    RETURNING id,(next_sequence-1)::text AS sequence`,bookId?[marketId,bookId]:[marketId])).rows;
  for(const row of rows)await sql.query(`INSERT INTO clob_events(book_id,market_id,sequence,event_type,order_id)
    VALUES ($1,$2,$3,$4,$5)`,[row.id,marketId,row.sequence,type,orderId]);
  return rows[0]?.sequence??'0';
}
async function policy(sql:Sql,market:MarketRow,asset:string) {
  const row=(await sql.query<Binding>(`SELECT b.asset_code,b.bond_minor::text,b.approved,b.invalid_payout,
    a.synthetic,a.approved AS asset_approved FROM resolution_policy_bindings b
    JOIN financial_assets a ON a.code=b.asset_code WHERE b.bond_policy_ref=$1
    AND b.payout_policy_ref=$2 AND b.asset_code=$3 FOR SHARE`,
    [market.terms.resolution.bond_policy_ref,market.terms.resolution.payout_policy_ref,asset])).rows[0];
  requireCondition(row?.approved && row.synthetic && row.asset_approved &&
    row.invalid_payout==='refund_recorded_collateral',403,'RESOLUTION_POLICY_NOT_APPROVED',
    'Approved synthetic bond and payout policy bindings are required.');
  for(const [kind,ref] of [['bond',market.terms.resolution.bond_policy_ref],
    ['payout',market.terms.resolution.payout_policy_ref]]){
    const entry=(await sql.query<{approved:boolean}>(`SELECT approved FROM policy_registry
      WHERE kind=$1 AND policy_ref=$2 FOR SHARE`,[kind,ref])).rows[0];
    requireCondition(entry?.approved,403,'RESOLUTION_POLICY_NOT_APPROVED',
      'The published bond and payout policies must remain approved.');
  }
  return row;
}
async function getCase(sql:Sql,marketId:string,lock=false) {
  const row=(await sql.query<CaseRow>(`SELECT * FROM resolution_cases WHERE market_id=$1${lock?' FOR UPDATE':''}`,[marketId])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Resolution case not found.');
  return row;
}
async function checkedEvidence(sql:Sql,marketId:string,evidenceId:string,actorId?:string) {
  const evidence=(await sql.query<EvidenceRow>(`SELECT * FROM resolution_evidence WHERE id=$1 AND market_id=$2`,
    [evidenceId,marketId])).rows[0];
  requireCondition(evidence && (!actorId || evidence.submitted_by===actorId),422,'EVIDENCE_REQUIRED',
    'Use an archived evidence record submitted for this market.');
  return evidence;
}
function checkedResult(market:MarketRow,result:ResolutionResult) {
  try{validateResult(market.terms,result);}catch{throw new AppError(422,'INVALID_RESOLUTION_RESULT',
    'The result is incompatible with the published market structure.');}
}

export async function closeResolutionBook(sql:Sql,actor:Account,marketId:string,now:Date,request:string) {
  const market=await getMarket(sql,marketId),states=(await sql.query<{id:string;status:string}>(
    'SELECT id,status FROM clob_markets WHERE market_id=$1 ORDER BY id FOR UPDATE',[marketId])).rows;
  requireCondition(market.published_at && states.length>0,404,'NOT_FOUND','Published trading book not found.');
  requireCondition(now.getTime()>=Date.parse(market.terms.trading_cutoff),409,'TRADING_WINDOW_OPEN',
    'The published trading cutoff has not passed.');
  if(states.some(state=>state.status==='open')){
    await sql.query("UPDATE clob_markets SET status='halted',updated_at=now() WHERE market_id=$1",[marketId]);
    await marketEvent(sql,marketId,'halted');
  }
  await sql.query("UPDATE amm_pools SET status='halted',updated_at=now() WHERE market_id=$1 AND status='open'",[marketId]);
  await sql.query("UPDATE rfq_quotes SET state='expired',updated_at=now() WHERE request_id IN (SELECT id FROM rfq_requests WHERE market_id=$1 AND state='open') AND state='open'",[marketId]);
  await sql.query("UPDATE rfq_requests SET state='expired',updated_at=now() WHERE market_id=$1 AND state='open'",[marketId]);
  const orders=(await sql.query<{id:string;book_id:string;reservation_id:string;remaining:string;reserved_per_share:string}>(`
    SELECT id,book_id,reservation_id,remaining::text,reserved_per_share::text FROM clob_orders
    WHERE market_id=$1 AND state='open' ORDER BY book_id,sequence LIMIT 100 FOR UPDATE`,[marketId])).rows;
  for(const order of orders){
    await markReleasePending(sql,order.reservation_id);
    await releaseReservation(sql,order.reservation_id,
      (BigInt(order.remaining)*BigInt(order.reserved_per_share)).toString(),order.id);
    await sql.query("UPDATE clob_orders SET state='cancelled',updated_at=now() WHERE id=$1",[order.id]);
    await marketEvent(sql,marketId,'order_cancelled',order.id,order.book_id);
  }
  const left=(await sql.query<{count:string}>(`SELECT count(*)::text AS count FROM clob_orders
    WHERE market_id=$1 AND state='open'`,[marketId])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'market_approver',action:'resolution.book_closed',
    resource:marketId,request,reason:'Expire unmatched orders after published trading cutoff',
    after:{cancelled:orders.length,remaining:left.count}});
  return {market_id:marketId,status:'halted',cancelled:orders.length,remaining: left.count};
}

export async function archiveEvidence(sql:Sql,actor:Account,marketId:string,input:{source_name:string;
  source_uri:string;artifact_ref:string;document_sha256:string;observed_at:string},now:Date,request:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.published_at,404,'NOT_FOUND','Published market not found.');
  const allowed=[market.terms.resolution.primary_source,...market.terms.resolution.fallback_sources];
  requireCondition(allowed.some(s=>s.name===input.source_name && s.uri===input.source_uri),422,'SOURCE_NOT_APPROVED',
    'Evidence must come from the published source hierarchy.');
  const source=(await sql.query<{approved:boolean}>(`SELECT approved FROM evidence_sources
    WHERE name=$1 AND uri=$2 FOR SHARE`,[input.source_name,input.source_uri])).rows[0];
  requireCondition(source?.approved,422,'SOURCE_NOT_APPROVED','Evidence source approval has been withdrawn.');
  const observed=new Date(input.observed_at);
  requireCondition(Number.isFinite(observed.getTime()) && observed.getTime()<=now.getTime()+300000,
    422,'INVALID_EVIDENCE_TIME','Observation time cannot be in the future.');
  const recordHash=hash({market_id:marketId,source_name:input.source_name,source_uri:input.source_uri,
    artifact_ref:input.artifact_ref,document_sha256:input.document_sha256,observed_at:observed.toISOString()});
  const existing=(await sql.query<{id:string}>(`SELECT id FROM resolution_evidence
    WHERE market_id=$1 AND record_hash=$2`,[marketId,recordHash])).rows[0];
  requireCondition(!existing,409,'EVIDENCE_ALREADY_ARCHIVED','This evidence record is already archived.');
  const row=(await sql.query<EvidenceRow>(`INSERT INTO resolution_evidence
    (id,market_id,submitted_by,source_name,source_uri,artifact_ref,document_sha256,record_hash,observed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),marketId,actor.id,
    input.source_name,input.source_uri,input.artifact_ref,input.document_sha256,recordHash,observed])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'resolution_proposer',action:'resolution.evidence_archived',
    resource:row.id,request,reason:'Reference externally archived source evidence',
    after:{market_id:marketId,record_hash:recordHash,document_sha256:input.document_sha256}});
  return publicEvidence(row);
}

export async function proposeResolution(sql:Sql,actor:Account,marketId:string,result:ResolutionResult,
  evidenceId:string,reason:string,now:Date,request:string) {
  const state=await book(sql,marketId),market=await getMarket(sql,marketId);
  requireCondition(state && market.published_at && state.status==='halted',409,'BOOK_NOT_CLOSED',
    'The published book must be closed before resolution.');
  requireCondition(actor.id!==market.creator_id,403,'SEPARATION_OF_DUTIES',
    'The market creator cannot propose its result.');
  requireCondition(now.getTime()>=Date.parse(market.terms.expected_event_at),409,'EVENT_NOT_OCCURRED',
    'The published event time has not arrived.');
  const deadline=new Date(now.getTime()+market.terms.resolution.challenge_window_seconds*1000);
  const timelock=new Date(deadline.getTime()+market.terms.resolution.timelock_seconds*1000);
  requireCondition(timelock.getTime()<=Date.parse(market.terms.resolution_deadline),409,'RESOLUTION_DEADLINE',
    'There is not enough time for the published challenge window and timelock.');
  const open=(await sql.query<{count:string}>(`SELECT count(*)::text AS count FROM clob_orders
    WHERE market_id=$1 AND state='open'`,[marketId])).rows[0]!;
  requireCondition(open.count==='0',409,'OPEN_ORDERS_REMAIN','Close all unmatched orders first.');
  const existing=(await sql.query<{market_id:string}>(`SELECT market_id FROM resolution_cases
    WHERE market_id=$1`,[marketId])).rows[0];
  requireCondition(!existing,409,'RESOLUTION_ALREADY_PROPOSED','This market already has a resolution case.');
  checkedResult(market,result);await checkedEvidence(sql,marketId,evidenceId,actor.id);
  const binding=await policy(sql,market,state.asset_code);
  const bond=await reserve(sql,{owner:actor.id,asset:state.asset_code,purpose:'resolution_bond',
    reference:`proposal:${marketId}`,amount:binding.bond_minor});
  const row=(await sql.query<CaseRow>(`INSERT INTO resolution_cases
    (market_id,proposed_by,proposal,proposal_evidence_id,proposal_bond_id,
      proposed_at,challenge_deadline,timelock_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[marketId,actor.id,JSON.stringify(result),
      evidenceId,bond.id,now,deadline,timelock])).rows[0]!;
  await marketEvent(sql,marketId,'resolution_proposed');
  await record(sql,{actor:actor.id,authority:'resolution_proposer',action:'resolution.proposed',
    resource:marketId,request,reason,evidence:evidenceId,after:{result,challenge_deadline:iso(deadline)}});
  return publicCase(row);
}

export async function challengeResolution(sql:Sql,actor:Account,marketId:string,result:ResolutionResult,
  evidenceId:string,reason:string,now:Date,request:string) {
  const state=await book(sql,marketId),row=await getCase(sql,marketId,true),market=await getMarket(sql,marketId);
  requireCondition(state?.status==='halted' && row.state==='proposed',409,'RESOLUTION_STATE_CONFLICT',
    'Only an unchallenged proposal may be challenged.');
  requireCondition(actor.id!==row.proposed_by,403,'SEPARATION_OF_DUTIES','A proposer cannot challenge their own result.');
  requireCondition(actor.id!==market.creator_id,403,'SEPARATION_OF_DUTIES',
    'The market creator cannot challenge its result.');
  requireCondition(now.getTime()<new Date(row.challenge_deadline).getTime(),409,'CHALLENGE_WINDOW_CLOSED',
    'The published challenge window has closed.');
  checkedResult(market,result);await checkedEvidence(sql,marketId,evidenceId,actor.id);
  requireCondition(hash(result)!==hash(row.proposal) || evidenceId!==row.proposal_evidence_id,422,
    'DUPLICATE_CHALLENGE','A challenge must provide a different result or evidence record.');
  const binding=await policy(sql,market,state.asset_code);
  const bond=await reserve(sql,{owner:actor.id,asset:state.asset_code,purpose:'resolution_bond',
    reference:`challenge:${marketId}`,amount:binding.bond_minor});
  const after=(await sql.query<CaseRow>(`UPDATE resolution_cases SET state='challenged',challenged_by=$2,
    challenge=$3,challenge_evidence_id=$4,challenge_bond_id=$5,challenged_at=$6,updated_at=now()
    WHERE market_id=$1 RETURNING *`,[marketId,actor.id,JSON.stringify(result),evidenceId,bond.id,now])).rows[0]!;
  await marketEvent(sql,marketId,'resolution_challenged');
  await record(sql,{actor:actor.id,authority:'resolution_proposer',action:'resolution.challenged',
    resource:marketId,request,reason,evidence:evidenceId,after:{result}});
  return publicCase(after);
}

export async function ballotResolution(sql:Sql,actor:Account,marketId:string,decision:'proposal'|'challenge'|'recuse',
  reason:string,evidenceId:string,now:Date,request:string) {
  const row=await getCase(sql,marketId,true),market=await getMarket(sql,marketId);
  requireCondition(row.state!=='finalized' && (decision!=='challenge' || row.state==='challenged'),409,
    'RESOLUTION_STATE_CONFLICT','A challenged candidate is required for that ballot.');
  requireCondition(row.state==='challenged' || now.getTime()>=new Date(row.challenge_deadline).getTime(),
    409,'CHALLENGE_WINDOW_OPEN','Unchallenged cases cannot be adjudicated before the challenge window closes.');
  requireCondition(![market.creator_id,row.proposed_by,row.challenged_by].includes(actor.id),403,
    'SEPARATION_OF_DUTIES','Creators and case participants cannot adjudicate this result.');
  const votes=(await sql.query<{reviewer_id:string}>(`SELECT reviewer_id FROM resolution_ballots
    WHERE market_id=$1`,[marketId])).rows;
  requireCondition(votes.length<market.terms.resolution.panel_size,409,'PANEL_COMPLETE','The adjudication panel is full.');
  requireCondition(!votes.some(v=>v.reviewer_id===actor.id),409,'BALLOT_ALREADY_RECORDED',
    'One immutable ballot is allowed per adjudicator.');
  await checkedEvidence(sql,marketId,evidenceId);
  const ballot=(await sql.query<{id:string;decision:string;created_at:Date}>(`INSERT INTO resolution_ballots
    (id,market_id,reviewer_id,decision,reason,evidence_id) VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id,decision,created_at`,[randomUUID(),marketId,actor.id,decision,reason,evidenceId])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'resolution_reviewer',action:'resolution.ballot_recorded',
    resource:marketId,request,reason,evidence:evidenceId,after:{decision}});
  return {id:ballot.id,market_id:marketId,decision,created_at:iso(ballot.created_at)};
}

export async function finalizeResolution(sql:Sql,actor:Account,marketId:string,reason:string,now:Date,request:string) {
  const state=await book(sql,marketId),row=await getCase(sql,marketId,true),market=await getMarket(sql,marketId);
  requireCondition(state?.status==='halted' && row.state!=='finalized',409,'RESOLUTION_STATE_CONFLICT',
    'Only a pending closed-book case can be finalized.');
  requireCondition(now.getTime()>=new Date(row.timelock_until).getTime() &&
    now.getTime()<=Date.parse(market.terms.resolution_deadline),409,'RESOLUTION_TIMELOCK',
    'Finalization requires the full challenge window and timelock before the resolution deadline.');
  requireCondition(![market.creator_id,row.proposed_by,row.challenged_by].includes(actor.id),403,
    'SEPARATION_OF_DUTIES','Case participants and the market creator cannot finalize.');
  const votes=(await sql.query<{reviewer_id:string;decision:string}>(`SELECT reviewer_id,decision
    FROM resolution_ballots WHERE market_id=$1`,[marketId])).rows;
  requireCondition(!votes.some(v=>v.reviewer_id===actor.id),403,'SEPARATION_OF_DUTIES',
    'An adjudicator cannot finalize their own panel.');
  requireCondition(votes.length===market.terms.resolution.panel_size,409,'PANEL_INCOMPLETE',
    'The published panel size must be filled, including recorded recusals.');
  const proposal=votes.filter(v=>v.decision==='proposal').length;
  const challenge=votes.filter(v=>v.decision==='challenge').length;
  const threshold=market.terms.resolution.adjudication_threshold;
  requireCondition((proposal>=threshold)!==(challenge>=threshold),409,'ADJUDICATION_QUORUM',
    'Exactly one candidate must meet the published adjudication threshold.');
  const selected=proposal>=threshold?row.proposal:row.challenge!;
  await policy(sql,market,state.asset_code);
  for(const reservationId of [row.proposal_bond_id,row.challenge_bond_id].filter((value):value is string=>!!value)){
    const bond=(await sql.query<{amount:string}>(`SELECT amount::text FROM collateral_reservations WHERE id=$1`,
      [reservationId])).rows[0]!;
    await markReleasePending(sql,reservationId);
    await releaseReservation(sql,reservationId,bond.amount,marketId);
  }
  const after=(await sql.query<CaseRow>(`UPDATE resolution_cases SET state='finalized',final_result=$2,
    final_result_hash=$3,finalized_by=$4,finalized_at=$5,updated_at=now()
    WHERE market_id=$1 RETURNING *`,[marketId,JSON.stringify(selected),hash(selected),actor.id,now])).rows[0]!;
  await marketEvent(sql,marketId,'resolution_finalized');
  await record(sql,{actor:actor.id,authority:'resolution_finalizer',action:'resolution.finalized',
    resource:marketId,request,reason,after:{result:selected,hash:after.final_result_hash,
      proposal_votes:proposal,challenge_votes:challenge}});
  return publicCase(after);
}

export async function redeemBatch(sql:Sql,actor:Account,marketId:string,request:string) {
  const state=await book(sql,marketId),row=await getCase(sql,marketId,true),market=await getMarket(sql,marketId);
  requireCondition(state && row.state==='finalized' && row.final_result,409,'RESOLUTION_NOT_FINAL',
    'Redemption requires an immutable finalized result.');
  await policy(sql,market,state.asset_code);
  const fills=(await sql.query<Fill>(`SELECT f.id,f.book_id,b.asset_code,b.contract_unit_minor::text,f.outcome_id,f.quantity::text,f.buyer_collateral::text,
    f.seller_collateral::text,m.owner_id AS maker_owner,t.owner_id AS taker_owner,
    m.side AS maker_side,t.side AS taker_side FROM clob_fills f
    JOIN clob_markets b ON b.id=f.book_id
    JOIN clob_orders m ON m.id=f.maker_order_id JOIN clob_orders t ON t.id=f.taker_order_id
    WHERE f.market_id=$1 AND NOT EXISTS (SELECT 1 FROM resolution_redemptions r WHERE r.fill_id=f.id)
    ORDER BY f.sequence LIMIT 100`,[marketId])).rows;
  const ammFills=(await sql.query<AmmFill>(`SELECT q.id,p.asset_code,p.contract_unit_minor::text,q.owner_id,q.outcome_id,q.side,q.quantity::text,
    (CASE WHEN q.side='buy' THEN q.user_collateral ELSE q.amm_collateral END)::text AS buyer_collateral,
    (CASE WHEN q.side='sell' THEN q.user_collateral ELSE q.amm_collateral END)::text AS seller_collateral
    FROM amm_quotes q JOIN amm_pools p ON p.market_id=q.market_id AND p.outcome_id=q.outcome_id AND p.asset_code=q.asset_code
    WHERE q.market_id=$1 AND q.state='executed' AND NOT EXISTS
      (SELECT 1 FROM amm_redemptions r WHERE r.quote_id=q.id)
    ORDER BY q.executed_at,q.id LIMIT $2`,[marketId,Math.max(0,100-fills.length)])).rows;
  const rfqFills=(await sql.query<RfqFill>(`SELECT f.id,f.asset_code,m.contract_unit_minor::text,f.outcome_id,f.quantity::text,f.buyer_collateral::text,
    f.seller_collateral::text,f.requester_owner_id,f.dealer_owner_id,f.requester_side FROM rfq_fills f
    JOIN clob_markets m ON m.market_id=f.market_id AND m.asset_code=f.asset_code
    WHERE f.market_id=$1 AND NOT EXISTS (SELECT 1 FROM rfq_redemptions r WHERE r.fill_id=f.id)
    ORDER BY f.sequence LIMIT $2`,[marketId,Math.max(0,100-fills.length-ammFills.length)])).rows;
  for(const asset of new Set([...fills,...ammFills,...rfqFills].map(fill=>fill.asset_code)))await policy(sql,market,asset);
  const totals=new Map<string,bigint>();
  const add=(asset:string,amount:bigint)=>totals.set(asset,(totals.get(asset)??0n)+amount);
  const accounts=async(asset:string)=>{
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`market_escrow:${asset}`]);
    return {escrow:await ledgerAccount(sql,null,asset,'market_escrow'),
      treasury:await ledgerAccount(sql,null,asset,'liquidity_reserve')};
  };
  for(const fill of fills){
    const asset=fill.asset_code,{escrow}=await accounts(asset);
    const buyerId=fill.maker_side==='buy'?fill.maker_owner:fill.taker_owner;
    const sellerId=fill.maker_side==='sell'?fill.maker_owner:fill.taker_owner;
    for(const owner of [buyerId,sellerId].sort())await lockOwnerAsset(sql,owner,asset);
    const payout=payoutForFill(market.terms,row.final_result,fill,BigInt(fill.contract_unit_minor));
    const buyer=await ledgerAccount(sql,buyerId,asset,'user_available');
    const seller=await ledgerAccount(sql,sellerId,asset,'user_available');
    const journal=await postJournal(sql,{effectId:`resolution:${marketId}:fill:${fill.id}`,
      asset,kind:'resolution_redemption',referenceId:fill.id,
      reason:'Finalized outcome payout from matched market collateral',lines:[
        {account:escrow,debit:payout.total,credit:0n},
        ...(payout.buyer>0n?[{account:buyer,debit:0n,credit:payout.buyer}]:[]),
        ...(payout.seller>0n?[{account:seller,debit:0n,credit:payout.seller}]:[]),
      ]});
    await sql.query(`INSERT INTO resolution_redemptions
      (fill_id,market_id,buyer_minor,seller_minor,journal_id) VALUES ($1,$2,$3,$4,$5)`,
      [fill.id,marketId,payout.buyer.toString(),payout.seller.toString(),journal]);
    add(asset,payout.total);
  }
  for(const fill of ammFills){
    const asset=fill.asset_code,{escrow,treasury}=await accounts(asset);
    await lockOwnerAsset(sql,fill.owner_id,asset);
    const payout=payoutForFill(market.terms,row.final_result,fill,BigInt(fill.contract_unit_minor));
    const userPayout=fill.side==='buy'?payout.buyer:payout.seller;
    const treasuryPayout=fill.side==='buy'?payout.seller:payout.buyer;
    const owner=await ledgerAccount(sql,fill.owner_id,asset,'user_available');
    const journal=await postJournal(sql,{effectId:`resolution:${marketId}:amm:${fill.id}`,
      asset,kind:'resolution_redemption',referenceId:fill.id,
      reason:'Finalized outcome payout from AMM market collateral',lines:[
        {account:escrow,debit:payout.total,credit:0n},
        ...(userPayout>0n?[{account:owner,debit:0n,credit:userPayout}]:[]),
        ...(treasuryPayout>0n?[{account:treasury,debit:0n,credit:treasuryPayout}]:[]),
      ]});
    await sql.query(`INSERT INTO amm_redemptions
      (quote_id,market_id,owner_id,user_minor,treasury_minor,journal_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [fill.id,marketId,fill.owner_id,userPayout.toString(),treasuryPayout.toString(),journal]);
    add(asset,payout.total);
  }
  for(const fill of rfqFills){
    const asset=fill.asset_code,{escrow}=await accounts(asset);
    const buyerId=fill.requester_side==='buy'?fill.requester_owner_id:fill.dealer_owner_id;
    const sellerId=fill.requester_side==='sell'?fill.requester_owner_id:fill.dealer_owner_id;
    for(const ownerId of [buyerId,sellerId].sort())await lockOwnerAsset(sql,ownerId,asset);
    const payout=payoutForFill(market.terms,row.final_result,fill,BigInt(fill.contract_unit_minor));
    const buyer=await ledgerAccount(sql,buyerId,asset,'user_available');
    const seller=await ledgerAccount(sql,sellerId,asset,'user_available');
    const journal=await postJournal(sql,{effectId:`resolution:${marketId}:rfq:${fill.id}`,
      asset,kind:'resolution_redemption',referenceId:fill.id,
      reason:'Finalized outcome payout from institutional RFQ collateral',lines:[
        {account:escrow,debit:payout.total,credit:0n},
        ...(payout.buyer>0n?[{account:buyer,debit:0n,credit:payout.buyer}]:[]),
        ...(payout.seller>0n?[{account:seller,debit:0n,credit:payout.seller}]:[]),
      ]});
    await sql.query(`INSERT INTO rfq_redemptions(fill_id,market_id,buyer_minor,seller_minor,journal_id)
      VALUES($1,$2,$3,$4,$5)`,[fill.id,marketId,payout.buyer.toString(),payout.seller.toString(),journal]);
    add(asset,payout.total);
  }
  if(fills.length||ammFills.length||rfqFills.length)await marketEvent(sql,marketId,'redemption_batch');
  const remaining=(await sql.query<{count:string}>(`SELECT
    ((SELECT count(*) FROM clob_fills f WHERE f.market_id=$1 AND NOT EXISTS
      (SELECT 1 FROM resolution_redemptions r WHERE r.fill_id=f.id))+
     (SELECT count(*) FROM amm_quotes q WHERE q.market_id=$1 AND q.state='executed' AND NOT EXISTS
      (SELECT 1 FROM amm_redemptions r WHERE r.quote_id=q.id))+
     (SELECT count(*) FROM rfq_fills f WHERE f.market_id=$1 AND NOT EXISTS
      (SELECT 1 FROM rfq_redemptions r WHERE r.fill_id=f.id)))::text AS count`,
    [marketId])).rows[0]!;
  await record(sql,{actor:actor.id,authority:'finance_operator',action:'resolution.redemption_batch',
    resource:marketId,request,reason:'Settle finalized synthetic claims exactly once',
    after:{fill_count:fills.length+ammFills.length+rfqFills.length,
      paid_by_asset:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([asset_code,amount])=>({asset_code,amount_minor:amount.toString()})),
      remaining:remaining.count}});
  return {market_id:marketId,fill_count:fills.length+ammFills.length+rfqFills.length,
    paid_by_asset:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([asset_code,amount])=>({asset_code,amount_minor:amount.toString()})),
    remaining:remaining.count};
}

export async function getResolution(sql:Sql,marketId:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.published_at,404,'NOT_FOUND','Published market not found.');
  const row=(await sql.query<CaseRow>('SELECT * FROM resolution_cases WHERE market_id=$1',[marketId])).rows[0];
  return row?publicCase(row):null;
}
export async function listResolutionEvidence(sql:Sql,marketId:string) {
  const market=await getMarket(sql,marketId);
  requireCondition(market.published_at,404,'NOT_FOUND','Published market not found.');
  return {items:(await sql.query<EvidenceRow>(`SELECT * FROM resolution_evidence WHERE market_id=$1
    ORDER BY created_at,id LIMIT 100`,[marketId])).rows.map(publicEvidence)};
}
export async function listMyRedemptions(sql:Sql,marketId:string,ownerId:string) {
  const rows=(await sql.query<{fill_id:string;amount_minor:string;created_at:Date}>(`SELECT r.fill_id,
    (CASE WHEN m.owner_id=$2 THEN CASE WHEN m.side='buy' THEN r.buyer_minor ELSE r.seller_minor END
      ELSE CASE WHEN t.side='buy' THEN r.buyer_minor ELSE r.seller_minor END END)::text AS amount_minor,
    r.created_at FROM resolution_redemptions r JOIN clob_fills f ON f.id=r.fill_id
    JOIN clob_orders m ON m.id=f.maker_order_id JOIN clob_orders t ON t.id=f.taker_order_id
    WHERE r.market_id=$1 AND (m.owner_id=$2 OR t.owner_id=$2)
    UNION ALL
    SELECT r.quote_id AS fill_id,r.user_minor::text AS amount_minor,r.created_at
    FROM amm_redemptions r WHERE r.market_id=$1 AND r.owner_id=$2
    UNION ALL
    SELECT r.fill_id,(CASE WHEN (f.requester_owner_id=$2 AND f.requester_side='buy') OR
      (f.dealer_owner_id=$2 AND f.requester_side='sell') THEN r.buyer_minor ELSE r.seller_minor END)::text,
      r.created_at FROM rfq_redemptions r JOIN rfq_fills f ON f.id=r.fill_id
    WHERE r.market_id=$1 AND (f.requester_owner_id=$2 OR f.dealer_owner_id=$2)
    ORDER BY created_at,fill_id LIMIT 100`,[marketId,ownerId])).rows;
  return {items:rows.map(r=>({fill_id:r.fill_id,amount_minor:r.amount_minor,created_at:iso(r.created_at)}))};
}
