import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';

export interface Principal { issuer: string; subject: string; expiresAt: string }
export interface Account {
  id: string; issuer: string; subject: string; jurisdiction: string;
  status: 'active' | 'suspended'; roles: string[]; created_at: Date;
}
export interface Authenticator { verify(token: string): Promise<Principal> }

export async function findAccount(sql: Sql, principal: Principal, lock = false): Promise<Account> {
  const account = (await sql.query<Account>(`SELECT * FROM accounts WHERE issuer=$1 AND subject=$2${lock ? ' FOR SHARE' : ''}`,
    [principal.issuer, principal.subject])).rows[0];
  requireCondition(account, 403, 'ONBOARDING_REQUIRED', 'Complete onboarding before using this operation.');
  requireCondition(account.status === 'active', 403, 'ACCOUNT_RESTRICTED', 'This account cannot perform this operation.');
  return account;
}
export function hasRole(account: Account, ...roles: string[]) {
  requireCondition(roles.some(role => account.roles.includes(role)), 403, 'FORBIDDEN', 'This operation requires an authorized role.');
}
export function publicAccount(a: Account) {
  return { id: a.id, jurisdiction: a.jurisdiction, status: a.status, roles: a.roles, created_at: new Date(a.created_at).toISOString() };
}
