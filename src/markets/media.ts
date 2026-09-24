import { randomUUID } from 'node:crypto';
import type { MarketTerms } from '../contracts.js';
import type { Account } from '../identity/auth.js';
import type { MediaType, ProfileMediaStorage } from '../identity/profile.js';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';

export interface MarketMediaInput {
  mime_type: MediaType;
  byte_size: number;
  width: number;
  height: number;
  checksum: string;
}

function publicUpload(row: Record<string, unknown>) {
  return { id: row.id, status: row.status,
    created_at: new Date(row.created_at as string | Date).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at as string | Date).toISOString() : null };
}

export async function createMarketMediaUpload(sql: Sql, account: Account, storage: ProfileMediaStorage, input: MarketMediaInput) {
  const providerReference = randomUUID();
  const upload = await storage.createUpload({ providerReference, mimeType: input.mime_type,
    byteSize: input.byte_size, checksum: input.checksum });
  const row = (await sql.query<Record<string, unknown>>(`INSERT INTO market_media_uploads
    (id,owner_id,provider_reference,mime_type,byte_size,width,height,checksum)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), account.id, providerReference,
    input.mime_type, input.byte_size, input.width, input.height, input.checksum])).rows[0]!;
  return { ...publicUpload(row), upload_url: upload.uploadUrl };
}

export async function completeMarketMediaUpload(sql: Sql, account: Account, storage: ProfileMediaStorage,
  id: string, input: Omit<MarketMediaInput, 'mime_type'>) {
  const row = (await sql.query<Record<string, unknown>>(
    'SELECT * FROM market_media_uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, account.id])).rows[0];
  requireCondition(row, 404, 'NOT_FOUND', 'Market media upload not found.');
  requireCondition(row.status === 'pending', 409, 'MEDIA_UPLOAD_NOT_PENDING', 'This media upload is no longer pending.');
  requireCondition(row.checksum === input.checksum && row.width === input.width && row.height === input.height &&
    row.byte_size === input.byte_size, 422, 'MEDIA_METADATA_MISMATCH',
  'Uploaded media metadata does not match the signed upload request.');
  await storage.completeUpload({ providerReference: row.provider_reference as string, checksum: input.checksum,
    width: input.width, height: input.height });
  const completed = (await sql.query<Record<string, unknown>>(`UPDATE market_media_uploads
    SET status='complete',completed_at=now() WHERE id=$1 RETURNING *`, [id])).rows[0]!;
  return publicUpload(completed);
}

export async function deleteMarketMediaUpload(sql: Sql, account: Account, id: string) {
  const row = (await sql.query<Record<string, unknown>>(
    'SELECT * FROM market_media_uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, account.id])).rows[0];
  requireCondition(row, 404, 'NOT_FOUND', 'Market media upload not found.');
  requireCondition(row.status !== 'deleted', 409, 'MEDIA_ALREADY_DELETED', 'This media upload is already deleted.');
  const inUse = (await sql.query(`SELECT id FROM markets WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(terms->'outcomes') outcome WHERE outcome->>'image_media_id'=$1)
    UNION ALL SELECT id FROM market_proposals WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(terms->'outcomes') outcome WHERE outcome->>'image_media_id'=$1) LIMIT 1`, [id])).rows[0];
  requireCondition(!inUse, 409, 'MEDIA_IN_USE', 'Remove this image from every market draft or proposal before deleting it.');
  const deleted = (await sql.query<Record<string, unknown>>(`UPDATE market_media_uploads
    SET status='deleted',deleted_at=now() WHERE id=$1 RETURNING *`, [id])).rows[0]!;
  return publicUpload(deleted);
}

export async function assertOutcomeMedia(sql: Sql, account: Account, terms: MarketTerms) {
  const ids = [...new Set(terms.outcomes.flatMap(outcome => outcome.image_media_id ? [outcome.image_media_id] : []))];
  if (!ids.length) return;
  const rows = (await sql.query<{ id: string; owner_id: string; status: string }>(
    'SELECT id,owner_id,status FROM market_media_uploads WHERE id=ANY($1::uuid[]) FOR SHARE', [ids])).rows;
  for (const id of ids) {
    const media = rows.find(row => row.id === id);
    requireCondition(media?.owner_id === account.id && media.status === 'complete', 422, 'INVALID_MARKET_MEDIA',
      'Every outcome image must be a completed market upload owned by the draft creator.');
  }
}

function deliveryUrl(cloudName: string, providerReference: string) {
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/f_auto,q_auto/${encodeURIComponent(providerReference)}`;
}

export async function hydrateOutcomeMedia(sql: Sql, markets: Array<{ id: string; terms: MarketTerms }>, cloudName?: string) {
  const result = new Map(markets.map(market => [market.id, market.terms]));
  if (!cloudName) return result;
  const ids = [...new Set(markets.flatMap(market => market.terms.outcomes.flatMap(
    outcome => outcome.image_media_id ? [outcome.image_media_id] : [])))];
  if (!ids.length) return result;
  const rows = (await sql.query<{ id: string; provider_reference: string }>(
    "SELECT id,provider_reference FROM market_media_uploads WHERE id=ANY($1::uuid[]) AND status='complete'", [ids])).rows;
  const references = new Map(rows.map(row => [row.id, row.provider_reference]));
  for (const market of markets) result.set(market.id, { ...market.terms,
    outcomes: market.terms.outcomes.map(outcome => {
      const reference = outcome.image_media_id ? references.get(outcome.image_media_id) : undefined;
      return reference ? { ...outcome, image_url: deliveryUrl(cloudName, reference) } : outcome;
    }) });
  return result;
}
