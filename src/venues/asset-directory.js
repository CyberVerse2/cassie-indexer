// Issuer-published contracts, verified 2026-09-19 at https://brand.base.org/stocks.
// Never infer an address from a symbol or substitute a leveraged/perpetual asset.
export const STOCK_SOURCE = 'https://brand.base.org/stocks';
export const STOCKS = Object.freeze(Object.fromEntries(Object.entries({
  NVDA:'0xb20000000000000000000078ee7ce2fe4908108c',
  META:'0xb2000000000000000000008bc8786b856e61707c',
  AAPL:'0xb200000000000000000000c2e324d24d7eecd1fb',
  GOOGL:'0xb2000000000000000000002d0ba3164cc74f58b7',
  AMZN:'0xb200000000000000000000d9192b6b456483c2e8',
  MSFT:'0xb200000000000000000000ab99cfa739e253872b',
  MSTR:'0xb2000000000000000000004884b426556b92883d',
  SNDK:'0xb200000000000000000000397293cb8cda9a10c5',
  SPCX:'0xb2000000000000000000007b9fcbd005511acbd5',
  TSLA:'0xb2000000000000000000001e800a7f5189430cd0',
}).map(([ticker,address])=>[ticker,{ticker,address,chain:'base',symbol:`${ticker}c`,decimals:8,issuer:'Coinbase',source:STOCK_SOURCE}])));


export const EVM_CHAINS={ethereum:1,arbitrum:42161,base:8453,bsc:56,optimism:10,polygon:137,avalanche:43114,hyperevm:999,ink:57073,monad:143,plasma:9745,robinhood:4663,arc:5042};
const networks={Ethereum:'ethereum',Arbitrum:'arbitrum',Base:'base',BinanceSmartChain:'bsc',Optimism:'optimism',Polygon:'polygon',Avalanche:'avalanche',HyperEVM:'hyperevm',Ink:'ink'};
const key=(chain,address)=>chain+':'+address.toLowerCase();
const cache=new Map();
async function cached(name,load){
 const old=cache.get(name);if(old&&old.expires>Date.now())return old.promise;
 const promise=load().catch(error=>{cache.delete(name);throw error;});
 cache.set(name,{expires:Date.now()+3600000,promise});return promise;
}
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Asset identity service unavailable ('+r.status+').');return r.json();}
export async function stockDirectory(){return cached('stocks',async()=>{
 const map=new Map();
 for(const s of Object.values(STOCKS))map.set(key(s.chain,s.address),{...s,kind:'shares',priceBasis:'token',conversion:'b20'});
 for(let page=0;page<20;page++){
  const result=await json('https://api.backed.fi/api/v2/public/assets?page='+page);
  if(!Array.isArray(result.nodes)||result.page?.currentPage!==page)throw Error('Invalid issuer catalogue.');
  for(const asset of result.nodes){
   if(asset.isTradingHalted)continue;
   const ticker=asset.underlying?.symbol||asset.underlyingSymbol;if(!ticker)continue;
   for(const deployment of asset.deployments??[]){const chain=networks[deployment.network];if(!chain)continue;
    // Wrapped and unwrapped tokens are distinct assets. Plans use token USD
    // prices, never assume that one token is one underlying share.
    for(const address of [deployment.address,deployment.wrapperAddressV2])if(/^0x[a-f0-9]{40}$/i.test(address??''))map.set(key(chain,address),{ticker,address:address.toLowerCase(),chain,issuer:'xStocks',kind:'shares',source:'https://api.backed.fi/api/v2/public/assets/'+asset.symbol,priceBasis:'token'});
   }
  }
  if(!result.page.hasNextPage)return map;
 }
 throw Error('Issuer catalogue exceeded its pagination limit.');
});}
export function identityMatch(asset,identity,ticker){
 return Boolean(identity&&asset.chain in EVM_CHAINS&&/^0x[a-f0-9]{40}$/i.test(asset.address)&&Number.isInteger(asset.decimals)&&asset.decimals>=0&&asset.decimals<=36&&identity.ticker.toUpperCase()===ticker.toUpperCase());
}
export function knownShares(ticker,stocks){
 const want=ticker.toUpperCase();
 return [...stocks.values()].filter(s=>s.ticker.toUpperCase()===want);
}
function listed(asset){return asset.chain in EVM_CHAINS&&Number(asset.price)>0&&!asset.riskFlagged;}
function verified(asset,identity,ticker){
 if(!identityMatch(asset,identity,ticker))return null;
 return {...asset,...identity,address:asset.address.toLowerCase(),decimals:asset.decimals,symbol:asset.symbol||identity.symbol||ticker,price:Number(asset.price),verifiedAt:new Date().toISOString(),liquidity:Number(asset.liquidity),volume24h:Number(asset.volume24h)};
}
export async function discoverAssets(ticker,kind,flash,chain,directory){
 const stocks=kind==='shares'?(directory??await stockDirectory()):null;
 const seen=new Set();
 const results=[];
 const take=(asset,identity)=>{const row=verified(asset,identity,ticker);if(!row)return;const k=key(row.chain,row.address);if(seen.has(k))return;seen.add(k);results.push(row);};
 const response=await flash('/search?query='+encodeURIComponent(ticker)+'&limit=25'+(chain?'&chain='+encodeURIComponent(chain):''));
 for(const asset of (response.assets??[]).filter(listed)){
  take(asset,stocks?stocks.get(key(asset.chain,asset.address)):{ticker,kind:'spot',source:'definitive'});
 }
 if(stocks){
  for(const identity of knownShares(ticker,stocks)){
   if(seen.has(key(identity.chain,identity.address)))continue;
   if(chain&&identity.chain!==chain)continue;
   const found=await flash('/search?query='+encodeURIComponent(identity.address)+'&chain='+encodeURIComponent(identity.chain));
   const asset=(found.assets??[]).find(a=>a.chain===identity.chain&&a.address.toLowerCase()===identity.address);
   if(asset&&listed(asset))take(asset,identity);
  }
 }
 return results.sort((a,b)=>b.liquidity-a.liquidity);
}
const prices=new Map();
export async function refreshAsset(mapping,flash){
 const k=mapping?.chain+':'+mapping?.address;const old=prices.get(k);if(old&&old.until>Date.now())return old.promise;
 const promise=loadAsset(mapping,flash).catch(e=>{prices.delete(k);throw e;});prices.set(k,{until:Date.now()+15000,promise});return promise;
}
async function loadAsset(mapping,flash){
 if(!mapping||!(mapping.chain in EVM_CHAINS))throw Error('Unsupported execution chain.');
 const result=await flash('/search?query='+encodeURIComponent(mapping.address)+'&chain='+mapping.chain);
 const asset=result.assets?.find(a=>a.chain===mapping.chain&&a.address.toLowerCase()===mapping.address.toLowerCase());
 if(!asset||asset.decimals!==mapping.decimals||!Number.isFinite(Number(asset.price))||Number(asset.price)<=0||asset.riskFlagged)throw Error('The verified market is currently unavailable.');
 return {...mapping,price:Number(asset.price),liquidity:Number(asset.liquidity),checkedAt:new Date().toISOString()};
}
