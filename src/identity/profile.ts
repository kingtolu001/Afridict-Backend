import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../platform/config.js';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import type { Account } from './auth.js';

const usernamePattern = /^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])?$/;
export type MediaKind = 'avatar' | 'cover';
export type MediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ProfileMediaStorage {
  createUpload(input: { providerReference: string; mimeType: MediaType; byteSize: number; checksum: string }): Promise<{ uploadUrl: string }>;
  completeUpload(input: { providerReference: string; checksum: string; width: number; height: number }): Promise<void>;
}

export const syntheticProfileMediaStorage: ProfileMediaStorage = {
  async createUpload(input) {
    return { uploadUrl: `http://127.0.0.1:3000/_synthetic/profile-media/${input.providerReference}` };
  },
  async completeUpload() { return undefined; },
};

type Fetch = typeof globalThis.fetch;
export class CloudinaryProfileMediaStorage implements ProfileMediaStorage {
  constructor(private readonly options: NonNullable<Config['cloudinary']>, private readonly request: Fetch = globalThis.fetch) {}
  async createUpload(input: { providerReference: string; mimeType: MediaType; byteSize: number; checksum: string }) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = `context=checksum=${input.checksum}&public_id=${input.providerReference}&timestamp=${timestamp}`;
    const signature = createHash('sha1').update(`${params}${this.options.apiSecret}`).digest('hex');
    const query = new URLSearchParams({ api_key: this.options.apiKey, context: `checksum=${input.checksum}`, public_id: input.providerReference, signature, timestamp });
    return { uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.options.cloudName)}/image/upload?${query}` };
  }
  async completeUpload(input: { providerReference: string; checksum: string; width: number; height: number }) {
    const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.options.cloudName)}/resources/image/upload/${encodeURIComponent(input.providerReference)}`;
    const response = await this.request(endpoint, { headers: { authorization: `Basic ${Buffer.from(`${this.options.apiKey}:${this.options.apiSecret}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`CLOUDINARY_RESOURCE_${response.status}`);
    const resource = await response.json() as { bytes?: number; width?: number; height?: number; context?: { custom?: { checksum?: string } } };
    if (resource.bytes === undefined || resource.width !== input.width || resource.height !== input.height || resource.context?.custom?.checksum !== input.checksum)
      throw new Error('CLOUDINARY_METADATA_MISMATCH');
  }
}

export function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase();
  requireCondition(usernamePattern.test(username), 422, 'INVALID_USERNAME', 'Username must be 3-30 characters using lowercase letters, numbers, or underscores, and must start and end with a letter or number.');
  return username;
}

function profileMedia(row: Record<string, unknown>) {
  return { id: row.id, kind: row.kind, status: row.status, created_at: new Date(row.created_at as string | Date).toISOString(), completed_at: row.completed_at ? new Date(row.completed_at as string | Date).toISOString() : null };
}

export async function usernameAvailability(sql: Sql, value: string) {
  const username = normalizeUsername(value);
  const row = (await sql.query<{ account_id: string }>('SELECT account_id FROM public_profiles WHERE username_normalized=$1', [username])).rows[0];
  return { username, available: !row };
}

function cloudinaryDeliveryUrl(cloudName: string | undefined, providerReference: unknown) {
  if (!cloudName || typeof providerReference !== 'string') return null;
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/f_auto,q_auto/${encodeURIComponent(providerReference)}`;
}

export async function getPublicProfile(sql: Sql, accountId: string, cloudName?: string) {
  const row = (await sql.query<Record<string, unknown>>(`SELECT p.*, a.id AS account_id,
      avatar.provider_reference AS avatar_provider_reference, cover.provider_reference AS cover_provider_reference
    FROM accounts a LEFT JOIN public_profiles p ON p.account_id=a.id
    LEFT JOIN profile_media_uploads avatar ON avatar.id=p.avatar_media_id AND avatar.status='complete'
    LEFT JOIN profile_media_uploads cover ON cover.id=p.cover_media_id AND cover.status='complete'
    WHERE a.id=$1`, [accountId])).rows[0];
  requireCondition(row, 404, 'NOT_FOUND', 'Profile not found.');
  return { account_id: accountId, username: row.username ?? null, display_name: row.display_name ?? null, bio: row.bio ?? null,
    avatar_media_id: row.avatar_media_id ?? null, cover_media_id: row.cover_media_id ?? null,
    avatar_url: cloudinaryDeliveryUrl(cloudName, row.avatar_provider_reference),
    cover_url: cloudinaryDeliveryUrl(cloudName, row.cover_provider_reference),
    created_at: row.created_at ? new Date(row.created_at as string | Date).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at as string | Date).toISOString() : null };
}

export async function savePublicProfile(sql: Sql, account: Account, input: { username: string; display_name?: string | null; bio?: string | null; avatar_media_id?: string | null; cover_media_id?: string | null }, cloudName?: string) {
  const username = normalizeUsername(input.username);
  const collision = (await sql.query<{ account_id: string }>('SELECT account_id FROM public_profiles WHERE username_normalized=$1 AND account_id<>$2', [username, account.id])).rows[0];
  requireCondition(!collision, 409, 'USERNAME_UNAVAILABLE', 'That username is already in use.');
  for (const [kind, mediaId] of [['avatar', input.avatar_media_id], ['cover', input.cover_media_id] as const]) {
    if (!mediaId) continue;
    const media = (await sql.query<{ account_id: string; kind: MediaKind; status: string }>('SELECT account_id,kind,status FROM profile_media_uploads WHERE id=$1', [mediaId])).rows[0];
    requireCondition(media?.account_id === account.id && media.kind === kind && media.status === 'complete', 422, 'INVALID_PROFILE_MEDIA', `The ${kind} media upload is not complete or is not owned by this account.`);
  }
  const row = (await sql.query<Record<string, unknown>>(`INSERT INTO public_profiles(account_id,username,username_normalized,display_name,bio,avatar_media_id,cover_media_id)
    VALUES ($1,$2,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO UPDATE SET username=EXCLUDED.username,username_normalized=EXCLUDED.username_normalized,
    display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,avatar_media_id=EXCLUDED.avatar_media_id,cover_media_id=EXCLUDED.cover_media_id,updated_at=now()
    RETURNING *`, [account.id, username, input.display_name?.trim() || null, input.bio?.trim() || null, input.avatar_media_id ?? null, input.cover_media_id ?? null])).rows[0]!;
  return getPublicProfile(sql, account.id, cloudName).then(profile => ({ ...profile, updated_at: new Date(row.updated_at as string | Date).toISOString() }));
}

export async function createMediaUpload(sql: Sql, account: Account, storage: ProfileMediaStorage, input: { kind: MediaKind; mime_type: MediaType; byte_size: number; width: number; height: number; checksum: string }) {
  const providerReference = randomUUID();
  const upload = await storage.createUpload({ providerReference, mimeType: input.mime_type, byteSize: input.byte_size, checksum: input.checksum });
  const row = (await sql.query<Record<string, unknown>>(`INSERT INTO profile_media_uploads(id,account_id,kind,provider_reference,mime_type,byte_size,width,height,checksum)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), account.id, input.kind, providerReference, input.mime_type, input.byte_size, input.width, input.height, input.checksum])).rows[0]!;
  return { ...profileMedia(row), upload_url: upload.uploadUrl };
}

export async function completeMediaUpload(sql: Sql, account: Account, storage: ProfileMediaStorage, id: string, input: { checksum: string; width: number; height: number; byte_size: number }) {
  const row = (await sql.query<Record<string, unknown>>('SELECT * FROM profile_media_uploads WHERE id=$1 AND account_id=$2 FOR UPDATE', [id, account.id])).rows[0];
  requireCondition(row, 404, 'NOT_FOUND', 'Media upload not found.');
  requireCondition(row.status === 'pending', 409, 'MEDIA_UPLOAD_NOT_PENDING', 'This media upload is no longer pending.');
  requireCondition(row.checksum === input.checksum && row.width === input.width && row.height === input.height && row.byte_size === input.byte_size, 422, 'MEDIA_METADATA_MISMATCH', 'Uploaded media metadata does not match the signed upload request.');
  await storage.completeUpload({ providerReference: row.provider_reference as string, checksum: input.checksum, width: input.width, height: input.height });
  const completed = (await sql.query<Record<string, unknown>>(`UPDATE profile_media_uploads SET status='complete',completed_at=now()
    WHERE id=$1 RETURNING *`, [id])).rows[0]!;
  return profileMedia(completed);
}

export async function onboardingStatus(sql: Sql, account: Account) {
  const profile = (await sql.query<{ account_id: string }>('SELECT account_id FROM account_profiles WHERE account_id=$1', [account.id])).rows[0];
  const assurance = (await sql.query<{ email_verified_at: Date | null; phone_verified_at: Date | null; identity_status: string }>('SELECT email_verified_at,phone_verified_at,identity_status FROM account_assurance WHERE account_id=$1', [account.id])).rows[0];
  const publicProfile = (await sql.query<{ username: string | null; display_name: string | null }>('SELECT username,display_name FROM public_profiles WHERE account_id=$1', [account.id])).rows[0];
  return { account_id: account.id, registration_complete: Boolean(profile), public_profile_complete: Boolean(publicProfile?.username && publicProfile.display_name),
    username_set: Boolean(publicProfile?.username), email_verified: Boolean(assurance?.email_verified_at), phone_verified: Boolean(assurance?.phone_verified_at),
    identity_status: assurance?.identity_status ?? 'NOT_STARTED' };
}
