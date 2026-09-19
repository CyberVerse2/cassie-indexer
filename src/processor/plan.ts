import { z } from 'zod';
import { generateQwenJson } from '../util/qwen';
import type { ExtractedIdea } from './extract';
import { checkRoute } from '../venues/definitive';
const durations:Record<string,number>={immediate:3,'short-term':28,'medium-term':180,'long-term':365,unspecified:7};
export function researchExpiry(postedAt:Date,horizon:string){return new Date(postedAt.getTime()+(durations[horizon]??7)*86400000);}
export function validatePlan(plan:any,entry:number){
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(plan.stopPrice)||plan.stopPrice<=0||plan.stopPrice>=entry)throw Error('Invalid protective stop.');
  if(!Array.isArray(plan.targets)||plan.targets.length<1||plan.targets.length>3)throw Error('Invalid exit schedule.');
  let previous=entry,total=0;
  for(const target of plan.targets){if(!Number.isFinite(target.price)||target.price<=previous||!Number.isInteger(target.percent)||target.percent<=0)throw Error('Invalid staged exit.');previous=target.price;total+=target.percent;}
  if(total!==100)throw Error('Exit allocations must total 100%.');
  if(!Number.isFinite(plan.trailingStopPct)||plan.trailingStopPct<0||plan.trailingStopPct>30)throw Error('Invalid trailing stop.');
  if(!Number.isFinite(plan.breakevenAtPct)||plan.breakevenAtPct<0||plan.breakevenAtPct>100)throw Error('Invalid breakeven trigger.');
  return plan;
}
export function plannerPayload(idea:ExtractedIdea,asset:any,entryPrice:number,expiresAt:Date){
  const shares=asset.kind==='shares';
  return {
    thesis:idea.thesis,evidence:idea.reasoning,quotes:idea.quotes,horizon:idea.horizon,
    authorTarget:idea.target,authorInvalidation:idea.invalidation,entryPrice,expiresAt,
    asset:{ticker:asset.ticker,symbol:asset.symbol,kind:asset.kind,chain:asset.chain,issuer:asset.issuer??null,address:asset.address},
    role:shares
      ?'This verified token is the onchain expression of the listed stock. The company thesis is sufficient evidence. Write every price in USD per token using entryPrice.'
      :'This verified token is a spot asset. The thesis must support this token. Write every price in USD per token using entryPrice.',
  };
}
const planSystem=`You write Cassie's long plan for one verified token. Return JSON only.

Units: every price is USD per 1 unit of the supplied token. entryPrice is the executable token price. Never paste an author's share-dollar or index level as a token price. If the author stated a share price or a percent move, apply that same relative move to entryPrice.

Shares vs spot:
- kind=shares: accept the equity/company thesis. Do not require NAV, peg, wrapper premium, issuer solvency, or token-only microstructure. Do not refuse because the author discussed the company rather than the wrapper.
- kind=spot: the thesis must be about this token.

Refuse with ready=false only when:
1. The thesis is not about this asset's company or token.
2. The idea cannot support a long with a stop below entryPrice.
Do not refuse for a long horizon, missing technicals, or missing token-wrapper data.

When ready=true: stopPrice < entryPrice; 1-3 ascending targets above entryPrice; percents total 100; invalidation is Cassie's exit condition; trailingStopPct 0-30 (0 disables); breakevenAtPct 0-100 (0 disables). These numbers only reduce size or tighten the stop. reason explains Cassie's risk/reward in token USD and does not attribute the plan to the author.

Example ready shares:
{"ready":true,"reason":"NVDAc is the verified NVDA share token. Entry 220 token USD. Stop 198 (10% below) if data-center demand fades. Scale out 50% at 242 and 50% at 275.","stopPrice":198,"targets":[{"price":242,"percent":50},{"price":275,"percent":50}],"invalidation":"Exit if the NVDA demand thesis breaks.","trailingStopPct":8,"breakevenAtPct":10}

Example refuse:
{"ready":false,"reason":"The thesis is about OpenAI, not Microsoft.","stopPrice":null,"targets":[],"invalidation":"","trailingStopPct":0,"breakevenAtPct":0}`;
export async function preparePlan(idea:ExtractedIdea,asset:any,postedAt:Date){
  const expiresAt=researchExpiry(postedAt,idea.horizon);
  if(expiresAt.getTime()<=Date.now())throw Error('This research has expired.');
  const availability=await checkRoute(asset);
  const result=await generateQwenJson({
    system:planSystem,
    content:JSON.stringify(plannerPayload(idea,asset,availability.entryPrice,expiresAt)),
    schema:z.object({ready:z.boolean(),reason:z.string(),stopPrice:z.number().positive().nullable().optional(),targets:z.array(z.object({price:z.number().positive(),percent:z.number().int().min(1).max(100)})).max(3).default([]),invalidation:z.string().default(''),trailingStopPct:z.number().min(0).max(30).default(0),breakevenAtPct:z.number().min(0).max(100).default(0)}),maxTokens:1600,
  });
  if(!result.ready)throw Error(result.reason);
  validatePlan(result,availability.entryPrice);
  return {...result,version:1,basis:'cassie',priceBasis:'token',entryPrice:availability.entryPrice,assetKey:asset.chain+':'+asset.address.toLowerCase(),createdAt:new Date().toISOString(),expiresAt:expiresAt.toISOString(),availability};
}
