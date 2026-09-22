import type { Sql } from '../platform/database.js';
import { AppError,requireCondition } from '../platform/errors.js';
import type { Account } from './auth.js';
import { normalizeEmail,normalizePhone } from './providers.js';
import type { CountryCode } from 'libphonenumber-js/max';

export type RegistrationProfile={first_name:string;last_name:string;email:string;phone_number:string;
  terms_version:string;privacy_version:string;accepted_at:string};
type ProfileRow={account_id:string;first_name:string;last_name:string;email:string;phone_e164:string;
  terms_version:string;privacy_version:string;accepted_at:Date};

export async function registerProfile(sql:Sql,account:Account,input:RegistrationProfile) {
  const email=normalizeEmail(input.email);
  let phone:string;
  try { phone=normalizePhone(input.phone_number,account.jurisdiction==='ZZ'?undefined:account.jurisdiction as CountryCode); }
  catch { throw new AppError(400,'INVALID_PHONE_NUMBER','Supply a valid phone number in E.164 or the account jurisdiction format.'); }
  const collision=(await sql.query<{account_id:string}>(`SELECT account_id FROM account_profiles
    WHERE (email=$1 OR phone_e164=$2) AND account_id<>$3`,[email,phone,account.id])).rows[0];
  requireCondition(!collision,409,'CONTACT_ALREADY_REGISTERED','This contact is already associated with another account. Use the identity-provider recovery flow.');
  const existing=(await sql.query<ProfileRow>('SELECT * FROM account_profiles WHERE account_id=$1',[account.id])).rows[0];
  if (existing) {
    requireCondition(existing.first_name===input.first_name.trim()&&existing.last_name===input.last_name.trim()&&
      existing.email===email&&existing.phone_e164===phone&&existing.terms_version===input.terms_version&&
      existing.privacy_version===input.privacy_version,409,'REGISTRATION_PROFILE_CONFLICT','The registration profile is immutable; use a governed profile-change flow.');
    return publicProfile(existing);
  }
  const row=(await sql.query<ProfileRow>(`INSERT INTO account_profiles(account_id,first_name,last_name,email,phone_e164,
    terms_version,privacy_version,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[account.id,input.first_name.trim(),
    input.last_name.trim(),email,phone,input.terms_version,input.privacy_version,input.accepted_at])).rows[0]!;
  await sql.query('INSERT INTO account_assurance(account_id) VALUES ($1) ON CONFLICT DO NOTHING',[account.id]);
  return publicProfile(row);
}
export async function getRegistrationProfile(sql:Sql,accountId:string) {
  const row=(await sql.query<ProfileRow>('SELECT * FROM account_profiles WHERE account_id=$1',[accountId])).rows[0];
  requireCondition(row,404,'REGISTRATION_PROFILE_REQUIRED','Complete the registration profile before continuing.');
  return publicProfile(row);
}
function publicProfile(row:{first_name:string;last_name:string;email:string;phone_e164:string;terms_version:string;
  privacy_version:string;accepted_at:Date}) {
  return {first_name:row.first_name,last_name:row.last_name,email:row.email,phone_number:row.phone_e164,
    terms_version:row.terms_version,privacy_version:row.privacy_version,accepted_at:new Date(row.accepted_at).toISOString()};
}
