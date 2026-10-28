import { useState } from 'react';
import type { Component } from '../shared/protocol.js';

const cell = (value: unknown) => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—');
export function DataTable({ data }: { data: Extract<Component, { kind: 'table' }>['data'] }) {
  const [page, setPage] = useState(0), count = 25, pages = Math.max(1, Math.ceil(data.rows.length / count)), current = Math.min(page, pages - 1);
  return <><div className="table-scroll"><table><thead><tr>{data.columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{data.rows.slice(current * count, (current + 1) * count).map((r, i) => <tr key={i}>{data.columns.map(c => <td key={c.key}>{cell(r[c.key])}</td>)}</tr>)}</tbody></table></div><div className="pagination"><span>{data.totalRows ?? data.rows.length} rows</span><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</button></div></>;
}
