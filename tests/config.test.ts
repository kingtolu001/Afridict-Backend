import { describe, expect, it } from 'vitest';
import { config } from '../src/platform/config.js';

describe('deployment safety', () => {
  it('uses native authentication in production without an external identity provider', () => expect(config({ NODE_ENV: 'production' }).authMode).toBe('native'));
  it('rejects the superseded OIDC authentication mode',()=>expect(()=>config({NODE_ENV:'production',AUTH_MODE:'oidc'})).toThrow('Invalid AUTH_MODE'));
  it('never enables demo authentication in production or on a public bind', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'demo', HOST: '0.0.0.0' })).toThrow();
  });
  it('binds production to all interfaces when HOST is omitted', () => {
    expect(config({ NODE_ENV: 'production', CLOUDINARY_CLOUD_NAME: 'cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret' }).host).toBe('0.0.0.0');
  });
  it('separates local synthetic finance from hosted native sandbox finance', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo', FINANCIAL_MODE: 'synthetic' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'native', FINANCIAL_MODE: 'synthetic' })).toThrow();
    expect(config({NODE_ENV:'production',AUTH_MODE:'native',FINANCIAL_MODE:'sandbox'}).financialMode).toBe('sandbox');
    expect(()=>config({NODE_ENV:'development',AUTH_MODE:'demo',FINANCIAL_MODE:'sandbox'})).toThrow('requires native');
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
  it('enables direct Google authentication only with complete secure configuration',()=>{
    const base={NODE_ENV:'production',AUTH_MODE:'native'};
    expect(config(base).authMethods).toEqual(['password']);
    expect(()=>config({...base,GOOGLE_CLIENT_ID:'client'})).toThrow('Google authentication requires');
    expect(()=>config({...base,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',
      GOOGLE_REDIRECT_URI:'http://app.example/callback'})).toThrow('requires HTTPS');
    const configured=config({...base,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',
      GOOGLE_REDIRECT_URI:'https://app.example/auth/google/callback'});
    expect(configured.authMethods).toEqual(['password','google']);
    expect(configured.google).toEqual({clientId:'client',clientSecret:'secret',redirectUri:'https://app.example/auth/google/callback'});
  });
  it('configures the BSC observer only with a secure RPC and bounded finality policy',()=>{
    const base={NODE_ENV:'production',AUTH_MODE:'native'};
    expect(()=>config({...base,BSC_MIN_CONFIRMATIONS:'12'})).toThrow('requires BSC_RPC_URL');
    expect(()=>config({...base,BSC_RPC_URL:'http://bsc.example',BSC_MIN_CONFIRMATIONS:'12'})).toThrow('requires HTTPS');
    expect(()=>config({...base,BSC_RPC_URL:'https://bsc.example',BSC_MIN_CONFIRMATIONS:'0'})).toThrow('integer from 1 to 1000');
    expect(config({...base,BSC_RPC_URL:'https://bsc.example'}).bsc).toEqual({rpcUrl:'https://bsc.example',minimumConfirmations:12});
  });
});
