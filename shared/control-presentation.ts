import { z } from 'zod';

export const controlIds = ['configure', 'header', 'footer', 'title', 'role', 'context', 'agentId', 'times', 'status', 'fit', 'lock', 'collapse', 'archive', 'resize', 'navigation', 'zoomIn', 'zoomOut', 'resetView', 'deactivate', 'scale', 'caption', 'filter', 'refresh', 'add', 'edit', 'delete', 'history', 'evaluate', 'bulk', 'columns', 'pagination', 'legend', 'dataTable', 'stepSelect', 'expand', 'save', 'cancel'] as const;
export const controlIdSchema = z.enum(controlIds);
export const controlPresentationSchema = z.strictObject({
  visible: z.boolean().optional(), label: z.string().max(160).optional(), tooltip: z.string().max(2000).optional(),
  appearance: z.enum(['icon', 'text', 'both']).optional(), variant: z.enum(['quiet', 'primary']).optional(),
  placement: z.enum(['header', 'footer', 'top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  mode: z.enum(['disclosure', 'panel']).optional(), initiallyOpen: z.boolean().optional(),
});
// Optional strict properties retain a useful input JSON schema and reject raw
// __proto__ keys, which Zod intentionally drops while decoding records.
const controlShape = Object.fromEntries(controlIds.map(id => [id, controlPresentationSchema.optional()])) as { [Id in typeof controlIds[number]]: z.ZodOptional<typeof controlPresentationSchema> };
export const controlMapSchema = z.strictObject(controlShape);
export type ControlId = z.infer<typeof controlIdSchema>;
export type ControlPresentation = z.infer<typeof controlPresentationSchema>;
export type ControlMap = z.infer<typeof controlMapSchema>;
/** Presentation only: callers must enforce their existing permission and feature ceilings. */
export function control(map: ControlMap | undefined, id: ControlId, defaults: ControlPresentation = {}): ControlPresentation {
  return { ...defaults, ...map?.[id] };
}
