import { z } from 'zod';
import { controlMapSchema } from './control-presentation.js';

export const componentLayoutSchema = z.strictObject({ mode:z.enum(['auto','vertical','columns']).optional(), columns:z.number().int().min(1).max(8).optional(), minWidth:z.number().int().min(200).max(1000).optional(), gap:z.number().int().min(0).max(32).optional() });
export const cardDisplaySchema = z.strictObject({ chrome:controlMapSchema.optional(), componentLayout:componentLayoutSchema.optional() });
export type ComponentLayout = z.infer<typeof componentLayoutSchema>;
export type CardDisplay = z.infer<typeof cardDisplaySchema>;
