import {eq,desc} from 'drizzle-orm';
import {db,schema} from '../src/db/client';
import {routeIdea} from '../src/processor/route';
import {researchExpiry} from '../src/processor/plan';
const apply=process.argv.includes('--apply');
const limit=Number(process.argv.find(a=>a.startsWith('--limit='))?.split('=')[1]??100);
if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('Invalid limit.');
const {tradeIdeas,routes,routePricing}=schema;
const ideas=await db.select().from(tradeIdeas).where(eq(tradeIdeas.direction,'long')).orderBy(desc(tradeIdeas.postedAt)).limit(limit);
let routed=0,skipped=0,failed=0;
for(const row of ideas){
 if(researchExpiry(row.postedAt,row.horizon??'unspecified').getTime()<=Date.now()){skipped++;continue;}
 const existing=await db.select().from(routes).where(eq(routes.ideaId,row.id));
 if(existing.some(r=>r.venue==='definitive'&&(r.marketMeta as any)?.executionPlan?.version===1)){skipped++;continue;}
 if(!apply){console.log('eligible',row.id,row.candidateTickers);continue;}
 try{
 const decision=await routeIdea({thesis:row.thesis,reasoning:row.reasoning??[],subjects:row.subjects,direction:row.direction,stated_by_author:row.statedByAuthor??false,horizon:row.horizon??'unspecified',target:row.target,invalidation:row.invalidation,strategy:{exit:row.strategy?.exit,hold:row.strategy?.hold,stop_loss:row.strategy?.stopLoss,take_profit:row.strategy?.takeProfit},conviction:row.conviction??'medium',quotes:row.quotes,headline_quote:row.headlineQuote,asset_class:row.assetClass,context:row.context??'',candidate_tickers:row.candidateTickers} as any,row.postedAt);
 const c=decision.selected;
 await db.transaction(async tx=>{
 const values={status:decision.status,unroutedReason:decision.unroutedReason??null,venue:c?.venue??null,instrument:c?.instrument??null,ticker:c?.ticker??null,direction:c?.direction??null,tradeType:decision.tradeType??null,pipeline:decision.pipeline??null,alternatives:decision.alternatives,marketMeta:c?.marketMeta??null,routerVersion:'v3-definitive-evm'};
 const old=existing[0];
 const [route]=old?await tx.update(routes).set(values).where(eq(routes.id,old.id)).returning():await tx.insert(routes).values({ideaId:row.id,...values}).returning();
 await tx.insert(routePricing).values({routeId:route.id,currentPrice:c?.markPrice?.toString(),entryNote:'Token price history is not available for the original post.'}).onConflictDoUpdate({target:routePricing.routeId,set:{entryPrice:null,sincePostedPct:null,currentPrice:c?.markPrice?.toString()??null,currentPricedAt:new Date(),entryNote:'Token price history is not available for the original post.'}});
 await tx.update(tradeIdeas).set({status:decision.status}).where(eq(tradeIdeas.id,row.id));
 });
 if(c)routed++;else skipped++;
 console.log(decision.status,row.id,c?.ticker??decision.unroutedReason);
 }catch(e){failed++;console.error('failed',row.id,e instanceof Error?e.message:'Routing failed.');}
}
console.log(JSON.stringify({apply,routed,skipped,failed}));process.exit(failed?1:0);
