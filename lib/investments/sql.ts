import type { Database, SqlValue } from "sql.js";

export type SqlRow = Record<string, SqlValue>;

export function firstRow(
  raw: Database,
  sql: string,
  parameters: readonly SqlValue[] = [],
): SqlRow | null {
  const statement = raw.prepare(sql);
  try {
    statement.bind([...parameters]);
    return statement.step() ? (statement.getAsObject() as SqlRow) : null;
  } finally {
    statement.free();
  }
}

export function allRows(
  raw: Database,
  sql: string,
  parameters: readonly SqlValue[] = [],
): SqlRow[] {
  const statement = raw.prepare(sql);
  const rows: SqlRow[] = [];
  try {
    statement.bind([...parameters]);
    while (statement.step()) rows.push(statement.getAsObject() as SqlRow);
    return rows;
  } finally {
    statement.free();
  }
}
