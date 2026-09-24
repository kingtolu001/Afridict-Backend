import {createCipheriv,createDecipheriv,createHmac,randomBytes,randomUUID} from 'node:crypto';
import type {Database,Sql} from '../platform/database.js';
import {integer} from '../financial/model.js';
import {hash,record} from '../platform/commands.js';
import {AppError,requireCondition} from '../platform/errors.js';
import {createWithdrawal,publicWithdrawal} from './service.js';
import {ledgerAccount,lockOwnerAsset,postJournal} from '../financial/ledger.js';
import {swervpayMinorAmount,type FiatCurrency,type FiatRailProvider} from './swervpay.js';

interface Row {intent_id:string;owner_id:string;asset_code:FiatCurrency;target_minor:string;state:string;provider_reference:string|null;
  account_name:string|null;account_number:string|null;bank_code:string|null;bank_name:string|null;provider_transaction_id:string|null;
  settled_minor:string|null;expires_at:Date;created_at:Date;updated_at:Date}
const select=`SELECT r.*,d.owner_id,d.asset_code,d.target_minor,d.expires_at,d.created_at FROM fiat_collection_requests r
  JOIN deposit_intents d ON d.id=r.intent_id`;
export function publicFiatDeposit(row:Row) {return {id:row.intent_id,currency:row.asset_code,target_minor:row.target_minor,state:row.state,
  expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString(),
  instructions:['instructions_available','settled'].includes(row.state)?{account_name:row.account_name!,account_number:row.account_number!,
    bank_code:row.bank_code!,bank_name:row.bank_name!,provider:'swervpay' as const}:null};}

export async function createFiatDeposit(sql:Sql,input:{owner:string;currency:FiatCurrency;targetMinor:string},requestId:string) {
  const amount=integer(input.targetMinor);requireCondition(amount>=20_000n,422,'DEPOSIT_MINIMUM_NOT_MET','The minimum NGN deposit is 20,000 kobo (NGN 200).');
  const rail=(await sql.query<{approved:boolean;collections_enabled:boolean}>(`SELECT r.approved,r.collections_enabled FROM fiat_rail_registry r
    JOIN financial_assets f ON f.code=r.asset_code WHERE r.provider='swervpay' AND r.asset_code=$1 AND f.approved=true FOR SHARE`,[input.currency])).rows[0];
  requireCondition(rail?.approved&&rail.collections_enabled,503,'FIAT_RAIL_NOT_APPROVED','The selected currency collection rail is not approved.');
  const id=randomUUID();
  await sql.query(`INSERT INTO deposit_intents(id,owner_id,asset_code,target_minor,rail,beneficiary_ref,expires_at)
    VALUES ($1,$2,$3,$4,'swervpay',$5,now()+interval '30 minutes')`,[id,input.owner,input.currency,amount.toString(),`fiat:pending:${id}`]);
  await sql.query("INSERT INTO fiat_collection_requests(intent_id,provider,state) VALUES ($1,'swervpay','instruction_pending')",[id]);
  const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1`,[id])).rows[0]!;
  await record(sql,{actor:input.owner,authority:'account_owner',action:'fiat.collection_requested',resource:id,request:requestId,
    reason:'Request provider deposit instructions',after:{currency:input.currency,target_minor:amount.toString(),state:row.state}});
  return publicFiatDeposit(row);
}

export async function getFiatDeposit(sql:Sql,owner:string,id:string) {
  const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1 AND d.owner_id=$2`,[id,owner])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Fiat deposit intent not found.');return publicFiatDeposit(row);
}

export async function processFiatCollection(db:Database,provider:FiatRailProvider,id:string) {
  const claim=await db.transaction(async sql=>{
    const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1 FOR UPDATE`,[id])).rows[0];requireCondition(row,404,'NOT_FOUND','Fiat deposit intent not found.');
    if(row.state==='instructions_available'||row.state==='instruction_uncertain')return {row,process:false};
    if(row.state==='instruction_creating'&&new Date(row.updated_at).getTime()<Date.now()-300_000){
      await sql.query("UPDATE fiat_collection_requests SET state='instruction_uncertain',updated_at=now() WHERE intent_id=$1",[id]);
      return {row:{...row,state:'instruction_uncertain'},process:false};
    }
    if(row.state==='instruction_creating')return {row,process:false};
    requireCondition(new Date(row.expires_at).getTime()>=Date.now(),409,'DEPOSIT_INTENT_EXPIRED','The deposit intent expired.');
    await sql.query("UPDATE fiat_collection_requests SET state='instruction_creating',attempt_count=1,updated_at=now() WHERE intent_id=$1",[id]);
    return {row,process:true};
  });
  if(!claim.process)return claim.row.state;
  try {
    const instruction=await provider.createCollection({currency:claim.row.asset_code,amountMinor:claim.row.target_minor,
      reference:id,merchantName:'Afridict'});
    requireCondition(instruction.reference===id&&instruction.currency===claim.row.asset_code,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','Provider collection identity does not match the request.');
    await db.transaction(async sql=>{await sql.query(`UPDATE fiat_collection_requests SET state='instructions_available',provider_reference=$2,
      account_name=$3,account_number=$4,bank_code=$5,bank_name=$6,updated_at=now() WHERE intent_id=$1 AND state='instruction_creating'`,
      [id,instruction.id,instruction.accountName,instruction.accountNumber,instruction.bankCode,instruction.bankName]);});
    return 'instructions_available';
  } catch(error) {
    await db.query("UPDATE fiat_collection_requests SET state='instruction_uncertain',updated_at=now() WHERE intent_id=$1 AND state='instruction_creating'",[id]);
    throw error;
  }
}

export async function processPendingFiatCollections(db:Database,provider:FiatRailProvider,limit=20){
  const rows=(await db.query<{intent_id:string}>(`SELECT intent_id FROM fiat_collection_requests
    WHERE state='instruction_pending' ORDER BY updated_at,intent_id LIMIT $1`,[limit])).rows;
  for(const row of rows)await processFiatCollection(db,provider,row.intent_id);
  return rows.length;
}

export interface SwervpayCollectionEvent {event:'collection.completed';data:{id:string;reference:string;business_id:string;
  status:'COMPLETED';amount:number;currency:string;charges:number;type:'CREDIT';detail:string;created_at:string;updated_at:string;
  collection_id:string;account_number:string;bank_code:string;bank_name:string;account_name:string}}
export async function applySwervpayCollection(sql:Sql,event:SwervpayCollectionEvent,requestId:string){
  const amount=swervpayMinorAmount(event.data.amount),payloadHash=hash(event);
  const inserted=await sql.query(`INSERT INTO partner_events(partner_id,event_id,event_type,payload_hash,occurred_at)
    VALUES ('swervpay',$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
    [event.data.id,event.event,payloadHash,event.data.updated_at]);
  if(!inserted.rows.length){
    const prior=(await sql.query<{payload_hash:string}>(`SELECT payload_hash FROM partner_events
      WHERE partner_id='swervpay' AND event_id=$1`,[event.data.id])).rows[0];
    requireCondition(prior?.payload_hash===payloadHash,409,'PARTNER_EVENT_CONFLICT',
      'SwervPay reused a transaction identifier with different financial data.');return false;
  }
  const row=(await sql.query<Row>(`${select} WHERE r.provider_reference=$1 FOR UPDATE`,[event.data.collection_id])).rows[0];
  requireCondition(row,404,'DEPOSIT_REFERENCE_UNKNOWN','The SwervPay collection identity is not an Afridict deposit.');
  requireCondition(row.state==='instructions_available',409,'DEPOSIT_NOT_SETTLEABLE',
    'This deposit is not awaiting a SwervPay collection.');
  requireCondition(row.asset_code==='NGN'&&row.target_minor===amount,409,'DEPOSIT_MISMATCH',
    'The SwervPay collection amount or currency does not match the deposit intent.');
  await lockOwnerAsset(sql,row.owner_id,'NGN');
  const escrow=await ledgerAccount(sql,null,'NGN','escrow_asset');
  const available=await ledgerAccount(sql,row.owner_id,'NGN','user_available');
  await postJournal(sql,{effectId:`swervpay-collection:${event.data.id}`,asset:'NGN',kind:'deposit_finalized',
    referenceId:row.intent_id,reason:'Authenticated completed SwervPay NGN collection',lines:[
      {account:escrow,debit:BigInt(amount),credit:0n},{account:available,debit:0n,credit:BigInt(amount)},
    ]});
  await sql.query(`UPDATE deposit_intents SET state='partner_confirmed',partner_id='swervpay',
    partner_reference=$2,partner_minor=$3,updated_at=now() WHERE id=$1`,[row.intent_id,event.data.id,amount]);
  await sql.query("UPDATE deposit_intents SET state='reconciled_available',updated_at=now() WHERE id=$1",[row.intent_id]);
  await sql.query(`UPDATE fiat_collection_requests SET state='settled',provider_transaction_id=$2,
    settled_minor=$3,updated_at=now() WHERE intent_id=$1`,[row.intent_id,event.data.id,amount]);
  await record(sql,{actor:'partner:swervpay',authority:'verified_partner_webhook',action:'fiat.collection_settled',
    resource:row.intent_id,request:requestId,reason:'Credit exact authenticated completed collection once',
    evidence:`swervpay:${event.data.id}`,after:{state:'settled',amount_minor:amount}});
  return true;
}

type PayoutInput={amountMinor:string;bankCode:string;accountNumber:string;narration:string};
type PrivatePayout={accountName:string;accountNumber:string;bankCode:string;bankName:string;narration:string};
const encrypt=(value:PrivatePayout,key:Buffer)=>{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),
  ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {ciphertext,nonce,authTag:cipher.getAuthTag()};};
const decrypt=(ciphertext:Buffer,nonce:Buffer,authTag:Buffer,key:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,nonce);
  decipher.setAuthTag(authTag);return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8')) as PrivatePayout;};

export async function requestNgnWithdrawal(db:Database,provider:FiatRailProvider,dataHashKey:string,dataEncryptionKey:Buffer,keyVersion:string,
  actor:string,key:string,input:PayoutInput,requestId:string) {
  const bankAccountHash=createHmac('sha256',dataHashKey).update(`${input.bankCode}:${input.accountNumber}`).digest('hex');
  const fingerprint=hash({operation:'requestNgnWithdrawal',amount_minor:input.amountMinor,narration:input.narration,bank_account_hash:bankAccountHash});
  const existing=(await db.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM command_results WHERE actor_id=$1 AND idempotency_key=$2',[actor,key])).rows[0];
  if(existing){requireCondition(existing.request_hash===fingerprint,409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for a different command.');return existing.response;}
  const resolved=await provider.resolveAccount({bankCode:input.bankCode,accountNumber:input.accountNumber});
  requireCondition(resolved.bankCode===input.bankCode&&resolved.accountNumber===input.accountNumber,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','The provider returned a different bank account.');
  return db.transaction(async sql=>{
    await sql.query('INSERT INTO command_results(actor_id,idempotency_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[actor,key,fingerprint]);
    const command=(await sql.query<{request_hash:string;status_code:number|null;response:unknown}>(
      'SELECT request_hash,status_code,response FROM command_results WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actor,key])).rows[0]!;
    requireCondition(command.request_hash===fingerprint,409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for a different command.');
    if(command.status_code!==null)return command.response;
    const rail=(await sql.query<{approved:boolean;payouts_enabled:boolean}>(`SELECT approved,payouts_enabled FROM fiat_rail_registry
      WHERE provider='swervpay' AND asset_code='NGN' FOR SHARE`)).rows[0];
    requireCondition(rail?.approved&&rail.payouts_enabled,503,'FIAT_RAIL_NOT_APPROVED','The NGN payout rail is not approved.');
    const digest=bankAccountHash.slice(0,16);
    const destination=`swervpay:${input.bankCode}:******${input.accountNumber.slice(-4)}:${digest}`;
    const withdrawal=await createWithdrawal(sql,{owner:actor,asset:'NGN',amount:input.amountMinor,destination,rail:'swervpay'},requestId);
    const sealed=encrypt({accountName:resolved.accountName,accountNumber:resolved.accountNumber,bankCode:resolved.bankCode,
      bankName:resolved.bankName,narration:input.narration},dataEncryptionKey);
    await sql.query(`INSERT INTO private_payout_details(withdrawal_id,ciphertext,nonce,auth_tag,key_version) VALUES ($1,$2,$3,$4,$5)`,
      [withdrawal.id,sealed.ciphertext,sealed.nonce,sealed.authTag,keyVersion]);
    await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',
      [actor,key,JSON.stringify(withdrawal)]);return withdrawal;
  });
}

export async function listNgnPayouts(sql:Sql,dataEncryptionKey:Buffer,state='reserved') {
  const rows=(await sql.query<(Parameters<typeof publicWithdrawal>[0]&{ciphertext:Buffer;nonce:Buffer;auth_tag:Buffer})>(`SELECT w.*,p.ciphertext,p.nonce,p.auth_tag
    FROM withdrawals w JOIN private_payout_details p ON p.withdrawal_id=w.id WHERE w.asset_code='NGN' AND w.rail='swervpay' AND w.state=$1
    ORDER BY w.created_at ASC LIMIT 100`,[state])).rows;
  return rows.map(row=>{const details=decrypt(row.ciphertext,row.nonce,row.auth_tag,dataEncryptionKey);return {...publicWithdrawal(row),
    bank:{account_name:details.accountName,account_number:details.accountNumber,bank_code:details.bankCode,bank_name:details.bankName},narration:details.narration};});
}

export async function approveNgnPayout(db:Database,provider:FiatRailProvider,dataEncryptionKey:Buffer,admin:string,key:string,
  withdrawalId:string,reason:string,requestId:string) {
  const fingerprint=hash({operation:'approveNgnPayout',withdrawal_id:withdrawalId,reason});
  const claim=await db.transaction(async sql=>{
    await sql.query('INSERT INTO command_results(actor_id,idempotency_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[admin,key,fingerprint]);
    const command=(await sql.query<{request_hash:string;status_code:number|null;response:unknown}>(`SELECT request_hash,status_code,response FROM command_results
      WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`,[admin,key])).rows[0]!;
    requireCondition(command.request_hash===fingerprint,409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for a different command.');
    if(command.status_code!==null)return {submit:false,result:command.response};
    const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId])).rows[0];
    requireCondition(row,404,'NOT_FOUND','NGN withdrawal not found.');
    if(row.state!=='reserved'){const result=publicWithdrawal(row);await sql.query(`UPDATE command_results SET status_code=202,response=$3
      WHERE actor_id=$1 AND idempotency_key=$2`,[admin,key,JSON.stringify(result)]);return {submit:false,result};}
    const secret=(await sql.query<{ciphertext:Buffer;nonce:Buffer;auth_tag:Buffer}>('SELECT ciphertext,nonce,auth_tag FROM private_payout_details WHERE withdrawal_id=$1',[withdrawalId])).rows[0];
    requireCondition(secret,409,'PAYOUT_DETAILS_UNAVAILABLE','Payout details are unavailable.');const details=decrypt(secret.ciphertext,secret.nonce,secret.auth_tag,dataEncryptionKey);
    const updated=(await sql.query<Parameters<typeof publicWithdrawal>[0]>("UPDATE withdrawals SET state='submitting',updated_at=now() WHERE id=$1 RETURNING *",[withdrawalId])).rows[0]!;
    await record(sql,{actor:admin,authority:'finance_operator',action:'ngn_payout.approved',resource:withdrawalId,request:requestId,reason,
      before:{state:'reserved'},after:{state:'submitting'}});
    return {submit:true,result:publicWithdrawal(updated),details};
  });
  if(!claim.submit)return claim.result;
  const withdrawal=claim.result as ReturnType<typeof publicWithdrawal>,details=claim.details!;
  try {
    const payout=await provider.createPayout({currency:'NGN',amountMinor:withdrawal.amount_minor,reference:withdrawal.id,
      bankCode:details.bankCode,accountNumber:details.accountNumber,narration:details.narration});
    requireCondition(payout.reference===withdrawal.id,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','Provider payout identity does not match the request.');
    return await db.transaction(async sql=>{const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`UPDATE withdrawals SET state='submitted',
      provider_reference=$2,updated_at=now() WHERE id=$1 AND state='submitting' RETURNING *`,[withdrawal.id,payout.id])).rows[0];
      requireCondition(row,409,'PAYOUT_SUBMISSION_CONFLICT','The payout workflow changed during submission.');const result=publicWithdrawal(row);
      await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',[admin,key,JSON.stringify(result)]);return result;});
  }catch(error){
    if(error instanceof AppError&&error.statusCode<500)throw error;
    return await db.transaction(async sql=>{await sql.query("UPDATE withdrawals SET state='uncertain',updated_at=now() WHERE id=$1 AND state='submitting'",[withdrawal.id]);
      const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1',[withdrawal.id])).rows[0]!,result=publicWithdrawal(row);
      await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',[admin,key,JSON.stringify(result)]);return result;});
  }
}

export async function completeNgnPayout(sql:Sql,id:string,admin:string,providerReference:string,reason:string,requestId:string){
  const initial=(await sql.query<Parameters<typeof publicWithdrawal>[0]&{reservation_id:string;provider_reference:string|null}>(
    "SELECT * FROM withdrawals WHERE id=$1 AND asset_code='NGN' AND rail='swervpay'",[id])).rows[0];
  requireCondition(initial,404,'NOT_FOUND','NGN payout not found.');await lockOwnerAsset(sql,initial.owner_id,initial.asset_code);
  const row=(await sql.query<typeof initial>("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",[id])).rows[0]!;
  requireCondition(['submitted','uncertain'].includes(row.state),409,'PAYOUT_NOT_CONFIRMABLE','Only a submitted or uncertain payout can be confirmed.');
  requireCondition(!row.provider_reference||row.provider_reference===providerReference,409,'PAYOUT_REFERENCE_CONFLICT','The provider reference does not match the submitted payout.');
  const pending=await ledgerAccount(sql,row.owner_id,'NGN','user_withdrawal_pending'),escrow=await ledgerAccount(sql,null,'NGN','escrow_asset'),amount=integer(row.amount_minor);
  await postJournal(sql,{effectId:`fiat-withdrawal:${row.id}`,asset:'NGN',kind:'withdrawal_finalized',referenceId:row.id,
    reason:'Finance administrator confirmed the Swervpay payout in the provider dashboard',lines:[
      {account:pending,debit:amount,credit:0n},{account:escrow,debit:0n,credit:amount}]});
  await sql.query("UPDATE collateral_reservations SET consumed=amount,state='consumed',updated_at=now() WHERE id=$1",[row.reservation_id]);
  const updated=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`UPDATE withdrawals SET state='finalized',provider_reference=$2,
    updated_at=now() WHERE id=$1 RETURNING *`,[id,providerReference])).rows[0]!;
  await record(sql,{actor:admin,authority:'finance_operator',action:'ngn_payout.confirmed',resource:id,request:requestId,reason,
    evidence:`swervpay:${providerReference}`,before:{state:row.state},after:{state:'finalized',provider_reference:providerReference}});
  return publicWithdrawal(updated);
}
