/**
 * Domain layer for `optima_describe_environment` (04 §"v1").
 *
 * Returns normalized data only — no ranking, no interpretation (03 §3.1).
 * Field values keep Polish domain terms; the calling agent does the prose.
 */
import type { Db } from '../db.js';

/**
 * Concepts we probe for. Names are verified against a real Optima company DB
 * (07 — Spike 0), but they are still checked at runtime and reported as
 * unresolved rather than assumed (02 §2.6).
 */
const CONCEPTS = [
  { concept: 'pieczatka', table: 'Pieczatki', note: 'dane firmy (pieczątka)' },
  { concept: 'okresy_obrachunkowe', table: 'OkresyObrach', note: 'okresy obrachunkowe' },
  { concept: 'plan_kont', table: 'Konta', note: 'plan kont' },
  { concept: 'dzienniki', table: 'Dzienniki', note: 'dzienniki cząstkowe' },
  { concept: 'zapisy_naglowki', table: 'DekretyNag', note: 'nagłówki zapisów księgowych' },
  { concept: 'zapisy_pozycje', table: 'DekretyKonta', note: 'pozycje zapisów (dekrety)' },
  { concept: 'zestawienia_naglowki', table: 'ZestKsiNag', note: 'zestawienia księgowe' },
  { concept: 'zestawienia_pozycje', table: 'ZestKsiPoz', note: 'pozycje zestawień + definicje' },
  { concept: 'zestawienia_konta', table: 'ZestawieniaKonta', note: 'powiązanie konto ↔ pozycja' },
] as const;

export interface SourceInfo {
  server: string;
  database: string;
  collation: string;
  sqlServerVersion: string;
  sqlServerEdition: string;
  databaseCreated: string;
  /** ISO timestamp of the backup this database was restored from, if any. */
  restoredFrom: string | null;
  restoredAt: string | null;
}

export interface CompanyInfo {
  nazwa: string;
  nip: string | null;
  regon: string | null;
  krsNumer: string | null;
  krsSad: string | null;
  adres: string | null;
  kodPocztowy: string | null;
  miasto: string | null;
  kraj: string | null;
  telefon: string | null;
  email: string | null;
  www: string | null;
}

export interface PeriodInfo {
  symbol: string;
  dataOtwarcia: string;
  dataKoncowa: string;
  dataZamkniecia: string | null;
  status: 'otwarty' | 'zamknięty';
}

export interface ConceptResolution {
  concept: string;
  table: string;
  note: string;
  resolved: boolean;
}

export interface PostureInfo {
  login: string;
  readOnly: boolean;
  /** Database roles the login holds that grant more than SELECT. */
  writeRoles: string[];
}

export interface Environment {
  source: SourceInfo;
  company: CompanyInfo | null;
  periods: PeriodInfo[];
  accountCount: number | null;
  schema: ConceptResolution[];
  posture: PostureInfo;
  caveats: string[];
}

export async function describeEnvironment(db: Db): Promise<Environment> {
  const caveats: string[] = [];

  const source = await readSource(db);
  const schema = await resolveConcepts(db);
  const resolved = (concept: string) => schema.find((c) => c.concept === concept)?.resolved ?? false;

  const company = resolved('pieczatka') ? await readCompany(db) : null;
  if (!company && resolved('pieczatka')) {
    caveats.push('Tabela CDN.Pieczatki istnieje, ale nie zawiera aktualnej pieczątki firmy.');
  }

  const periods = resolved('okresy_obrachunkowe') ? await readPeriods(db) : [];
  const accountCount = resolved('plan_kont') ? await readAccountCount(db) : null;

  const posture = await readPosture(db);
  if (!posture.readOnly) {
    caveats.push(
      `Login "${posture.login}" ma uprawnienia zapisu (${posture.writeRoles.join(', ')}). ` +
        'Zalecany jest login wyłącznie z rolą db_datareader.',
    );
  }

  const unresolved = schema.filter((c) => !c.resolved);
  if (unresolved.length > 0) {
    caveats.push(
      `Nierozpoznane obiekty schematu: ${unresolved.map((c) => `CDN.${c.table}`).join(', ')}. ` +
        'Funkcje oparte na tych tabelach są niedostępne.',
    );
  }
  if (source.collation !== 'Polish_CI_AS') {
    caveats.push(
      `Collation bazy to ${source.collation}, oczekiwane Polish_CI_AS — porównania numerów kont mogą działać inaczej niż w Optimie.`,
    );
  }
  if (source.restoredFrom) {
    caveats.push(
      'To jest odtworzona kopia bezpieczeństwa, nie baza produkcyjna — dane są aktualne na moment wykonania kopii.',
    );
  }

  return { source, company, periods, accountCount, schema, posture, caveats };
}

interface SourceRow {
  server: string;
  database: string;
  collation: string;
  version: string;
  edition: string;
  created: Date;
}

async function readSource(db: Db): Promise<SourceInfo> {
  const row = await db.queryOne<SourceRow>(`
    SELECT
      CAST(SERVERPROPERTY('ServerName') AS NVARCHAR(200))                AS server,
      DB_NAME()                                                         AS [database],
      CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(100))  AS collation,
      CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50))             AS version,
      CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100))                   AS edition,
      (SELECT create_date FROM sys.databases WHERE name = DB_NAME())     AS created
  `);

  const restore = await readRestoreHistory(db);

  return {
    server: str(row?.server) ?? 'unknown',
    database: str(row?.database) ?? db.label,
    collation: str(row?.collation) ?? 'unknown',
    sqlServerVersion: str(row?.version) ?? 'unknown',
    sqlServerEdition: str(row?.edition) ?? 'unknown',
    databaseCreated: iso(row?.created) ?? 'unknown',
    restoredFrom: restore?.file ?? null,
    restoredAt: restore?.at ?? null,
  };
}

/**
 * Was this database restored from a backup, and from which file? Analysing a
 * three-month-old backup and reporting it as current is the expensive mistake
 * this tool exists to prevent (04). Needs msdb read access — a read-only login
 * scoped to the company DB won't have it, which is fine: we report nothing
 * rather than failing.
 */
async function readRestoreHistory(db: Db): Promise<{ file: string | null; at: string | null } | null> {
  try {
    const row = await db.queryOne<{ backupFile: string | null; restoreDate: Date }>(`
      SELECT TOP 1
             bmf.physical_device_name AS backupFile,
             rh.restore_date          AS restoreDate
      FROM msdb.dbo.restorehistory rh
      LEFT JOIN msdb.dbo.backupset bs ON bs.backup_set_id = rh.backup_set_id
      LEFT JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
      WHERE rh.destination_database_name = DB_NAME()
      ORDER BY rh.restore_date DESC
    `);
    if (!row) return null;
    return { file: str(row.backupFile), at: iso(row.restoreDate) };
  } catch {
    return null;
  }
}

async function resolveConcepts(db: Db): Promise<ConceptResolution[]> {
  const { rows } = await db.query<{ name: string }>(`
    SELECT TABLE_NAME AS name
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'CDN' AND TABLE_TYPE = 'BASE TABLE'
  `);
  const present = new Set(rows.map((r) => r.name.toLowerCase()));
  return CONCEPTS.map((c) => ({
    concept: c.concept,
    table: `CDN.${c.table}`,
    note: c.note,
    resolved: present.has(c.table.toLowerCase()),
  }));
}

async function readCompany(db: Db): Promise<CompanyInfo | null> {
  const row = await db.queryOne<Record<string, string | null>>(`
    SELECT TOP 1
      LTRIM(RTRIM(CONCAT(PC_Nazwa1, ' ', PC_Nazwa2, ' ', PC_Nazwa3))) AS nazwa,
      PC_NipE       AS nip,
      PC_Regon      AS regon,
      PC_KRS_Numer  AS krsNumer,
      PC_KRS_Sad    AS krsSad,
      PC_UlicaNrDomLok AS adres,
      PC_KodP       AS kod,
      PC_Miasto     AS miasto,
      PC_Kraj       AS kraj,
      PC_Telefon    AS telefon,
      PC_Email      AS email,
      PC_URL        AS www
    FROM CDN.Pieczatki
    ORDER BY PC_Aktualna DESC, PC_DataOd DESC
  `);
  if (!row) return null;

  return {
    nazwa: str(row['nazwa']) ?? '(brak nazwy)',
    nip: str(row['nip']),
    regon: str(row['regon']),
    krsNumer: str(row['krsNumer']),
    krsSad: str(row['krsSad']),
    adres: str(row['adres']),
    kodPocztowy: str(row['kod']),
    miasto: str(row['miasto']),
    kraj: str(row['kraj']),
    telefon: str(row['telefon']),
    email: str(row['email']),
    www: str(row['www']),
  };
}

async function readPeriods(db: Db): Promise<PeriodInfo[]> {
  const { rows } = await db.query<{
    symbol: string;
    otw: Date;
    kon: Date;
    zam: Date | null;
  }>(`
    SELECT OOb_Symbol AS symbol, OOb_DataOtw AS otw, OOb_DataKoncowa AS kon, OOb_DataZam AS zam
    FROM CDN.OkresyObrach
    ORDER BY OOb_DataOtw
  `);
  return rows.map((r) => ({
    symbol: str(r.symbol) ?? '(bez symbolu)',
    dataOtwarcia: date(r.otw) ?? 'unknown',
    dataKoncowa: date(r.kon) ?? 'unknown',
    dataZamkniecia: date(r.zam),
    status: r.zam ? ('zamknięty' as const) : ('otwarty' as const),
  }));
}

async function readAccountCount(db: Db): Promise<number | null> {
  const row = await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM CDN.Konta');
  return row?.n ?? null;
}

const WRITE_ROLES = ['db_owner', 'db_datawriter', 'db_ddladmin', 'db_securityadmin', 'db_accessadmin'];

async function readPosture(db: Db): Promise<PostureInfo> {
  const who = await db.queryOne<{ login: string }>('SELECT SUSER_SNAME() AS login');

  const { rows } = await db.query<{ role: string }>(`
    SELECT r.name AS role
    FROM sys.database_role_members m
    JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
    JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
    WHERE u.name = USER_NAME()
  `);
  const held = rows.map((r) => r.role);
  const writeRoles = held.filter((r) => WRITE_ROLES.includes(r));

  // sysadmin bypasses role membership entirely.
  const sa = await db.queryOne<{ isSysadmin: number }>(
    "SELECT IS_SRVROLEMEMBER('sysadmin') AS isSysadmin",
  );
  if (sa?.isSysadmin === 1) writeRoles.push('sysadmin (rola serwerowa)');

  return {
    login: str(who?.login) ?? 'unknown',
    readOnly: writeRoles.length === 0,
    writeRoles,
  };
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function date(value: unknown): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : null;
}
