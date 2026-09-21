import { describe, expect, it } from 'vitest';
import { config } from '../src/platform/config.js';

describe('deployment safety', () => {
  it('fails closed without OIDC configuration', () => expect(() => config({ NODE_ENV: 'production' })).toThrow());
  it('never enables demo authentication in production or on a public bind', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'demo', HOST: '0.0.0.0' })).toThrow();
  });
  it('keeps finance disabled unless the isolated demo is selected', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo', FINANCIAL_MODE: 'synthetic' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'oidc', FINANCIAL_MODE: 'synthetic',
      OIDC_ISSUER: 'https://issuer.example', OIDC_AUDIENCE: 'api', OIDC_JWKS_URL: 'https://issuer.example/jwks' })).toThrow();
  });
  it('requires exact HTTPS origins in production', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://issuer.example',
      OIDC_AUDIENCE: 'api', OIDC_JWKS_URL: 'https://issuer.example/jwks', CORS_ORIGINS: 'http://localhost:5173' })).toThrow();
  });
  it('requires encrypted error-tracking transport', () => {
    const base={NODE_ENV:'development',AUTH_MODE:'oidc',OIDC_ISSUER:'https://issuer.example',
      OIDC_AUDIENCE:'api',OIDC_JWKS_URL:'https://issuer.example/jwks'};
    expect(()=>config({...base,ERROR_TRACKING_DSN:'http://public@example.com/1'})).toThrow('must use HTTPS');
    expect(config({...base,ERROR_TRACKING_DSN:'https://public@example.com/1'}).errorTrackingDsn)
      .toBe('https://public@example.com/1');
  });
  it('requires complete Cloudinary configuration in production', () => {
    const base={NODE_ENV:'production',AUTH_MODE:'oidc',OIDC_ISSUER:'https://issuer.example',
      OIDC_AUDIENCE:'api',OIDC_JWKS_URL:'https://issuer.example/jwks'};
    expect(()=>config(base)).toThrow('Cloudinary configuration');
    expect(()=>config({...base,CLOUDINARY_CLOUD_NAME:'cloud',CLOUDINARY_API_KEY:'key'})).toThrow('Cloudinary configuration');
    expect(config({...base,CLOUDINARY_CLOUD_NAME:'cloud',CLOUDINARY_API_KEY:'key',CLOUDINARY_API_SECRET:'secret'}).cloudinary)
      .toEqual({cloudName:'cloud',apiKey:'key',apiSecret:'secret'});
  });
  it('advertises Google only through configured OIDC authorization',()=>{
    const base={NODE_ENV:'development',AUTH_MODE:'oidc',OIDC_ISSUER:'https://issuer.example',
      OIDC_AUDIENCE:'api',OIDC_JWKS_URL:'https://issuer.example/jwks'};
    expect(()=>config({...base,AUTH_METHODS:'google'})).toThrow('OIDC authorization configuration');
    expect(()=>config({...base,AUTH_METHODS:'google,google',OIDC_AUTHORIZATION_URL:'https://issuer.example/authorize',OIDC_CLIENT_ID:'client'}))
      .toThrow('unique');
    expect(config({...base,AUTH_METHODS:'password,google',OIDC_AUTHORIZATION_URL:'https://issuer.example/authorize',
      OIDC_CLIENT_ID:'client'}).authMethods).toEqual(['password','google']);
  });
});
