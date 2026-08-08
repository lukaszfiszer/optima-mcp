import { describe, expect, it } from 'vitest';
import { ConfigError, describeTarget, resolveConnectionString } from './config.js';

const ADO = 'Server=localhost;Database=CDN_ABC;User Id=ro;Password=x';

describe('resolveConnectionString', () => {
  it('takes a positional argument', () => {
    expect(resolveConnectionString([ADO], {})).toBe(ADO);
  });

  it('takes --connection-string in both forms', () => {
    expect(resolveConnectionString(['--connection-string', ADO], {})).toBe(ADO);
    expect(resolveConnectionString([`--connection-string=${ADO}`], {})).toBe(ADO);
  });

  it('falls back to the environment', () => {
    expect(resolveConnectionString([], { OPTIMA_CONNECTION_STRING: ADO })).toBe(ADO);
  });

  it('prefers the argument over the environment', () => {
    expect(resolveConnectionString([ADO], { OPTIMA_CONNECTION_STRING: 'other' })).toBe(ADO);
  });

  it('rejects nothing at all, unknown flags, and a second positional', () => {
    expect(() => resolveConnectionString([], {})).toThrow(ConfigError);
    expect(() => resolveConnectionString(['--server', 'localhost'], {})).toThrow(ConfigError);
    expect(() => resolveConnectionString([ADO, ADO], {})).toThrow(ConfigError);
    expect(() => resolveConnectionString(['--connection-string'], {})).toThrow(ConfigError);
  });
});

describe('describeTarget', () => {
  it('describes an ADO string without leaking the password', () => {
    const described = describeTarget(ADO);
    expect(described).toBe('localhost / CDN_ABC');
    expect(described).not.toContain('x');
  });

  it('accepts the Data Source / Initial Catalog spelling', () => {
    expect(describeTarget('Data Source=sqlhost\\OPTIMA;Initial Catalog=CDN_ABC;User Id=ro')).toBe(
      'sqlhost\\OPTIMA / CDN_ABC',
    );
  });

  it('describes a URL string without leaking the password', () => {
    const described = describeTarget('mssql://ro:sekret@localhost:1433/CDN_ABC?encrypt=true');
    expect(described).toBe('localhost:1433 / CDN_ABC');
    expect(described).not.toContain('sekret');
  });
});
