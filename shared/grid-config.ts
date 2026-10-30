import { z } from 'zod';
import { configScalar, conditionSchema, matches, presentationSchema } from './component-config.js';
const key = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(value => !['__proto__','constructor','prototype'].includes(value));
export const valueConstraintSchema = z.strictObject({ type: z.enum(['string','number','integer','boolean']).optional(), storage: z.enum(['native','string']).optional(), required: z.boolean().optional(), nullable: z.boolean().optional(), min: z.number().finite().optional(), max: z.number().finite().optional(), minLength: z.number().int().min(0).max(16384).optional(), maxLength: z.number().int().min(0).max(16384).optional(), values: z.array(configScalar).max(100).optional(), prefix: z.string().max(1000).optional(), suffix: z.string().max(1000).optional() }).refine(v => (v.min === undefined || v.max === undefined || v.min <= v.max) && (v.minLength === undefined || v.maxLength === undefined || v.minLength <= v.maxLength), 'Constraint ranges must be ordered');
export const gridColumnSchema = z.strictObject({ key, label: z.string().max(100), editable: z.boolean().optional(), type: z.enum(['text','number','toggle']).optional(), hidden: z.boolean().optional(), width: z.number().int().min(60).max(800).optional(), tooltip: z.string().max(2000).optional(), constraints: valueConstraintSchema.optional() });
export const gridRuleSchema = z.strictObject({ id: key, when: conditionSchema, column: key.optional(), constraints: valueConstraintSchema.optional(), presentation: presentationSchema.optional(), tooltip: z.string().max(2000).optional() });
export const precedenceSchema = z.strictObject({ groupBy: z.array(key).min(1).max(32), mandatory: z.array(key).max(32).optional(), dimensions: z.array(key).min(1).max(32), emptyValues: z.array(configScalar).max(32).optional(), context: z.record(z.string().max(100), configScalar).optional(), label: z.string().max(160).optional() }).refine(v => new Set(v.dimensions).size === v.dimensions.length && new Set(v.groupBy).size === v.groupBy.length, 'Precedence fields must be unique');
export const gridDataSchema = z.object({ readAction: key.optional(), rows: z.array(z.record(z.string().max(100), configScalar)).max(2000).optional(), editAction: key.optional(), addAction: key.optional(), deleteAction: key.optional(), bulkAction: key.optional(), historyAction: key.optional(), evaluateAction: key.optional(), keyColumn: key.optional(), keyColumns: z.array(key).min(1).max(32).refine(keys=>new Set(keys).size===keys.length,'Key columns must be unique').optional(), versionColumn: key.optional(), pageSize: z.number().int().min(1).max(200).optional(), columns: z.array(gridColumnSchema).min(1).max(64), rules: z.array(gridRuleSchema).max(128).optional(), precedence: precedenceSchema.optional(), features: z.strictObject({ hideColumns: z.boolean().optional(), filter: z.boolean().optional(), sort: z.boolean().optional(), add: z.boolean().optional(), edit: z.boolean().optional(), delete: z.boolean().optional(), bulk: z.boolean().optional(), history: z.boolean().optional(), evaluate: z.boolean().optional(), explain: z.boolean().optional() }).optional() }).superRefine((data, ctx) => {
  const keys = new Set(data.columns.map(c=>c.key));
  if (keys.size !== data.columns.length) ctx.addIssue({code:'custom', message:'Column keys must be unique'});
  const refs = [...(data.keyColumns ?? []), ...(data.precedence?.groupBy ?? []), ...(data.precedence?.mandatory ?? []), ...(data.precedence?.dimensions ?? []), ...(data.rules?.flatMap(rule => rule.column ? [rule.column] : []) ?? [])];
  if (refs.some(ref=>!keys.has(ref))) ctx.addIssue({code:'custom',message:'Grid configuration must reference declared columns'});
});
function decimal(value:string):number {const text=value.trim();return /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)?Number(text):NaN;}
export type GridData = z.infer<typeof gridDataSchema>;
export type GridRow = Record<string,z.infer<typeof configScalar>>;
export function cellRules(data: GridData, row: GridRow, column: string) {
  const definition = data.columns.find(c=>c.key===column);
  let constraints = { ...definition?.constraints }, presentation: z.infer<typeof presentationSchema> = {}, tooltip = definition?.tooltip;
  const matched: string[] = [];
  for (const rule of data.rules ?? []) if ((!rule.column || rule.column === column) && matches(rule.when, row)) { constraints = {...constraints,...rule.constraints}; presentation = {...presentation,...rule.presentation}; tooltip = rule.tooltip ?? tooltip; matched.push(rule.id); }
  return { constraints, presentation, tooltip, matched };
}
export function validateGridRow(data: GridData, row: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const column of data.columns) {
    const { constraints } = cellRules(data, row as GridRow, column.key), c = {...constraints,type:constraints.type ?? (column.type==='number'?'number':column.type==='toggle'?'boolean':undefined)};
    let value = row[column.key];
    if(c.storage==='string' && value !== undefined && value !== null) { if(typeof value !== 'string') { errors.push(`${column.label}: expected string storage`); continue; } if(c.type==='boolean' && (value==='true'||value==='false')) value=value==='true'; else if((c.type==='number'||c.type==='integer') && value.trim()!=='') value=decimal(value); }
    const fail = (message: string) => errors.push(`${column.label}: ${message}`);
    if (value === undefined || value === '' || value === null) { if (c.required && !(value === null && c.nullable)) fail('a value is required'); if (value === null && c.nullable === false) fail('null is not allowed'); if (value !== '') continue; if (!c.required && !c.type) continue; }
    if (c.type && (c.type === 'integer' ? typeof value !== 'number' || !Number.isInteger(value) : typeof value !== (c.type === 'string' ? 'string' : c.type))) fail(`expected ${c.type}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || c.min !== undefined && value < c.min || c.max !== undefined && value > c.max)) fail('outside allowed numeric range');
    if (typeof value === 'string' && (c.minLength !== undefined && value.length < c.minLength || c.maxLength !== undefined && value.length > c.maxLength || c.prefix !== undefined && !value.startsWith(c.prefix) || c.suffix !== undefined && !value.endsWith(c.suffix))) fail('does not meet text constraints');
    if (c.values && !c.values.some(item=>item===value)) fail('not an allowed value');
  }
  return errors;
}
export function coerceGridChanges(data: GridData, previous: GridRow, changes: Record<string,unknown>): GridRow {
  const draft = { ...previous, ...changes } as GridRow;
  for (const column of data.columns) if (Object.hasOwn(changes,column.key)) {
    const { constraints } = cellRules(data,draft,column.key), value = changes[column.key];
    const type = constraints.type ?? (column.type === 'number' ? 'number' : column.type === 'toggle' ? 'boolean' : 'string');
    if ((type === 'number' || type === 'integer') && typeof value === 'string' && value.trim() !== '') draft[column.key] = decimal(value);
    else if (type === 'boolean' && (value === 'true' || value === 'false')) draft[column.key] = value === 'true';
    if (constraints.storage==='string' && draft[column.key] !== undefined && draft[column.key] !== null) draft[column.key] = String(draft[column.key]);
  }
  const errors = validateGridRow(data,draft); if (errors.length) throw new Error(errors.join('; '));
  return draft;
}
export type PrecedenceResult = { state: 'active'|'overridden'|'conflict'|'ineligible'; reason: string };
export function evaluatePrecedence(data: GridData, rows: GridRow[]): PrecedenceResult[] {
  const spec = data.precedence; if (!spec) return [];
  const empty = (value: unknown) => value === undefined || (spec.emptyValues ?? [null,'','*']).some(item=>item===value);
  const groups = new Map<string,{index:number;rank:string}[]>(), result: PrecedenceResult[] = [];
  rows.forEach((row,index)=>{
    const absent = spec.mandatory?.find(field=>empty(row[field]));
    const mismatch = spec.context && [...new Set([...(spec.mandatory ?? []),...spec.dimensions])].find(field=>Object.hasOwn(spec.context!,field) && !empty(spec.context![field]) && !empty(row[field]) && row[field]!==spec.context![field]);
    if (absent || mismatch) { result[index]={state:'ineligible',reason:absent ? `Mandatory field ${absent} is empty` : `Does not match context ${mismatch}`}; return; }
    const group = JSON.stringify([...new Set([...spec.groupBy,...(spec.mandatory ?? [])])].map(field=>[field,row[field] ?? null]));
    const rank = spec.dimensions.map(field=>empty(row[field])?'0':'1').join('');
    const entries = groups.get(group) ?? []; entries.push({index,rank}); groups.set(group,entries);
  });
  for (const entries of groups.values()) {
    const ambiguous = spec.dimensions.find(field=>(!spec.context || !Object.hasOwn(spec.context,field) || empty(spec.context[field])) && new Set(entries.map(entry=>rows[entry.index]![field]).filter(value=>!empty(value))).size>1);
    if(ambiguous) {for(const entry of entries) result[entry.index]={state:'conflict',reason:`Select a context for ${ambiguous}; rows address different targets`};continue;}
    const best = entries.reduce((rank,entry)=>entry.rank>rank?entry.rank:rank,''), winners = entries.filter(entry=>entry.rank===best);
    for (const entry of entries) result[entry.index] = entry.rank===best ? {state:winners.length>1?'conflict':'active',reason:winners.length>1 ? 'Equal priority: resolve the tie explicitly' : `Highest priority: ${spec.dimensions.filter((_,i)=>best[i]==='1').join(' > ') || 'default'}`} : {state:'overridden',reason:`Overridden by ${spec.dimensions.filter((_,i)=>best[i]==='1').join(' > ') || 'default'}`};
  }
  return result;
}
