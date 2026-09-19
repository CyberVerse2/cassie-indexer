import { discoverAssets } from './asset-directory.js';
import type { VenueCandidate } from './types';
let nextRequest=0;
export async function flash(path:string,body?:unknown):Promise<any>{
  const apiKey=process.env.DEFINITIVE_API_KEY;
  if(!apiKey)throw Error('DEFINITIVE_API_KEY is required for market discovery.');
  const wait=Math.max(0,nextRequest-Date.now());nextRequest=Date.now()+wait+300;if(wait)await new Promise(r=>setTimeout(r,wait));
  const response=await fetch('https://flash.definitive.fi/v1'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-definitive-api-key':apiKey},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Definitive request failed ('+response.status+').');
  return response.json();
}
export async function search(ticker:string,kind:'shares'|'spot'):Promise<VenueCandidate[]>{
  const assets=await discoverAssets(ticker,kind,flash);
  return assets.slice(0,3).map(asset=>({venue:'definitive',instrument:kind,ticker:asset.ticker,displayTicker:asset.ticker,direction:'long',markPrice:asset.price,liquidityNote:`${asset.symbol} on ${asset.chain}; liquidity $${asset.liquidity}`,marketMeta:{definitive:asset}}));
}
export async function checkRoute(asset:any){
  const wallet='0x1111111111111111111111111111111111111111';
  const pair={targetChain:asset.chain,contraChain:'base',targetAsset:asset.address,contraAsset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',orderType:'market',maxSlippage:'0.01',maxPriceImpact:'0.03',funderAddress:wallet,...(asset.chain!=='base'?{recipientAddress:wallet}:{})};
  const buy=await flash('/quote',{...pair,side:'buy',qty:'100'});
  if(!(Number(buy.to?.amount)>0))throw Error('No executable entry quote.');
  const sell=await flash('/quote',{...pair,side:'sell',qty:buy.to.amount});
  if(!(Number(sell.to?.amount)>0))throw Error('No executable exit quote.');
  if(Number(sell.to.amount)<90)throw Error('Round-trip costs exceed the discovery limit.');
  return {checkedAt:new Date().toISOString(),sampleAmountUsd:100,entryPrice:100/Number(buy.to.amount),roundTripUsd:Number(sell.to.amount)};
}
