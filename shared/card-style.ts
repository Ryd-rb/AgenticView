import { z } from 'zod';
export const cardIconNames=['status','signal','bot','terminal','code','database','server','search','shield','flask','gamepad','git-branch','bug','activity','network','workflow','cpu','globe','file','folder','chart','layers','sparkles','wrench','rocket','clock','check','alert','book','zap','lock','unlock','play','pause','power','plus','minus','save','trash','settings','refresh','copy','download','upload','eye','eye-off','send','user','menu','close'] as const;
export const cardStyleSchema=z.object({icon:z.enum(cardIconNames)});
export type CardIconName=typeof cardIconNames[number];
const iconColor=z.string().length(7).regex(/^#[0-9a-fA-F]{6}$/);
export const windowIconSchema=z.strictObject({icon:z.enum(cardIconNames),color:iconColor.optional(),background:iconColor.optional()});
export type WindowIcon=z.infer<typeof windowIconSchema>;
export const cardAppearanceSchema=z.strictObject({icon:cardStyleSchema.shape.icon.optional(),windowIcon:windowIconSchema.nullable().optional()}).refine(value=>value.icon!==undefined||value.windowIcon!==undefined,'Supply a header icon or window icon');
