import { describe, expect, it } from 'vitest';
import { SqlGatewayError, assertReadOnly, parseConnectionString } from './db.js';

describe('assertReadOnly', () => {
  it('accepts a single SELECT', () => {
    expect(() => assertReadOnly('SELECT 1')).not.toThrow();
    expect(() => assertReadOnly('  SELECT COUNT(*) FROM CDN.Konta;  ')).not.toThrow();
  });

  it('accepts a CTE', () => {
    expect(() => assertReadOnly('WITH x AS (SELECT 1 AS a) SELECT a FROM x')).not.toThrow();
  });

  it.each([
    'UPDATE CDN.Konta SET Acc_Nazwa = 1',
    'DELETE FROM CDN.Konta',
    'DROP TABLE CDN.Konta',
    'EXEC sp_who',
    'SELECT * INTO #t FROM CDN.Konta',
    'SELECT 1; DELETE FROM CDN.Konta',
    'RESTORE DATABASE x FROM DISK = 0',
  ])('rejects %s', (statement) => {
    expect(() => assertReadOnly(statement)).toThrow(SqlGatewayError);
  });

  it('is not fooled by a comment prefix', () => {
    expect(() => assertReadOnly('-- select\nDELETE FROM CDN.Konta')).toThrow(SqlGatewayError);
  });
});

describe('parseConnectionString', () => {
  it('passes the ADO form through untouched', () => {
    const ado = 'Server=localhost;Database=CDN_ABC;User Id=ro;Password=x';
    expect(parseConnectionString(ado)).toBe(ado);
  });

  it('parses the URL form, including a percent-encoded password', () => {
    expect(
      parseConnectionString('mssql://ro:se%21kret@sqlhost:1444/CDN_ABC?trustServerCertificate=true'),
    ).toEqual({
      server: 'sqlhost',
      port: 1444,
      database: 'CDN_ABC',
      user: 'ro',
      password: 'se!kret',
      options: { encrypt: true, trustServerCertificate: true, instanceName: undefined },
    });
  });

  it('defaults to encrypted, untrusted certificates', () => {
    expect(parseConnectionString('mssql://ro:x@sqlhost/CDN_ABC')).toMatchObject({
      options: { encrypt: true, trustServerCertificate: false },
    });
  });
});
