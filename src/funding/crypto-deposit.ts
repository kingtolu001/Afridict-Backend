import {randomUUID} from 'node:crypto';
import type {Database,Sql} from '../platform/database.js';
import {command,record} from '../platform/commands.js';
import {requireCondition} from '../platform/errors.js';
import {ledgerAccount,lockOwnerAsset,postJournal} from '../financial/ledger.js';

interface AddressRow {id:string;owner_id:string;asset_code:string;chain_id:string;address:string;custody_reference:string;
  state:'active'|'retired'|'exception';created_at:Date;updated_at:Date}
interface DepositRow {id:string;address_id:string;owner_id:string;asset_code:string;chain_id:string;contract_address:string;
  transaction_hash:string;log_index:number;block_number:string;block_hash:string;amount_minor:string;confirmations:number;
  finality_policy_ref:string;state:'confirming'|'finalized'|'reverted'|'exception';journal_id:string|null;observed_at:Date;
  updated_at:Date;finalized_at:Date|null;reverted_at:Date|null}
interface TokenRow {asset_code:string;chain_id:string;contract_address:string;decimals:number}

export interface VerifiedTokenTransfer {
  state:'confirming'|'finalized'|'reverted';chainId:string;contractAddress:string;recipient:string;amountMinor:string;
  transactionHash:string;logIndex:number;blockNumber:string;blockHash:string;confirmations:number;finalityPolicyRef:string;
}
export interface MissingTokenTransfer {
  state:'missing';chainId:string;transactionHash:string;logIndex:number;finalityPolicyRef:string;
}
export interface CryptoDepositObserver {
  observe(input:{chainId:string;contractAddress:string;transactionHash:string;logIndex:number}):Promise<VerifiedTokenTransfer|MissingTokenTransfer>;
}

const addressPattern=/^0x[a-fA-F0-9]{40}$/;
const transactionPattern=/^0x[a-fA-F0-9]{64}$/;
const publicAddress=(row:AddressRow)=>({id:row.id,asset:row.asset_code,chain_id:row.chain_id,address:row.address,
  state:row.state,created_at:new Date(row.created_at).toISOString()});
const publicDeposit=(row:DepositRow)=>({id:row.id,asset:row.asset_code,chain_id:row.chain_id,
  transaction_hash:row.transaction_hash,log_index:row.log_index,amount_minor:row.amount_minor,confirmations:row.confirmations,
  finality_policy_ref:row.finality_policy_ref,state:row.state,observed_at:new Date(row.observed_at).toISOString(),
  updated_at:new Date(row.updated_at).toISOString(),finalized_at:row.finalized_at?new Date(row.finalized_at).toISOString():null});

export async function provisionCryptoDepositAddress(sql:Sql,admin:string,input:{owner:string;asset:string;chainId:string;
  address:string;custodyReference:string;evidenceRef:string;reason:string},requestId:string){
  const normalized=input.address.toLowerCase();
  requireCondition(addressPattern.test(normalized)&&!/^0x0{40}$/.test(normalized),422,'INVALID_WALLET_ADDRESS',
    'A non-zero EVM deposit address is required.');
  const token=(await sql.query<TokenRow>(`SELECT t.asset_code,t.chain_id::text,t.contract_address,t.decimals
    FROM token_asset_registry t JOIN financial_assets a ON a.code=t.asset_code
    WHERE t.asset_code=$1 AND t.approved=true AND a.approved=true FOR SHARE`,[input.asset])).rows[0];
  requireCondition(token&&token.asset_code==='USDT_BSC'&&token.chain_id===input.chainId,422,'TOKEN_NOT_APPROVED',
    'The exact USDT-BSC token and network must be approved.');
  const owner=(await sql.query<{status:string}>('SELECT status FROM accounts WHERE id=$1 FOR SHARE',[input.owner])).rows[0];
  requireCondition(owner?.status==='active',409,'ACCOUNT_RESTRICTED','The deposit address owner must be an active account.');
  const existing=(await sql.query<AddressRow>(`SELECT * FROM crypto_deposit_addresses
    WHERE owner_id=$1 AND asset_code=$2 AND state='active' FOR UPDATE`,[input.owner,input.asset])).rows[0];
  requireCondition(!existing,409,'DEPOSIT_ADDRESS_ALREADY_ACTIVE','This account already has an active deposit address for the asset.');
  const row=(await sql.query<AddressRow>(`INSERT INTO crypto_deposit_addresses
    (id,owner_id,asset_code,chain_id,address,custody_reference,evidence_ref,provisioned_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),input.owner,input.asset,input.chainId,normalized,
    input.custodyReference,input.evidenceRef,admin])).rows[0]!;
  await record(sql,{actor:admin,authority:'finance_operator',action:'crypto_deposit_address.provisioned',resource:row.id,
    request:requestId,reason:input.reason,evidence:input.evidenceRef,
    after:{owner_id:input.owner,asset:input.asset,chain_id:input.chainId,address:normalized}});
  return publicAddress(row);
}

export async function listCryptoDepositAddresses(sql:Sql,owner:string){
  const rows=(await sql.query<AddressRow>(`SELECT * FROM crypto_deposit_addresses WHERE owner_id=$1
    ORDER BY created_at DESC`,[owner])).rows;return rows.map(publicAddress);
}

async function token(sql:Sql,asset:string){
  const row=(await sql.query<TokenRow>(`SELECT asset_code,chain_id::text,contract_address,decimals
    FROM token_asset_registry WHERE asset_code=$1`,[asset])).rows[0];
  requireCondition(row&&row.asset_code==='USDT_BSC',422,'TOKEN_NOT_REGISTERED','The exact USDT-BSC token is not registered.');
  return row;
}

async function authorizeDepositOwner(sql:Sql,owner:string){
  const row=(await sql.query<{status:string;eligibility_status:string|null;identity_status:string|null}>(`SELECT a.status,
    e.status AS eligibility_status,s.identity_status FROM accounts a LEFT JOIN eligibility e ON e.account_id=a.id
    LEFT JOIN account_assurance s ON s.account_id=a.id WHERE a.id=$1 FOR SHARE OF a`,[owner])).rows[0];
  requireCondition(row?.status==='active',403,'ACCOUNT_RESTRICTED','This account cannot receive a deposit.');
  requireCondition(row.eligibility_status==='eligible'&&row.identity_status==='VERIFIED',403,'FUNDING_ELIGIBILITY_REQUIRED',
    'Verified identity and approved funding eligibility are required.');
}

export async function observeCryptoDeposit(db:Database,observer:CryptoDepositObserver,owner:string,input:{asset:string;
  transactionHash:string;logIndex:number},idempotencyKey:string,requestId:string){
  requireCondition(transactionPattern.test(input.transactionHash),422,'INVALID_TRANSACTION_HASH','A 32-byte transaction hash is required.');
  const registered=await token(db,input.asset),transactionHash=input.transactionHash.toLowerCase();
  const observed=await observer.observe({chainId:registered.chain_id,contractAddress:registered.contract_address,
    transactionHash,logIndex:input.logIndex});
  requireCondition(observed.chainId===registered.chain_id&&observed.transactionHash.toLowerCase()===transactionHash&&
    observed.logIndex===input.logIndex,502,
    'CHAIN_OBSERVATION_MISMATCH','The chain observer returned a different transfer identity.');
  if(observed.state==='missing'){
    const result=await command(db,owner,idempotencyKey,{operation:'observe_crypto_deposit',...input},
      sql=>authorizeDepositOwner(sql,owner),async sql=>{
    const row=(await sql.query<DepositRow>(`SELECT * FROM crypto_deposit_observations WHERE owner_id=$1 AND chain_id=$2
      AND transaction_hash=$3 AND log_index=$4 FOR UPDATE`,[owner,registered.chain_id,transactionHash,input.logIndex])).rows[0];
    requireCondition(row,404,'CHAIN_TRANSFER_NOT_FOUND','The transfer log is not available from the independent chain observer.');
    if(row.state==='finalized')await openFinalityException(sql,row,requestId,'Finalized transfer is no longer present at the observer');
    else if(row.state==='confirming')await sql.query(`UPDATE crypto_deposit_observations SET state='reverted',reverted_at=now(),
      updated_at=now() WHERE id=$1`,[row.id]);
    return {status:200,body:publicDeposit((await sql.query<DepositRow>('SELECT * FROM crypto_deposit_observations WHERE id=$1',[row.id])).rows[0]!)};
    });return result.body;
  }
  requireCondition(observed.contractAddress.toLowerCase()===registered.contract_address,502,
    'CHAIN_OBSERVATION_MISMATCH','The chain observer returned a different token contract.');
  requireCondition(addressPattern.test(observed.recipient)&&transactionPattern.test(observed.blockHash)&&
    /^[0-9]+$/.test(observed.blockNumber)&&/^[0-9]+$/.test(observed.amountMinor)&&observed.confirmations>=0&&
    observed.finalityPolicyRef.length>0,502,'CHAIN_OBSERVATION_INVALID','The chain observer returned an invalid transfer.');
  const result=await command(db,owner,idempotencyKey,{operation:'observe_crypto_deposit',...input},
    sql=>authorizeDepositOwner(sql,owner),async sql=>{
    const prior=(await sql.query<DepositRow>(`SELECT * FROM crypto_deposit_observations WHERE chain_id=$1
      AND transaction_hash=$2 AND log_index=$3 FOR UPDATE`,[registered.chain_id,transactionHash,input.logIndex])).rows[0];
    requireCondition(!prior||prior.owner_id===owner,409,'DEPOSIT_ALREADY_CLAIMED','This transfer is already associated with another account.');
    if(!prior){
      const approved=(await sql.query<{asset_code:string}>(`SELECT t.asset_code FROM token_asset_registry t
        JOIN financial_assets a ON a.code=t.asset_code
        WHERE t.asset_code=$1 AND t.approved=true AND a.approved=true FOR SHARE OF t,a`,[input.asset])).rows[0];
      requireCondition(approved,422,'TOKEN_NOT_APPROVED','USDT-BSC deposits are not approved.');
    }
    const address=(await sql.query<AddressRow>(prior?`SELECT * FROM crypto_deposit_addresses WHERE id=$1 FOR SHARE`:
      `SELECT * FROM crypto_deposit_addresses WHERE owner_id=$1 AND asset_code=$2 AND chain_id=$3 AND address=$4
       AND state='active' FOR SHARE`,prior?[prior.address_id]:[owner,input.asset,registered.chain_id,observed.recipient.toLowerCase()])).rows[0];
    requireCondition(address,409,'DEPOSIT_ADDRESS_MISMATCH','The transfer recipient is not an assigned deposit address for this account.');
    const minimum=10n**BigInt(registered.decimals),amount=BigInt(observed.amountMinor);
    requireCondition(amount>=minimum,422,'DEPOSIT_MINIMUM_NOT_MET','The minimum USDT deposit is 1 USDT.');
    const inserted=prior?undefined:(await sql.query<DepositRow>(`INSERT INTO crypto_deposit_observations
      (id,address_id,owner_id,asset_code,chain_id,contract_address,transaction_hash,log_index,block_number,block_hash,
       amount_minor,confirmations,finality_policy_ref,state,reverted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CASE WHEN $14='reverted' THEN 'reverted' ELSE 'confirming' END,CASE WHEN $14='reverted' THEN now() ELSE NULL END)
      ON CONFLICT (chain_id,transaction_hash,log_index) DO NOTHING RETURNING *`,[randomUUID(),address.id,owner,input.asset,
      registered.chain_id,registered.contract_address,transactionHash,input.logIndex,observed.blockNumber,observed.blockHash.toLowerCase(),
      amount.toString(),observed.confirmations,observed.finalityPolicyRef,observed.state])).rows[0];
    const row=prior??inserted??(await sql.query<DepositRow>(`SELECT * FROM crypto_deposit_observations
      WHERE chain_id=$1 AND transaction_hash=$2 AND log_index=$3 FOR UPDATE`,[registered.chain_id,transactionHash,input.logIndex])).rows[0];
    requireCondition(row?.owner_id===owner,409,'DEPOSIT_ALREADY_CLAIMED','This transfer is already associated with another account.');
    const same=row.address_id===address.id&&address.address===observed.recipient.toLowerCase()&&row.asset_code===input.asset&&
      row.contract_address===registered.contract_address&&row.amount_minor===amount.toString();
    if(!same||row.block_hash!==observed.blockHash.toLowerCase()||row.block_number!==observed.blockNumber){
      if(row.state==='finalized')await openFinalityException(sql,row,requestId,'Finalized transfer no longer matches the independent chain observation');
      else await sql.query("UPDATE crypto_deposit_observations SET state='exception',updated_at=now() WHERE id=$1",[row.id]);
      return {status:200,body:publicDeposit((await sql.query<DepositRow>('SELECT * FROM crypto_deposit_observations WHERE id=$1',[row.id])).rows[0]!)};
    }
    if(row.state==='finalized'){
      if(observed.state!=='finalized')await openFinalityException(sql,row,requestId,'Finalized transfer is no longer finalized at the observer');
      return {status:200,body:publicDeposit((await sql.query<DepositRow>('SELECT * FROM crypto_deposit_observations WHERE id=$1',[row.id])).rows[0]!)};
    }
    if(row.state==='reverted'||row.state==='exception')return {status:200,body:publicDeposit(row)};
    if(observed.state==='reverted'){
      const reverted=(await sql.query<DepositRow>(`UPDATE crypto_deposit_observations SET state='reverted',confirmations=$2,
        reverted_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[row.id,observed.confirmations])).rows[0]!;
      await record(sql,{actor:owner,authority:'independent_chain_observer',action:'crypto_deposit.reverted',resource:row.id,
        request:requestId,reason:'USDT transfer disappeared before finality'});return {status:200,body:publicDeposit(reverted)};
    }
    if(observed.state==='confirming'){
      const confirming=(await sql.query<DepositRow>(`UPDATE crypto_deposit_observations SET confirmations=GREATEST(confirmations,$2),
        updated_at=now() WHERE id=$1 RETURNING *`,[row.id,observed.confirmations])).rows[0]!;return {status:200,body:publicDeposit(confirming)};
    }
    await lockOwnerAsset(sql,owner,input.asset);
    const escrow=await ledgerAccount(sql,null,input.asset,'escrow_asset'),available=await ledgerAccount(sql,owner,input.asset,'user_available');
    const journal=await postJournal(sql,{effectId:`crypto-deposit:${row.id}`,asset:input.asset,kind:'deposit_finalized',referenceId:row.id,
      reason:'Independently observed finalized USDT-BSC deposit',lines:[{account:escrow,debit:amount,credit:0n},
        {account:available,debit:0n,credit:amount}]});
    await sql.query(`INSERT INTO chain_observations(id,economic_effect_id,event_type,chain_id,block_number,block_hash,
      transaction_hash,log_index,account_address,asset_code,amount_minor,finality_policy_ref)
      VALUES ($1,$2,'deposit_finalized',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),`crypto-deposit:${row.id}`,
      registered.chain_id,observed.blockNumber,observed.blockHash.toLowerCase(),transactionHash,input.logIndex,address.address,input.asset,
      amount.toString(),observed.finalityPolicyRef]);
    const finalized=(await sql.query<DepositRow>(`UPDATE crypto_deposit_observations SET state='finalized',confirmations=$2,
      journal_id=$3,finalized_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[row.id,observed.confirmations,journal])).rows[0]!;
    await record(sql,{actor:owner,authority:'independent_chain_observer',action:'crypto_deposit.finalized',resource:row.id,
      request:requestId,reason:'Finalized USDT-BSC transfer credited exactly once',evidence:observed.finalityPolicyRef,
      after:{asset:input.asset,amount_minor:amount.toString(),transaction_hash:transactionHash,log_index:input.logIndex}});
    return {status:200,body:publicDeposit(finalized)};
  });return result.body;
}

async function openFinalityException(sql:Sql,row:DepositRow,requestId:string,reason:string){
  await sql.query("UPDATE crypto_deposit_observations SET state='exception',updated_at=now() WHERE id=$1",[row.id]);
  await sql.query(`INSERT INTO financial_exceptions(id,scope,reference_id,asset_code,expected_minor,observed_minor,severity,
    owner_ref,details_code) VALUES ($1,'crypto_deposit',$2,$3,$4,0,'critical',$5,'FINALIZED_DEPOSIT_REORG')
    ON CONFLICT DO NOTHING`,[randomUUID(),row.id,row.asset_code,row.amount_minor,row.owner_id]);
  await record(sql,{actor:row.owner_id,authority:'independent_chain_observer',action:'crypto_deposit.exception',resource:row.id,
    request:requestId,reason,result:'requires_finance_reconciliation'});
}

export async function listCryptoDeposits(sql:Sql,owner:string){
  const rows=(await sql.query<DepositRow>(`SELECT * FROM crypto_deposit_observations WHERE owner_id=$1
    ORDER BY observed_at DESC LIMIT 100`,[owner])).rows;return rows.map(publicDeposit);
}
