import {randomUUID} from 'node:crypto';
import type {Address,Hex} from 'viem';
import type {Sql} from '../platform/database.js';
import {requireCondition} from '../platform/errors.js';
import {record} from '../platform/commands.js';
import type {Account} from '../identity/auth.js';
import {buildSettlementManifest,settlementKey} from './model.js';

interface Binding {asset_code:string;chain_id:string;contract_address:Address;collateral_token_address:Address;
  contract_code_hash:Hex;finality_policy_ref:string;confirmations:number;observer_quorum:number;approved:boolean}
interface BatchRow {id:string;market_id:string;asset_code:string;chain_id:string;contract_address:Address;
  resolution_hash:string;merkle_root:Hex;manifest_hash:string;calldata:Hex;calldata_hash:Hex;item_count:number;
  total_minor:string;state:'prepared'|'submitted'|'confirmed'|'finalized'|'exception';current_submission_id:string|null;
  created_at:Date;updated_at:Date}
interface SubmissionRow {id:string;attempt:number;state:string;transaction_hash:Hex|null;transaction_nonce:string|null;submitted_at:Date}
export interface SettlementObservation {transactionHash:Hex;blockNumber:bigint;blockHash:Hex;headNumber:bigint;
  contractAddress:Address;calldataHash:Hex;receiptSuccess:boolean;contractCodeHash:Hex}
export interface SettlementObserver {id:string;observe(chainId:number,transactionHash:Hex):Promise<SettlementObservation|null>}
export interface SettlementSubmitter {submit(input:{requestId:string;chainId:number;contract:Address;calldata:Hex}):Promise<
  {state:'submitted';transactionHash:Hex;nonce:bigint}|{state:'uncertain'}>;
  lookup?(requestId:string):Promise<{transactionHash:Hex;nonce:bigint}|null>}
export interface SettlementDependencies {submitter:SettlementSubmitter;observers:SettlementObserver[]}

const iso=(value:Date)=>new Date(value).toISOString();
async function binding(sql:Sql,asset:string){
  const row=(await sql.query<Binding>(`SELECT b.* FROM chain_settlement_bindings b JOIN policy_registry p
    ON p.kind='finality' AND p.policy_ref=b.finality_policy_ref AND p.approved=true WHERE b.asset_code=$1`,[asset])).rows[0];
  requireCondition(row?.approved,409,'SETTLEMENT_NOT_APPROVED','No approved chain settlement binding exists for this asset.');
  requireCondition(String(row.chain_id)==='46630',409,'MAINNET_SETTLEMENT_DISABLED','Only Robinhood Chain testnet is enabled in this release.');
  return row;
}
async function batch(sql:Sql,id:string,lock=false){
  const row=(await sql.query<BatchRow>(`SELECT * FROM settlement_batches WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Settlement batch not found.');return row;
}
async function submission(sql:Sql,id:string|null){
  return id?(await sql.query<SubmissionRow>('SELECT * FROM settlement_submissions WHERE id=$1',[id])).rows[0]??null:null;
}
async function publicBatch(sql:Sql,row:BatchRow){
  const current=await submission(sql,row.current_submission_id);
  return {id:row.id,batch_key:settlementKey(row.id),market_id:row.market_id,asset:row.asset_code,chain_id:String(row.chain_id),
    contract_address:row.contract_address,resolution_hash:row.resolution_hash,merkle_root:row.merkle_root,
    manifest_hash:row.manifest_hash,item_count:row.item_count,total_minor:row.total_minor,state:row.state,
    submission:current?{id:current.id,attempt:current.attempt,state:current.state,
      transaction_hash:current.transaction_hash,transaction_nonce:current.transaction_nonce,
      submitted_at:iso(current.submitted_at)}:null,created_at:iso(row.created_at),updated_at:iso(row.updated_at)};
}

export async function prepareSettlementBatch(sql:Sql,actor:Account,marketId:string,request:string,assetCode?:string){
  const books=(await sql.query<{asset_code:string}>(`SELECT asset_code FROM clob_markets WHERE market_id=$1
    ${assetCode?'AND asset_code=$2':''} ORDER BY asset_code`,assetCode?[marketId,assetCode]:[marketId])).rows;
  requireCondition(assetCode||books.length===1,422,'ASSET_REQUIRED','Choose NGN or USDT_BSC for this settlement batch.');
  const state=books[0];
  requireCondition(state,404,'NOT_FOUND','Trading market not found.');
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`settlement:${marketId}:${state.asset_code}`]);
  const resolution=(await sql.query<{final_result_hash:string;state:string}>(
    'SELECT final_result_hash,state FROM resolution_cases WHERE market_id=$1 FOR SHARE',[marketId])).rows[0];
  requireCondition(resolution?.state==='finalized'&&resolution.final_result_hash,409,'RESOLUTION_NOT_FINAL',
    'Chain settlement requires the immutable finalized result.');
  const configured=await binding(sql,state.asset_code);
  const payouts=(await sql.query<{fill_id:string;payout_side:'buyer'|'seller';owner_id:string;
    recipient_address:Address|null;account_status:string|null;amount_minor:string}>(`WITH payout AS (
      SELECT r.fill_id,'buyer'::text AS payout_side,
        CASE WHEN m.side='buy' THEN m.owner_id ELSE t.owner_id END AS owner_id,r.buyer_minor AS amount_minor
      FROM resolution_redemptions r JOIN clob_fills f ON f.id=r.fill_id
      JOIN clob_markets b ON b.id=f.book_id
      JOIN clob_orders m ON m.id=f.maker_order_id JOIN clob_orders t ON t.id=f.taker_order_id
      WHERE r.market_id=$1 AND b.asset_code=$3
      UNION ALL
      SELECT r.fill_id,'seller'::text,
        CASE WHEN m.side='sell' THEN m.owner_id ELSE t.owner_id END,r.seller_minor
      FROM resolution_redemptions r JOIN clob_fills f ON f.id=r.fill_id
      JOIN clob_markets b ON b.id=f.book_id
      JOIN clob_orders m ON m.id=f.maker_order_id JOIN clob_orders t ON t.id=f.taker_order_id
      WHERE r.market_id=$1 AND b.asset_code=$3
      UNION ALL
      SELECT r.quote_id,(CASE WHEN q.side='buy' THEN 'buyer' ELSE 'seller' END),r.owner_id,r.user_minor
      FROM amm_redemptions r JOIN amm_quotes q ON q.id=r.quote_id WHERE r.market_id=$1 AND q.asset_code=$3
      UNION ALL
      SELECT r.fill_id,'buyer',CASE WHEN f.requester_side='buy' THEN f.requester_owner_id ELSE f.dealer_owner_id END,
        r.buyer_minor FROM rfq_redemptions r JOIN rfq_fills f ON f.id=r.fill_id
        WHERE r.market_id=$1 AND f.asset_code=$3
      UNION ALL
      SELECT r.fill_id,'seller',CASE WHEN f.requester_side='sell' THEN f.requester_owner_id ELSE f.dealer_owner_id END,
        r.seller_minor FROM rfq_redemptions r JOIN rfq_fills f ON f.id=r.fill_id
        WHERE r.market_id=$1 AND f.asset_code=$3)
    SELECT p.fill_id,p.payout_side,p.owner_id,s.address AS recipient_address,s.status AS account_status,p.amount_minor::text
    FROM payout p LEFT JOIN smart_accounts s ON s.owner_id=p.owner_id AND s.chain_id=$2
    WHERE p.amount_minor>0 AND NOT EXISTS (SELECT 1 FROM settlement_batch_items i
      WHERE i.fill_id=p.fill_id AND i.payout_side=p.payout_side)
    ORDER BY p.fill_id,p.payout_side LIMIT 100`,[marketId,configured.chain_id,state.asset_code])).rows;
  requireCondition(payouts.length>0,409,'NO_SETTLEMENT_PAYOUTS','No positive unbatched payouts remain.');
  requireCondition(payouts.every(p=>p.recipient_address&&p.account_status==='active'),409,'SMART_ACCOUNT_NOT_READY',
    'Every payout owner must have an active smart account on the configured settlement chain.');
  const id=randomUUID();
  const manifest=buildSettlementManifest(id,marketId,resolution.final_result_hash,payouts.map(p=>({fillId:p.fill_id,
    side:p.payout_side,ownerId:p.owner_id,recipient:p.recipient_address!,amount:BigInt(p.amount_minor)})));
  await sql.query(`INSERT INTO settlement_batches(id,market_id,asset_code,chain_id,contract_address,resolution_hash,
    merkle_root,manifest_hash,calldata,calldata_hash,item_count,total_minor,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,marketId,state.asset_code,configured.chain_id,
    configured.contract_address,resolution.final_result_hash,manifest.merkleRoot,manifest.manifestHash,manifest.calldata,
    manifest.calldataHash,manifest.items.length,manifest.total.toString(),actor.id]);
  for(const item of manifest.items)await sql.query(`INSERT INTO settlement_batch_items
    (batch_id,item_index,fill_id,payout_side,owner_id,recipient_address,amount_minor,leaf_hash,merkle_proof)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,item.index,item.fillId,item.side,item.ownerId,item.recipient,
    item.amount.toString(),item.leafHash,JSON.stringify(item.proof)]);
  const row=await batch(sql,id);
  await record(sql,{actor:actor.id,authority:'finance_operator',action:'settlement.batch_prepared',resource:id,
    request,reason:'Bind finalized payouts to an exact Robinhood Chain claim manifest',after:{market_id:marketId,
      manifest_hash:manifest.manifestHash,item_count:manifest.items.length,total_minor:manifest.total.toString()}});
  return publicBatch(sql,row);
}

export async function submitSettlementBatch(sql:Sql,actor:Account,id:string,request:string,deps:SettlementDependencies){
  const row=await batch(sql,id,true),configured=await binding(sql,row.asset_code);
  requireCondition(deps.observers.length>=configured.observer_quorum,503,'CHAIN_OBSERVER_QUORUM_UNAVAILABLE',
    'The configured independent RPC observer quorum is unavailable.');
  const current=await submission(sql,row.current_submission_id);
  requireCondition(!current||['reverted','reorged'].includes(current.state),409,'SETTLEMENT_ALREADY_SUBMITTED',
    'The current chain submission is active, uncertain, or already final. Reconcile an uncertain signer request before replacement.');
  if(current)await sql.query("UPDATE settlement_submissions SET state='replaced',updated_at=now() WHERE id=$1",[current.id]);
  const attempt=(await sql.query<{attempt:number}>('SELECT COALESCE(max(attempt),0)+1 AS attempt FROM settlement_submissions WHERE batch_id=$1',[id])).rows[0]!.attempt;
  const signerRequest=`settlement:${id}:${attempt}`;
  let result:{state:'submitted';transactionHash:Hex;nonce:bigint}|{state:'uncertain'};
  try{result=await deps.submitter.submit({requestId:signerRequest,chainId:Number(row.chain_id),
    contract:row.contract_address,calldata:row.calldata});}catch{result={state:'uncertain'};}
  const submissionId=randomUUID();
  await sql.query(`INSERT INTO settlement_submissions(id,batch_id,attempt,signer_request_id,transaction_hash,
    transaction_nonce,state) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[submissionId,id,attempt,signerRequest,
    result.state==='submitted'?result.transactionHash:null,result.state==='submitted'?result.nonce.toString():null,result.state]);
  await sql.query(`UPDATE settlement_batches SET state='submitted',current_submission_id=$2,updated_at=now() WHERE id=$1`,[id,submissionId]);
  await record(sql,{actor:actor.id,authority:'finance_operator',action:'settlement.submission_recorded',resource:id,
    request,reason:'Submit exact approved settlement calldata through the configured signer',after:{attempt,state:result.state,
      transaction_hash:result.state==='submitted'?result.transactionHash:null}});
  return publicBatch(sql,await batch(sql,id));
}

export async function refreshSettlementBatch(sql:Sql,actor:Account,id:string,request:string,deps:SettlementDependencies){
  const row=await batch(sql,id,true),configured=await binding(sql,row.asset_code);
  let current=await submission(sql,row.current_submission_id);
  requireCondition(current,409,'SETTLEMENT_NOT_OBSERVABLE','The batch has no chain submission.');
  if(current.state==='uncertain'&&!current.transaction_hash&&deps.submitter.lookup){
    const recovered=await deps.submitter.lookup(`settlement:${id}:${current.attempt}`);
    if(recovered){
      await sql.query(`UPDATE settlement_submissions SET transaction_hash=$2,transaction_nonce=$3,state='submitted',
        updated_at=now() WHERE id=$1`,[current.id,recovered.transactionHash,recovered.nonce.toString()]);
      current=await submission(sql,current.id);
    }
  }
  requireCondition(current?.transaction_hash,409,'SETTLEMENT_NOT_OBSERVABLE',
    'The signer request remains uncertain. Reconcile it before creating a replacement.');
  requireCondition(!['reverted','replaced','reorged'].includes(current.state),409,'SETTLEMENT_ATTEMPT_TERMINAL',
    'A reverted or reorged attempt must be replaced before refresh.');
  const unique=new Set(deps.observers.map(o=>o.id));
  requireCondition(unique.size===deps.observers.length&&unique.size>=configured.observer_quorum,503,
    'CHAIN_OBSERVER_QUORUM_UNAVAILABLE','Independent RPC observer identities are required.');
  const results=await Promise.all(deps.observers.map(async observer=>({observer,result:await observer.observe(Number(row.chain_id),current.transaction_hash!)})));
  for(const {observer,result} of results){
    if(!result)continue;
    requireCondition(result.transactionHash===current.transaction_hash,502,'CHAIN_OBSERVATION_INVALID','Observer returned a different transaction.');
    await sql.query(`INSERT INTO settlement_observations(id,submission_id,observer_id,transaction_hash,block_number,
      block_hash,head_number,contract_address,calldata_hash,receipt_success) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING`,[randomUUID(),current.id,observer.id,result.transactionHash,result.blockNumber.toString(),
      result.blockHash,result.headNumber.toString(),result.contractAddress,result.calldataHash,result.receiptSuccess]);
  }
  const observations=results.flatMap(({observer,result})=>result?[{observer:observer.id,...result}]:[]);
  const exact=observations.filter(o=>o.receiptSuccess&&o.contractAddress===row.contract_address&&
    o.calldataHash===row.calldata_hash&&o.contractCodeHash===configured.contract_code_hash);
  const groups=new Map<string,typeof exact>();
  for(const observation of exact){const key=`${observation.blockNumber}:${observation.blockHash}`;
    groups.set(key,[...(groups.get(key)??[]),observation]);}
  const agreed=[...groups.values()].sort((a,b)=>b.length-a.length)[0]??[];
  const conflict=observations.length>=configured.observer_quorum&&agreed.length<configured.observer_quorum;
  if(conflict){
    await sql.query("UPDATE settlement_submissions SET state='reorged',updated_at=now() WHERE id=$1",[current.id]);
    await sql.query("UPDATE settlement_batches SET state='exception',updated_at=now() WHERE id=$1",[id]);
  }else if(observations.some(o=>!o.receiptSuccess)){
    await sql.query("UPDATE settlement_submissions SET state='reverted',updated_at=now() WHERE id=$1",[current.id]);
    await sql.query("UPDATE settlement_batches SET state='exception',updated_at=now() WHERE id=$1",[id]);
  }else if(agreed.length>=configured.observer_quorum){
    const confirmations=agreed.reduce((min,o)=>o.headNumber-o.blockNumber+1n<min?o.headNumber-o.blockNumber+1n:min,
      agreed[0]!.headNumber-agreed[0]!.blockNumber+1n);
    const final=confirmations>=BigInt(configured.confirmations);
    if(row.state==='finalized'&&!final){
      await sql.query("UPDATE settlement_submissions SET state='reorged',updated_at=now() WHERE id=$1",[current.id]);
      await sql.query("UPDATE settlement_batches SET state='exception',updated_at=now() WHERE id=$1",[id]);
    }else{
      await sql.query(`UPDATE settlement_submissions SET state=$2,updated_at=now() WHERE id=$1`,[current.id,final?'finalized':'confirmed']);
      await sql.query(`UPDATE settlement_batches SET state=$2,updated_at=now() WHERE id=$1`,[id,final?'finalized':'confirmed']);
    }
  }
  const updated=await batch(sql,id),latest=await submission(sql,updated.current_submission_id);
  const matching=agreed.length>=configured.observer_quorum?agreed:[];
  const confirmations=matching.length?matching.reduce((min,o)=>{
    const count=o.headNumber-o.blockNumber+1n;return count<min?count:min;},matching[0]!.headNumber-matching[0]!.blockNumber+1n):0n;
  await record(sql,{actor:actor.id,authority:'finance_operator',action:'settlement.observations_refreshed',resource:id,
    request,reason:'Verify transaction, contract code and finality through independent RPC providers',after:{
      state:updated.state,submission_state:latest?.state,observer_count:agreed.length,confirmations:confirmations.toString()}});
  return {batch:await publicBatch(sql,updated),observer_count:agreed.length,confirmations:confirmations.toString(),
    required_confirmations:String(configured.confirmations),required_quorum:configured.observer_quorum};
}

export async function getSettlementBatch(sql:Sql,id:string){return publicBatch(sql,await batch(sql,id));}
export async function listMySettlementClaims(sql:Sql,ownerId:string,marketId:string){
  const rows=(await sql.query<{batch_id:string;item_index:number;market_id:string;asset_code:string;chain_id:string;
    contract_address:Address;recipient_address:Address;amount_minor:string;leaf_hash:Hex;merkle_root:Hex;
    merkle_proof:Hex[];state:BatchRow['state']}>(`SELECT i.batch_id,i.item_index,b.market_id,b.asset_code,b.chain_id::text,
      b.contract_address,i.recipient_address,i.amount_minor::text,i.leaf_hash,b.merkle_root,i.merkle_proof,b.state
    FROM settlement_batch_items i JOIN settlement_batches b ON b.id=i.batch_id
    WHERE i.owner_id=$1 AND b.market_id=$2 ORDER BY b.created_at,i.item_index LIMIT 100`,[ownerId,marketId])).rows;
  return {items:rows.map(row=>({batch_id:row.batch_id,batch_key:settlementKey(row.batch_id),item_index:row.item_index,market_id:row.market_id,
    asset:row.asset_code,chain_id:row.chain_id,contract_address:row.contract_address,
    recipient_address:row.recipient_address,amount_minor:row.amount_minor,leaf_hash:row.leaf_hash,
    merkle_root:row.merkle_root,proof:row.merkle_proof,batch_state:row.state,claim_ready:row.state==='finalized'}))};
}
