import { controlMapSchema, type ControlMap } from './control-presentation.js';
import { componentLayoutSchema, type ComponentLayout } from './card-display.js';
import { cardShortcutsSchema } from './card-shortcuts.js';
import { z } from 'zod';
import { chartDataSchema, bulletComponentSchema, stepperComponentSchema, accordionComponentSchema } from './native-extensions.js';
import { configurationSchema } from './component-config.js';
import { executionDataSchema } from './execution-workbench.js';
import { controlPresentationSchema } from './control-presentation.js';
import { gridDataSchema } from './grid-config.js';
import {cardStyleSchema,type CardIconName} from './card-style.js';

export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = z.string().max(131_072);
const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean(), z.null()]);
const tone = z.enum(['neutral', 'info', 'success', 'warning', 'error']);
const base = { id: idSchema, title: z.string().max(160), configuration: configurationSchema.optional() };
const entry = z.object({ time: z.string().max(80).optional(), level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), message: z.string().max(16_384), source: z.string().max(160).optional() });
const event = z.object({ time: z.string().max(80).optional(), title: z.string().max(200), detail: z.string().max(8_192).optional(), tone: tone.optional() });
const columns = z.array(z.object({ key: idSchema, label: z.string().max(100) })).max(64);
const rows = z.array(z.record(z.string().max(100), scalar)).max(2_000);
const checklistItems = z.array(z.object({ id: idSchema, label: z.string().max(500), status: z.enum(['pending', 'active', 'completed', 'blocked']), detail: z.string().max(2_000).optional() })).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Checklist IDs must be unique').describe('Task IDs must be unique and remain stable across updates.');
const heatmapData = z.object({ columns: z.array(z.string().max(100)).min(1).max(32), rows: z.array(z.string().max(100)).min(1).max(64), cells: z.array(z.object({ row: z.number().int().min(0).max(63), column: z.number().int().min(0).max(31), value: z.number().finite() })).max(2_048), unit: z.string().max(80).optional() }).superRefine((data, context) => {
  const seen = new Set<string>();
  for (const cell of data.cells) { const key = `${cell.row}:${cell.column}`; if (cell.row >= data.rows.length || cell.column >= data.columns.length || seen.has(key)) context.addIssue({ code: 'custom', message: 'Heatmap coordinates must be unique and fit the declared dimensions' }); seen.add(key); }
}).describe('Cell coordinates must be unique and fit the declared row and column dimensions.');
const traceData = z.object({ spans: z.array(z.object({ id: idSchema, parentId: idSchema.optional(), name: z.string().max(200), startMs: z.number().finite().nonnegative(), durationMs: z.number().finite().nonnegative(), status: z.enum(['active', 'success', 'error']).default('success') })).max(500) }).superRefine((data, context) => {
  const parents = new Map(data.spans.map(span => [span.id, span.parentId]));
  if (parents.size !== data.spans.length) context.addIssue({ code: 'custom', message: 'Trace span IDs must be unique' });
  for (const span of data.spans) { const seen = new Set<string>(); let id: string | undefined = span.id; while (id !== undefined) { if (seen.has(id) || !parents.has(id)) { context.addIssue({ code: 'custom', message: 'Trace parents must exist and be acyclic' }); break; } seen.add(id); id = parents.get(id); } }
}).describe('Span IDs must be unique; every parent must exist and the parent graph must be acyclic.');
const publicLink = z.string().max(2_048).refine(value => { try { const url = new URL(value); return !/\s/.test(value) && /^https?:\/\//i.test(value) && !/^https?:\/\/[^/?#]*@/i.test(value) && ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; } }, 'Links must use HTTP(S) without user information').describe('Absolute HTTP(S) URL without user information.');
const serviceMapData = z.object({ nodes: z.array(z.object({ id: idSchema, label: z.string().max(200), state: z.enum(['active', 'success', 'warning', 'error', 'idle']).optional(), detail: z.string().max(1_000).optional() })).max(100), edges: z.array(z.object({ from: idSchema, to: idSchema, label: z.string().max(160).optional() })).max(200) }).superRefine((data, context) => {
  const ids = new Set(data.nodes.map(node => node.id));
  if (ids.size !== data.nodes.length || data.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) context.addIssue({ code: 'custom', message: 'Service node IDs must be unique and edge endpoints must exist' });
}).describe('Service node IDs are unique and all edge endpoints refer to declared nodes; cycles are allowed.');
const resultItems = z.array(z.object({ id: idSchema, label: z.string().max(500), state: z.enum(['passed', 'failed', 'skipped', 'running', 'pending']), durationMs: z.number().finite().nonnegative().optional(), detail: z.string().max(8_192).optional() })).max(1_000).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Test IDs must be unique');
const instant = z.number().finite().min(0).max(8_640_000_000_000_000);
const ganttItems = z.array(z.object({ id: idSchema, label: z.string().max(200), start: instant, end: instant.optional(), group: z.string().max(160).optional(), tone: tone.optional() }).refine(item => item.end === undefined || item.end >= item.start, 'Timeline end must not precede start')).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Timeline IDs must be unique');
export const componentSchema = z.discriminatedUnion('kind', [
  z.object({...base,kind:z.literal('execution-workbench'),data:executionDataSchema}),
  bulletComponentSchema.extend({configuration:configurationSchema.optional()}),
  stepperComponentSchema.extend({configuration:configurationSchema.optional()}),
  accordionComponentSchema.extend({configuration:configurationSchema.optional()}),
  z.object({ ...base, kind: z.literal('session-launcher'), data: z.object({ actionId: idSchema, label: z.string().max(160).optional() }) }),
  z.object({ ...base, kind: z.literal('agent-session'), data: z.object({ sessionId: idSchema }) }),
  z.object({ ...base, kind: z.literal('action-panel'), data: z.object({ actionIds: z.array(idSchema).min(1).max(64), layout: z.enum(['forms','inline']).optional(), buttons: z.array(z.strictObject({actionId:idSchema,...controlPresentationSchema.shape})).max(64).refine(buttons=>new Set(buttons.map(button=>button.actionId)).size===buttons.length,'Button action IDs must be unique').optional() }).refine(data => (data.buttons ?? []).every(button => data.actionIds.includes(button.actionId)), 'Button presentations must reference declared actions') }),
  z.object({ ...base, kind: z.literal('log-stream'), data: z.object({ actionId: idSchema, pollMs: z.number().int().min(500).max(60_000).optional(), maxRows: z.number().int().min(20).max(2_000).optional() }) }),
  z.object({ ...base, kind: z.literal('data-grid'), data: gridDataSchema }),
  z.object({ ...base, kind: z.literal('metric'), data: z.object({ value: scalar, unit: z.string().max(80).optional(), change: z.string().max(160).optional(), history: z.array(z.number().finite()).max(512).optional(), tone: tone.optional() }) }),
  z.object({ ...base, kind: z.literal('chart'), data: chartDataSchema }),
  z.object({ ...base, kind: z.literal('table'), data: z.object({ columns: z.array(z.object({ key: idSchema, label: z.string().max(100) })).min(1).max(64), rows: z.array(z.record(z.string().max(100), scalar)).max(2_000), totalRows: z.number().int().nonnegative().optional(), sourceAction: idSchema.optional(), pageSize: z.number().int().min(1).max(200).optional() }) }),
  z.object({ ...base, kind: z.literal('markdown'), data: z.object({ text }) }),
  z.object({ ...base, kind: z.literal('code'), data: z.object({ code: text, language: z.string().max(40).optional() }) }),
  z.object({ ...base, kind: z.literal('diff'), data: z.object({ before: text, after: text, language: z.string().max(40).optional() }) }),
  z.object({ ...base, kind: z.literal('logs'), data: z.object({ entries: z.array(entry).max(2_000) }) }),
  z.object({ ...base, kind: z.literal('timeline'), data: z.object({ events: z.array(event).max(1_000) }) }),
  z.object({ ...base, kind: z.literal('progress'), data: z.object({ value: z.number().finite().nonnegative(), max: z.number().positive().default(100), label: z.string().max(200).optional() }) }),
  z.object({ ...base, kind: z.literal('keyvalue'), data: z.object({ items: z.array(z.object({ key: z.string().max(160), value: scalar })).max(200) }) }),
  z.object({ ...base, kind: z.literal('json'), data: z.object({ value: z.json() }) }),
  z.object({ ...base, kind: z.literal('tree'), data: z.object({ nodes: z.array(z.object({ id: idSchema, label: z.string().max(200), parentId: idSchema.optional(), detail: z.string().max(1_000).optional() })).max(1_000) }) }),
  z.object({ ...base, kind: z.literal('status'), data: z.object({ label: z.string().max(200), state: z.enum(['active', 'success', 'warning', 'error', 'idle']), detail: z.string().max(2_000).optional() }) }),
  z.object({ ...base, kind: z.literal('embed'), data: z.object({ html: z.string().max(524_288), height: z.number().int().min(120).max(1_200).default(300), state: z.json().optional() }) }),
  z.object({ ...base, kind: z.literal('stat-grid'), data: z.object({ items: z.array(z.object({ label: z.string().max(160), value: scalar, unit: z.string().max(80).optional(), change: z.string().max(160).optional(), tone: tone.optional() })).max(24) }) }),
  z.object({ ...base, kind: z.literal('checklist'), data: z.object({ items: checklistItems }) }),
  z.object({ ...base, kind: z.literal('bar-list'), data: z.object({ items: z.array(z.object({ label: z.string().max(200), value: z.number().finite().nonnegative(), tone: tone.optional() })).max(100), unit: z.string().max(80).optional() }) }),
  z.object({ ...base, kind: z.literal('histogram'), data: z.object({ buckets: z.array(z.object({ label: z.string().max(100), count: z.number().int().nonnegative() })).max(100), unit: z.string().max(80).optional() }) }),
  z.object({ ...base, kind: z.literal('heatmap'), data: heatmapData }),
  z.object({ ...base, kind: z.literal('gauge'), data: z.object({ value: z.number().finite(), min: z.number().finite().default(0), max: z.number().finite().default(100), unit: z.string().max(80).optional(), label: z.string().max(200).optional() }).refine(data => data.max > data.min, 'Gauge max must exceed min') }),
  z.object({ ...base, kind: z.literal('query'), data: z.object({ query: text, language: z.string().max(40).default('sql'), source: z.string().max(160).optional(), state: z.enum(['running', 'success', 'error']).default('running'), error: z.string().max(8_192).optional(), durationMs: z.number().finite().nonnegative().optional(), totalRows: z.number().int().nonnegative().optional(), columns: columns.default([]), rows: rows.default([]) }).refine(data => data.rows.length === 0 || data.columns.length > 0, 'Query rows require columns') }),
  z.object({ ...base, kind: z.literal('command'), data: z.object({ command: text, shell: z.string().max(40).optional(), directory: z.string().max(1_000).optional(), output: text.optional(), exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(), durationMs: z.number().finite().nonnegative().optional() }) }),
  z.object({ ...base, kind: z.literal('trace'), data: traceData }),
  z.object({ ...base, kind: z.literal('alert'), data: z.object({ tone: tone.default('info'), message: z.string().max(8_192), detail: text.optional() }) }),
  z.object({ ...base, kind: z.literal('links'), data: z.object({ items: z.array(z.object({ label: z.string().max(200), url: publicLink, description: z.string().max(1_000).optional() })).max(100) }) }),
  z.object({ ...base, kind: z.literal('comparison'), data: z.object({ items: z.array(z.object({ label: z.string().max(200), before: scalar, after: scalar })).max(100) }) }),
  z.object({ ...base, kind: z.literal('service-map'), data: serviceMapData }),
  z.object({ ...base, kind: z.literal('http'), data: z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), url: publicLink, statusCode: z.number().int().min(100).max(599).optional(), durationMs: z.number().finite().nonnegative().optional(), requestBody: text.optional(), responseBody: text.optional() }) }),
  z.object({ ...base, kind: z.literal('stacktrace'), data: z.object({ exception: z.string().max(200).optional(), message: z.string().max(8_192).optional(), frames: z.array(z.object({ method: z.string().max(1_000), file: z.string().max(1_000).optional(), line: z.number().int().positive().optional(), module: z.string().max(200).optional() })).max(1_000) }) }),
  z.object({ ...base, kind: z.literal('test-results'), data: z.object({ items: resultItems }) }),
  z.object({ ...base, kind: z.literal('gantt'), data: z.object({ items: ganttItems }) }),
  z.object({ ...base, kind: z.literal('breakdown'), data: z.object({ items: z.array(z.object({ label: z.string().max(200), value: z.number().finite().nonnegative(), tone: tone.optional() })).max(100), unit: z.string().max(80).optional() }) }),
]).superRefine((component,ctx)=>{
  const collection=component.configuration?.collection;
  if(collection && component.kind==='execution-workbench')ctx.addIssue({code:'custom',message:'Execution hierarchy uses its own scoped filtering'});
  if(collection) {
    const source=(component.data as Record<string,unknown>)[collection.field];
    if(!Array.isArray(source)||source.some(item=>item===null||typeof item!=='object'||Array.isArray(item)))ctx.addIssue({code:'custom',message:'Collection settings require an existing object collection'});
  }
});
export type Component = z.infer<typeof componentSchema>;
export type Layout = { x: number; y: number; width: number; height: number; locked: boolean; z: number; sizing?: 'content' | 'fixed'; automatic?: boolean };
export type AgentStatus = 'active' | 'stale' | 'completed' | 'error';
export type TaskTiming = { key: string; line: number; firstSeenAt: number; startedAt?: number; completedAt?: number; updatedAt: number };
export type AgentView = {
  chrome?:ControlMap;componentLayout?:ComponentLayout;
  id: string; agentId: string; name: string; role: string; context: string;
  parentId: string | null; createdAt: number; lastSeen: number; status: AgentStatus; icon?: CardIconName;
  updatedAt?: number; completedAt?: number; componentTimes?: Record<string, number>;
  taskTimes?: Record<string, TaskTiming[]>;
  application?: { name: string; description?: string };
  managedSessionId?: string; sessionId?: string; sessionProvider?: string; orphanComponentId?: string;
  sequence: number; components: Record<string, Component>; layout: Layout;
};
export const settingsSchema = z.object({
  cardShortcuts: cardShortcutsSchema.optional(),
  staleSeconds: z.number().int().min(15).max(86_400).default(45),
  autoArchiveMinutes: z.number().int().min(1).max(525_600).nullable().default(5),
  archiveAfterCompletion: z.boolean().default(true),
  trustedEmbeds: z.boolean().default(true),
  reducedMotion: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Stats = { active: number; stale: number; archived: number; updates: number; updatesPerSecond: number };
export type Snapshot = { revision: number; agents: AgentView[]; settings: Settings; stats: Stats };
export type AgentChange = { id: string; meta?: Omit<AgentView, 'components'>; components?: Component[]; removeComponents?: string[]; clear?: boolean };
export type Patch = { revision: number; changes: AgentChange[]; removed: string[]; settings?: Settings; stats: Stats };
export type ArchiveSummary = { id: string; name: string; agentId: string; role: string; parentId: string | null; status: AgentStatus; archivedAt: number; createdAt?: number; updatedAt?: number; completedAt?: number; bytes: number; rawBytes: number };
export const registerSchema = z.object({
  chrome:controlMapSchema.optional(),componentLayout:componentLayoutSchema.optional(),
  requestId: idSchema,
  registrationKey: z.string().min(32).max(256).describe('Private random recovery secret. Generate locally and never include in display content.'),
  agentId: idSchema,
  name: z.string().min(1).max(160),
  role: z.string().max(160).default('Agent'),
  context: z.string().max(8_192).default(''),
  icon:cardStyleSchema.shape.icon.optional(),
  sessionId: z.string().min(1).max(256).optional(), sessionProvider: z.string().min(1).max(80).optional(),
  parentId: idSchema.optional(), parentToken: z.string().max(256).optional(),
});
export type RegisterInput = z.input<typeof registerSchema>;
export const operationSchema = z.discriminatedUnion('op', [
  z.object({op:z.literal('style'),icon:cardStyleSchema.shape.icon}),
  z.object({ op: z.literal('upsert'), component: componentSchema }),
  z.object({ op: z.literal('remove'), componentId: idSchema }),
  z.object({ op: z.literal('clear') }),
  z.object({ op: z.literal('append'), componentId: idSchema, items: z.array(z.json()).min(1).max(512) }),
  z.object({ op: z.literal('context'), text: z.string().max(8_192) }),
  z.object({ op: z.literal('status'), status: z.enum(['active', 'completed', 'error']) }),
]);
export type Operation = z.infer<typeof operationSchema>;
export const publishSchema = z.object({ sequence: z.number().int().positive(), operations: z.array(operationSchema).min(1).max(256) });
export const layoutSchema = z.object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7), width: z.number().min(320).max(1_600), height: z.number().min(240).max(100_000), locked: z.boolean(), z: z.number().int().min(0).max(1e9), sizing: z.enum(['content', 'fixed']).default('fixed'), automatic: z.boolean().optional() }).refine(layout => layout.sizing === 'content' || layout.height <= 1600, { message: 'Fixed height exceeds 1600', path: ['height'] });
