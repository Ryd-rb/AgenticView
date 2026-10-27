import { z } from 'zod';

export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = z.string().max(131_072);
const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean(), z.null()]);
const tone = z.enum(['neutral', 'info', 'success', 'warning', 'error']);
const base = { id: idSchema, title: z.string().max(160) };
const entry = z.object({ time: z.string().max(80).optional(), level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), message: z.string().max(16_384), source: z.string().max(160).optional() });
const event = z.object({ time: z.string().max(80).optional(), title: z.string().max(200), detail: z.string().max(8_192).optional(), tone: tone.optional() });
export const componentSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('metric'), data: z.object({ value: scalar, unit: z.string().max(80).optional(), change: z.string().max(160).optional(), history: z.array(z.number().finite()).max(512).optional(), tone: tone.optional() }) }),
  z.object({ ...base, kind: z.literal('chart'), data: z.object({ type: z.enum(['line', 'area', 'bar', 'scatter']).default('line'), series: z.array(z.object({ name: z.string().max(100), points: z.array(z.object({ x: z.union([z.string().max(100), z.number().finite()]), y: z.number().finite() })).max(2_048) })).max(12), xLabel: z.string().max(100).optional(), yLabel: z.string().max(100).optional() }) }),
  z.object({ ...base, kind: z.literal('table'), data: z.object({ columns: z.array(z.object({ key: idSchema, label: z.string().max(100) })).min(1).max(64), rows: z.array(z.record(z.string().max(100), scalar)).max(2_000), totalRows: z.number().int().nonnegative().optional() }) }),
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
]);
export type Component = z.infer<typeof componentSchema>;
export type Layout = { x: number; y: number; width: number; height: number; locked: boolean; z: number; sizing?: 'content' | 'fixed'; automatic?: boolean };
export type AgentStatus = 'active' | 'stale' | 'completed' | 'error';
export type AgentView = {
  id: string; agentId: string; name: string; role: string; context: string;
  parentId: string | null; createdAt: number; lastSeen: number; status: AgentStatus;
  sequence: number; components: Record<string, Component>; layout: Layout;
};
export const settingsSchema = z.object({
  staleSeconds: z.number().int().min(15).max(86_400).default(45),
  autoArchiveMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
  archiveAfterCompletion: z.boolean().default(false),
  trustedEmbeds: z.boolean().default(true),
  reducedMotion: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Stats = { active: number; stale: number; archived: number; updates: number; updatesPerSecond: number };
export type Snapshot = { revision: number; agents: AgentView[]; settings: Settings; stats: Stats };
export type AgentChange = { id: string; meta?: Omit<AgentView, 'components'>; components?: Component[]; removeComponents?: string[]; clear?: boolean };
export type Patch = { revision: number; changes: AgentChange[]; removed: string[]; settings?: Settings; stats: Stats };
export type ArchiveSummary = { id: string; name: string; agentId: string; role: string; parentId: string | null; status: AgentStatus; archivedAt: number; bytes: number; rawBytes: number };
export const registerSchema = z.object({
  requestId: idSchema,
  registrationKey: z.string().min(32).max(256).describe('Private random recovery secret. Generate locally and never include in display content.'),
  agentId: idSchema,
  name: z.string().min(1).max(160),
  role: z.string().max(160).default('Agent'),
  context: z.string().max(8_192).default(''),
  parentId: idSchema.optional(), parentToken: z.string().max(256).optional(),
});
export type RegisterInput = z.input<typeof registerSchema>;
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), component: componentSchema }),
  z.object({ op: z.literal('remove'), componentId: idSchema }),
  z.object({ op: z.literal('clear') }),
  z.object({ op: z.literal('append'), componentId: idSchema, items: z.array(z.json()).min(1).max(512) }),
  z.object({ op: z.literal('context'), text: z.string().max(8_192) }),
  z.object({ op: z.literal('status'), status: z.enum(['active', 'completed', 'error']) }),
]);
export type Operation = z.infer<typeof operationSchema>;
export const publishSchema = z.object({ sequence: z.number().int().positive(), operations: z.array(operationSchema).min(1).max(256) });
export const layoutSchema = z.object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7), width: z.number().min(320).max(1_600), height: z.number().min(240).max(1_600), locked: z.boolean(), z: z.number().int().min(0).max(1e9), sizing: z.enum(['content', 'fixed']).default('fixed'), automatic: z.boolean().optional() });
