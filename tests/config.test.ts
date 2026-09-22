import { describe, expect, it } from 'vitest';
import { config } from '../src/platform/config.js';

describe('deployment safety', () => {
  it('uses native authentication in production without an external identity provider', () => expect(config({ NODE_ENV: 'production' }).authMode).toBe('native'));
  it('never enables demo authentication in production or on a public bind', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'demo', HOST: '0.0.0.0' })).toThrow();
  });
  it('binds production to all interfaces when HOST is omitted', () => {
    expect(config({ NODE_ENV: 'production', CLOUDINARY_CLOUD_NAME: 'cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret' }).host).toBe('0.0.0.0');
  });
  it('keeps finance disabled unless the isolated demo is selected', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo', FINANCIAL_MODE: 'synthetic' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'native', FINANCIAL_MODE: 'synthetic' })).toThrow();
  });
  it('requires exact HTTPS origins in production', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'native', CORS_ORIGINS: 'http://localhost:5173' })).toThrow();
  });
  it('requires encrypted error-tracking transport', () => {
    const base={NODE_ENV:'development',AUTH_MODE:'native'};
    expect(()=>config({...base,ERROR_TRACKING_DSN:'http://public@example.com/1'})).toThrow('must use HTTPS');
    expect(config({...base,ERROR_TRACKING_DSN:'https://public@example.com/1'}).errorTrackingDsn)
      .toBe('https://public@example.com/1');
  });
  it('keeps Cloudinary optional until profile media is used', () => {
    const base={NODE_ENV:'production',AUTH_MODE:'native'};
    expect(config(base).cloudinary).toBeUndefined();
    expect(()=>config({...base,CLOUDINARY_CLOUD_NAME:'cloud',CLOUDINARY_API_KEY:'key'})).toThrow('Cloudinary configuration');
    expect(config({...base,CLOUDINARY_CLOUD_NAME:'cloud',CLOUDINARY_API_KEY:'key',CLOUDINARY_API_SECRET:'secret'}).cloudinary)
      .toEqual({cloudName:'cloud',apiKey:'key',apiSecret:'secret'});
  });
  it('keeps Google disabled in native authentication mode',()=>{
    const configured=config({NODE_ENV:'production',AUTH_MODE:'native',AUTH_METHODS:'password,google'});
    expect(configured.authMethods).toEqual(['password']);
  });
});
