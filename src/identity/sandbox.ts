import type {Sql} from '../platform/database.js';

export async function grantSandboxAccess(sql:Sql,accountId:string){
  await sql.query(`UPDATE eligibility SET status='eligible',policy_version='sandbox:v1',
    evidence_ref='sandbox:test-access',updated_at=now() WHERE account_id=$1`,[accountId]);
  await sql.query(`UPDATE account_assurance SET email_verified_at=coalesce(email_verified_at,now()),
    phone_verified_at=coalesce(phone_verified_at,now()),identity_status='VERIFIED',
    identity_evidence_ref='sandbox:test-access',identity_updated_at=now() WHERE account_id=$1`,[accountId]);
}
