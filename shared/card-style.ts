import { z } from 'zod';
export const cardIconNames=['status','signal','bot','terminal','code','database','server','search','shield','flask','gamepad','git-branch','bug','activity','network','workflow','cpu','globe','file','folder','chart','layers','sparkles','wrench','rocket','clock','check','alert','book','zap','lock','unlock','play','pause','power','plus','minus','save','trash','settings','refresh','copy','download','upload','eye','eye-off','send','user','menu','close'] as const;
export const cardStyleSchema=z.object({icon:z.enum(cardIconNames)});
export type CardIconName=typeof cardIconNames[number];
