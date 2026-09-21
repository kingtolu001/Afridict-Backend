import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth, demoConfig, seedDemo } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';

let db: Database, app: FastifyInstance, key = 0;
const auth = (name: string) => ({ authorization: `Bearer demo.${name}` });
const nextKey = () => `profile-test-${++key}`;

beforeAll(async () => {
  db = await embeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  app = await buildApp(db, demoConfig, demoAuth);
});
afterAll(async () => { await app.close(); await db.close(); });

describe('public profile and onboarding', () => {
  it('normalizes usernames and reports collisions', async () => {
    const first = await app.inject({ method: 'PUT', url: '/v1/me/public-profile', headers: { ...auth('trader'), 'idempotency-key': nextKey() }, payload: { username: '  Ada_Trader ', display_name: 'Ada' } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ username: 'ada_trader', display_name: 'Ada' });
    expect((await app.inject({ method: 'GET', url: '/v1/usernames/ADA_TRADER/availability' })).json()).toEqual({ username: 'ada_trader', available: false });
    const collision = await app.inject({ method: 'PUT', url: '/v1/me/public-profile', headers: { ...auth('creator'), 'idempotency-key': nextKey() }, payload: { username: 'ADA_TRADER', display_name: 'Creator' } });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().code).toBe('USERNAME_UNAVAILABLE');
  });

  it('requires owned completed media before attaching it', async () => {
    const checksum = 'a'.repeat(64);
    const created = await app.inject({ method: 'POST', url: '/v1/me/profile-media-uploads', headers: { ...auth('trader'), 'idempotency-key': nextKey() }, payload: { kind: 'avatar', mime_type: 'image/png', byte_size: 1024, width: 256, height: 256, checksum } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    const incomplete = await app.inject({ method: 'PUT', url: '/v1/me/public-profile', headers: { ...auth('trader'), 'idempotency-key': nextKey() }, payload: { username: 'trader_profile', display_name: 'Trader', avatar_media_id: id } });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().code).toBe('INVALID_PROFILE_MEDIA');
    const completed = await app.inject({ method: 'POST', url: `/v1/me/profile-media-uploads/${id}/complete`, headers: { ...auth('trader'), 'idempotency-key': nextKey() }, payload: { checksum, byte_size: 1024, width: 256, height: 256 } });
    expect(completed.statusCode, completed.body).toBe(200);
    const saved = await app.inject({ method: 'PUT', url: '/v1/me/public-profile', headers: { ...auth('trader'), 'idempotency-key': nextKey() }, payload: { username: 'trader_profile', display_name: 'Trader', avatar_media_id: id } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ avatar_media_id: id });
  });

  it('returns server-owned onboarding completion signals', async () => {
    const status = await app.inject({ method: 'GET', url: '/v1/me/onboarding-status', headers: auth('trader') });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ registration_complete: false, public_profile_complete: true, username_set: true, email_verified: true, phone_verified: true, identity_status: 'VERIFIED' });
  });
});
