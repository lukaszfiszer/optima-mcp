/**
 * Renders the environment report as Markdown. Output contract (03 §3.8):
 * DATA / META / CAVEATS, readable without a schema the model has to be taught.
 */
import type { Environment } from '../domain/environment.js';

export function formatEnvironment(env: Environment): string {
  const out: string[] = [];

  out.push('# Środowisko Optima');
  out.push('');
  out.push('## Źródło danych');
  out.push('');
  out.push(row('Serwer', env.source.server));
  out.push(row('Baza', env.source.database));
  out.push(
    row(
      'Rodzaj',
      env.source.restoredFrom
        ? `odtworzona kopia bezpieczeństwa (${env.source.restoredFrom}), odtworzona ${env.source.restoredAt ?? 'nieznana data'}`
        : 'połączenie z bazą (brak śladu odtwarzania kopii)',
    ),
  );
  out.push(row('SQL Server', `${env.source.sqlServerVersion} — ${env.source.sqlServerEdition}`));
  out.push(row('Collation', env.source.collation));
  out.push(row('Baza utworzona', env.source.databaseCreated));

  out.push('');
  out.push('## Firma');
  out.push('');
  if (env.company) {
    const c = env.company;
    out.push(row('Nazwa', c.nazwa));
    out.push(row('NIP', c.nip));
    out.push(row('REGON', c.regon));
    out.push(row('KRS', c.krsNumer ? [c.krsNumer, c.krsSad].filter(Boolean).join(', ') : null));
    out.push(
      row('Adres', [c.adres, [c.kodPocztowy, c.miasto].filter(Boolean).join(' '), c.kraj].filter(Boolean).join(', ') || null),
    );
    out.push(row('Telefon', c.telefon));
    out.push(row('E-mail', c.email));
    out.push(row('WWW', c.www));
  } else {
    out.push('_Brak danych firmy — pieczątka nieodczytana._');
  }

  out.push('');
  out.push('## Okresy obrachunkowe');
  out.push('');
  if (env.periods.length > 0) {
    out.push('| Symbol | Od | Do | Status | Data zamknięcia |');
    out.push('|---|---|---|---|---|');
    for (const p of env.periods) {
      out.push(
        `| ${p.symbol} | ${p.dataOtwarcia} | ${p.dataKoncowa} | ${p.status} | ${p.dataZamkniecia ?? '—'} |`,
      );
    }
  } else {
    out.push('_Brak okresów obrachunkowych (baza bez modułu Księga Handlowa lub bez konfiguracji)._');
  }

  out.push('');
  out.push('## Plan kont');
  out.push('');
  out.push(
    env.accountCount === null
      ? '_Tabela planu kont nierozpoznana._'
      : `Liczba kont (wszystkie okresy): **${env.accountCount}**`,
  );

  out.push('');
  out.push('## Rozpoznane obiekty schematu');
  out.push('');
  out.push('| Koncept | Tabela | Status | Opis |');
  out.push('|---|---|---|---|');
  for (const c of env.schema) {
    out.push(`| ${c.concept} | ${c.table} | ${c.resolved ? 'OK' : 'brak'} | ${c.note} |`);
  }

  out.push('');
  out.push('## Uprawnienia');
  out.push('');
  out.push(row('Login', env.posture.login));
  out.push(
    row(
      'Tryb',
      env.posture.readOnly
        ? 'tylko odczyt'
        : `uprawnienia zapisu: ${env.posture.writeRoles.join(', ')}`,
    ),
  );

  out.push('');
  out.push('## Zastrzeżenia');
  out.push('');
  if (env.caveats.length > 0) {
    for (const c of env.caveats) out.push(`- ${c}`);
  } else {
    out.push('- Brak.');
  }

  return out.join('\n');
}

function row(label: string, value: string | null | undefined): string {
  return `- **${label}:** ${value && value.length > 0 ? value : '—'}`;
}
