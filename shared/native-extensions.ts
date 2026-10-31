import { z } from 'zod';

// This module deliberately does not import protocol: protocol composes these schemas.
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const tone = z.enum(['neutral', 'info', 'success', 'warning', 'error']);
const number = z.number().finite();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six digit hex color');
const unique = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
export const numberFormatSchema = z.strictObject({ style: z.enum(['number', 'percent', 'compact']).optional(), decimals: z.number().int().min(0).max(8).optional(), prefix: z.string().max(24).optional(), suffix: z.string().max(24).optional() });
export const chartAxisSchema = z.strictObject({ label: z.string().max(100).optional(), min: number.optional(), max: number.optional(), includeZero: z.boolean().optional(), visible: z.boolean().optional(), grid: z.boolean().optional(), ticks: z.number().int().min(2).max(10).optional(), format: numberFormatSchema.optional() }).refine(axis => axis.min === undefined || axis.max === undefined || axis.max > axis.min, 'Axis max must exceed min');
const condition = z.strictObject({ operator: z.enum(['lt', 'lte', 'gt', 'gte', 'eq', 'between']), value: number, upper: number.optional() }).refine(c => c.operator !== 'between' || c.upper !== undefined && c.upper >= c.value, 'Between conditions require an upper bound at least equal to value');
const annotation = z.strictObject({ id, axis: z.enum(['x', 'y']), value: number, end: number.optional(), label: z.string().max(160).optional(), color: color.optional(), dash: z.enum(['solid', 'dashed', 'dotted']).optional() }).refine(a => a.end === undefined || a.end >= a.value, 'Band end must not precede value');
export const chartOptionsSchema = z.strictObject({
  xAxis: chartAxisSchema.optional(), yAxis: chartAxisSchema.optional(),
  legend: z.boolean().optional(), markers: z.boolean().optional(), tooltips: z.boolean().optional(), labels: z.boolean().optional(),
  labelWhen: condition.optional(), tooltipWhen: condition.optional(),
  annotations: z.array(annotation).max(32).refine(unique, 'Annotation IDs must be unique').optional(),
  features: z.strictObject({ seriesToggle: z.boolean().optional(), dataTable: z.boolean().optional() }).optional(),
});
const chartInstant=z.number().finite().int().min(0).max(8_640_000_000_000_000);
export const chartSourceSchema=z.strictObject({readAction:id,windowMs:z.number().int().min(1000).max(86_400_000).optional(),from:chartInstant.optional(),to:chartInstant.optional(),maxPoints:z.number().int().min(32).max(2048).optional(),pollMs:z.number().int().min(250).max(60_000).optional()}).superRefine((source,ctx)=>{if((source.from===undefined)!==(source.to===undefined)||source.from!==undefined&&source.to!<=source.from)ctx.addIssue({code:'custom',message:'Supply both ordered time bounds or omit both for a rolling window'});});
export const chartDataSchema = z.strictObject({
  type: z.enum(['line', 'area', 'bar', 'scatter']).default('line'),
  series: z.array(z.strictObject({ name: z.string().max(100), id: id.optional(), type: z.enum(['line', 'area', 'bar', 'scatter']).optional(), color: color.optional(), dash: z.enum(['solid', 'dashed', 'dotted']).optional(), width: number.min(1).max(6).optional(), marker: z.enum(['none', 'circle', 'square', 'diamond']).optional(), hidden: z.boolean().optional(), points: z.array(z.strictObject({ x: z.union([z.string().max(100), number]), y: number, label: z.string().max(160).optional() })).max(2048) })).max(12),
  xLabel: z.string().max(100).optional(), yLabel: z.string().max(100).optional(), options: chartOptionsSchema.optional(), source:chartSourceSchema.optional(),
}).superRefine((data, ctx) => {
  const ids = data.series.filter(s => s.id !== undefined).map(s => s.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Series IDs must be unique' });
  const numeric = data.series.every(s => s.points.every(p => typeof p.x === 'number'));
  if (!numeric && (data.options?.xAxis?.min !== undefined || data.options?.xAxis?.max !== undefined || data.options?.annotations?.some(a => a.axis === 'x'))) ctx.addIssue({ code: 'custom', message: 'X domains and annotations require numeric x values' });
});
export type ChartData = z.infer<typeof chartDataSchema>;
export type NumberFormat = z.infer<typeof numberFormatSchema>;
export type ChartCondition = z.infer<typeof condition>;

export const stepperDataSchema = z.strictObject({
  items: z.array(z.strictObject({ id, label: z.string().max(200), state: z.enum(['pending', 'active', 'completed', 'blocked', 'skipped']), detail: z.string().max(8192).optional() })).max(100).refine(unique, 'Step IDs must be unique'),
  selectedId: id.optional(), orientation: z.enum(['vertical', 'horizontal']).optional(), features: z.strictObject({ select: z.boolean().optional() }).optional(),
}).refine(data => data.selectedId === undefined || data.items.some(item => item.id === data.selectedId), 'Selected step must exist');
export const bulletDataSchema = z.strictObject({
  value: number, min: number.default(0), max: number.default(100), target: number.optional(), unit: z.string().max(80).optional(), label: z.string().max(200).optional(), format: numberFormatSchema.optional(),
  ranges: z.array(z.strictObject({ id, end: number, label: z.string().max(160), tone: tone.optional() })).max(12).refine(unique, 'Range IDs must be unique').optional(),
}).superRefine((data, ctx) => {
  if (data.max <= data.min) ctx.addIssue({ code: 'custom', message: 'Bullet max must exceed min' });
  let previous = data.min;
  for (const range of data.ranges ?? []) { if (range.end <= previous || range.end > data.max) ctx.addIssue({ code: 'custom', message: 'Range ends must increase within the declared domain' }); previous = range.end; }
});
export const accordionDataSchema = z.strictObject({
  sections: z.array(z.strictObject({ id, title: z.string().max(200), text: z.string().max(16384), tone: tone.optional(), open: z.boolean().optional() })).max(100).refine(unique, 'Section IDs must be unique'),
  multiple: z.boolean().optional(), features: z.strictObject({ expand: z.boolean().optional() }).optional(),
}).refine(data => data.multiple !== false || data.sections.filter(section => section.open).length <= 1, 'Single expansion accordions allow at most one initially open section');
const base = { id, title: z.string().max(160) };
export const stepperComponentSchema = z.object({ ...base, kind: z.literal('stepper'), data: stepperDataSchema });
export const bulletComponentSchema = z.object({ ...base, kind: z.literal('bullet'), data: bulletDataSchema });
export const accordionComponentSchema = z.object({ ...base, kind: z.literal('accordion'), data: accordionDataSchema });
export const additionalComponentSchemas = [stepperComponentSchema, bulletComponentSchema, accordionComponentSchema] as const;
export type AdditionalComponent = z.infer<typeof stepperComponentSchema> | z.infer<typeof bulletComponentSchema> | z.infer<typeof accordionComponentSchema>;

export function matchesChartCondition(value: number, condition?: ChartCondition): boolean {
  if (!condition) return true;
  switch (condition.operator) { case 'lt': return value < condition.value; case 'lte': return value <= condition.value; case 'gt': return value > condition.value; case 'gte': return value >= condition.value; case 'eq': return value === condition.value; case 'between': return value >= condition.value && value <= condition.upper!; }
}
const nativeFormatters=new Map<string,Intl.NumberFormat>();
export function formatNativeNumber(value: number, format?: NumberFormat): string {
  const percent = format?.style === 'percent';
  const style=percent?'percent':format?.style==='compact'?'compact':'number',decimals=format?.decimals;
  const valid=decimals===undefined||Number.isInteger(decimals)&&decimals>=0&&decimals<=8,key=style+':'+(decimals??'auto');
  let formatter=valid?nativeFormatters.get(key):undefined;
  if(!formatter){formatter=new Intl.NumberFormat('en',{style:percent?'percent':'decimal',notation:style==='compact'?'compact':'standard',maximumFractionDigits:decimals??2,minimumFractionDigits:decimals});if(valid)nativeFormatters.set(key,formatter);}
  const rendered = formatter.format(value);
  return `${format?.prefix ?? ''}${rendered}${format?.suffix ?? ''}`;
}
/** Normalize before subtraction so finite extreme domains cannot overflow. */
export function domainFraction(value: number, min: number, max: number): number {
  const scale = Math.max(Math.abs(min), Math.abs(max), Math.abs(value), Number.MIN_VALUE);
  return Math.max(0, Math.min(1, (value / scale - min / scale) / (max / scale - min / scale || 1)));
}
