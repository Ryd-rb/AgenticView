import { controlMapSchema } from './control-presentation.js';
import { z } from 'zod';

const reserved = new Set(['__proto__', 'prototype', 'constructor']);
export const fieldPath = z.string().min(1).max(160).refine(path => path.split('.').length <= 8 && path.split('.').every(part => /^[a-zA-Z0-9_-]+$/.test(part) && !reserved.has(part)), 'Use a bounded field path without reserved names');
export const configScalar = z.union([z.string().max(16384), z.number().finite(), z.boolean(), z.null()]);
export const conditionAtomSchema = z.strictObject({ field: fieldPath, op: z.enum(['eq','ne','in','not-in','gt','gte','lt','lte','contains','starts-with','empty','not-empty']), value: configScalar.optional(), values: z.array(configScalar).max(100).optional() }).superRefine((rule,ctx)=>{if(['in','not-in'].includes(rule.op) && !rule.values)ctx.addIssue({code:'custom',message:'This operator requires values'});if(!['in','not-in','empty','not-empty'].includes(rule.op) && !Object.hasOwn(rule,'value'))ctx.addIssue({code:'custom',message:'This operator requires value'});});
export const conditionSchema = z.strictObject({ all: z.array(conditionAtomSchema).max(32).optional(), any: z.array(conditionAtomSchema).max(32).optional(), none: z.array(conditionAtomSchema).max(32).optional() });
export type Condition = z.infer<typeof conditionSchema>;
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const presentationSchema = z.strictObject({ color: colorSchema.optional(), background: colorSchema.optional(), borderColor: colorSchema.optional(), emphasis: z.enum(['normal','bold','muted']).optional(), align: z.enum(['left','center','right']).optional(), density: z.enum(['compact','comfortable','spacious']).optional(), fontSize: z.number().int().min(12).max(24).optional() });
export const effectSchema = z.strictObject({ label: z.string().max(160).optional(), tooltip: z.string().max(2000).optional(), visible: z.boolean().optional(), presentation: presentationSchema.optional() });
export const configurationSchema = z.strictObject({
  controls:controlMapSchema.optional(),
  label: z.string().max(160).optional(), description: z.string().max(2000).optional(), tooltip: z.string().max(2000).optional(), visible: z.boolean().optional(), collapsed: z.boolean().optional(),
  presentation: presentationSchema.optional(), context: z.record(z.string().max(100), configScalar).optional(),
  rules: z.array(z.strictObject({ when: conditionSchema, effect: effectSchema })).max(64).optional(),
  collection: z.strictObject({ field: z.enum(['items','events','buckets','frames','entries','rows']), filter: conditionSchema.optional(), sortBy: fieldPath.optional(), descending: z.boolean().optional(), limit: z.number().int().min(1).max(2000).optional() }).optional(),
  manualFields: z.array(fieldPath.refine(path => path.startsWith('data.') || ['configuration.presentation','configuration.controls','configuration.rules','configuration.collection','configuration.label','configuration.description','configuration.tooltip','configuration.collapsed'].includes(path), 'Manual fields must name a data field or an editable presentation setting')).max(64).optional(),
});
export type Configuration = z.infer<typeof configurationSchema>;
export type Presentation = z.infer<typeof presentationSchema>;
export function fieldValue(source: unknown, path: string): unknown {
  if (!fieldPath.safeParse(path).success) return undefined;
  if(source && typeof source==='object' && Object.hasOwn(source,path)) return (source as Record<string,unknown>)[path];
  let current = source;
  for (const part of path.split('.')) { if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}
export function matches(condition: Condition | undefined, source: unknown): boolean {
  if (!condition) return true;
  const atom = (rule: z.infer<typeof conditionAtomSchema>) => {
    const value = fieldValue(source, rule.field), expected = rule.value;
    switch (rule.op) {
      case 'eq': return value === expected;
      case 'ne': return value !== expected;
      case 'in': return rule.values?.some(item => item === value) ?? false;
      case 'not-in': return !(rule.values?.some(item => item === value) ?? false);
      case 'empty': return value === undefined || value === null || value === '';
      case 'not-empty': return value !== undefined && value !== null && value !== '';
      case 'contains': return typeof value === 'string' && typeof expected === 'string' && value.includes(expected);
      case 'starts-with': return typeof value === 'string' && typeof expected === 'string' && value.startsWith(expected);
      default: { if (typeof value !== 'number' || typeof expected !== 'number') return false; return rule.op === 'gt' ? value > expected : rule.op === 'gte' ? value >= expected : rule.op === 'lt' ? value < expected : value <= expected; }
    }
  };
  return (!condition.all || condition.all.every(atom)) && (!condition.any || condition.any.some(atom)) && (!condition.none || !condition.none.some(atom));
}
export function resolveConfiguration(configuration: Configuration | undefined, data: unknown) {
  const result = { ...configuration, presentation: { ...configuration?.presentation } };
  for (const rule of configuration?.rules ?? []) if (matches(rule.when, { data, context: configuration?.context ?? {} })) { Object.assign(result, rule.effect, { presentation: { ...result.presentation, ...rule.effect.presentation } }); }
  return result;
}
export function configureCollection<T extends Record<string, unknown>>(data: T, configuration?: Configuration): T {
  const spec = configuration?.collection;
  if (!spec || !Array.isArray(data[spec.field])) return data;
  // Relational collections cannot be pruned without also repairing their references.
  if (['nodes','spans'].includes(spec.field)) return data;
  let items = (data[spec.field] as unknown[]).filter(item => matches(spec.filter, item));
  if (spec.sortBy) items = items.map((item, index) => ({ item, index })).sort((a,b) => { const left = fieldValue(a.item, spec.sortBy!), right = fieldValue(b.item, spec.sortBy!); const order = left === right ? 0 : left == null ? -1 : right == null ? 1 : typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right)); return (spec.descending ? -order : order) || a.index - b.index; }).map(entry => entry.item);
  return { ...data, [spec.field]: items.slice(0, spec.limit ?? 2000) };
}
