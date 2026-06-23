/**
 * Postgres type OID → type name, for labelling arbitrary query-result columns
 * (roadmap §5.4). The server can't supply schema metadata for raw SQL, so it
 * returns each column's type OID (`dataTypeID`); this maps the common ones to a
 * name the DataGrid can use to pick a cell renderer (e.g. json/jsonb → tree
 * viewer) and to display the type under the column header.
 *
 * Only the everyday built-ins are covered — anything else (enums, domains,
 * custom types) falls back to `oid:<n>`, which still renders fine since the grid
 * degrades to a plain-text cell.
 */
const OID_TO_NAME: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  650: 'cidr',
  700: 'float4',
  701: 'float8',
  869: 'inet',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  // common array types
  1000: '_bool',
  1005: '_int2',
  1007: '_int4',
  1009: '_text',
  1015: '_varchar',
  1016: '_int8',
  199: '_json',
  3807: '_jsonb',
}

/** Resolve a column type OID to a Postgres type name, or '' when unknown. */
export function pgTypeName(oid: number | undefined): string {
  if (oid == null) return ''
  return OID_TO_NAME[oid] ?? `oid:${oid}`
}
