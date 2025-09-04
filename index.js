// Raydium LP "lock-burn" watcher (STRICT + vault-delta guard)
// Csak akkor jelez, ha: Tokenkeg: Burn az LP-mintről ÉS NINCS pool-vault változás (tehát nem remove-liquidity)

import WebSocket from "ws";
import http from "http";
import fs from "fs";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.99);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 0);
const RATE_MS = Number(process.env.RATE_MS || 1200);
const DEBUG = process.env.DEBUG === "1";

// ==== Program IDs ====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const METAPLEX_META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

const log = (...a)=>console.log(new Date().toISOString(), ...a);
const dbg = (...a)=>{ if (DEBUG) console.log(new Date().toISOString(), "[DBG]", ...a); };

http.createServer((_,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ==== JSON-RPC helpers ====
async function rpc(method, params){
  const body = JSON.stringify({jsonrpc:"2.0", id:1, method, params});
  const r = await fetch(RPC_HTTP,{method:"POST",headers:{"content-type":"application/json"},body});
  if(!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json(); if(j.error) throw new Error(`RPC ${method} err: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTransaction(signature, tries=3){
  for(let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction",[signature,{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
    }catch(e){
      log(`getTransaction fail (${i+1}/${tries}) ${signature}:`, e.message);
      if(i<tries-1) await new Promise(r=>setTimeout(r,1500*(i+1)));
    }
  }
  return null;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo",[pubkey,{commitment:"confirmed"}]); }
async function getAccountInfoRaw(pubkey){ return rpc("getAccountInfo",[pubkey,{commitment:"confirmed",encoding:"base64"}]); }
async function getProgramAccounts(programId, filters=[]){ return rpc("getProgramAccounts",[programId,{commitment:"confirmed",encoding:"base64",filters}]); }

// ==== simple caches ====
const parsedCache = new Map();
async function getParsedCached(pubkey){
  if(parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try{ const info = await getParsedAccountInfo(pubkey); parsedCache.set(pubkey,info); return info; }
  catch{ parsedCache.set(pubkey,null); return null; }
}
async function isMintAccount(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type==="mint" ? d : null;
}
async function tokenAccountInfo(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type==="account" ? d?.info : null;
}

// ==== Dexscreener (opcionális kártya) ====
async function fetchDexscreenerByToken(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`,{headers:{accept:"application/json"}});
    if(!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs)?j.pairs:[];
    if(!pairs.length) return null;
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium"?0:1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium"?0:1;
      if(ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0)-(a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    return {
      name: p?.baseToken?.name||null,
      symbol: p?.baseToken?.symbol||null,
      price: p?.priceUsd ? Number(p.priceUsd) : null,
      liq: p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      mcap: p?.marketCap ? Number(p.marketCap) : (p?.fdv?Number(p.fdv):null),
      url: p?.url||null,
      createdAt: p?.pairCreatedAt||null
    };
  }catch{return null;}
}

// ==== Metaplex meta (mutability) ====
async function fetchMetaplexMetadata(mint){
  try{
    const accs = await getProgramAccounts(METAPLEX_META,[{memcmp:{offset:1+32,bytes:mint}}]);
    if(!accs?.length) return null;
    const dataB64 = accs[0]?.account?.data?.[0]; if(!dataB64) return null;
    const buf = Buffer.from(dataB64,"base64");
    let o=0; const u8=()=>buf[o++], u32=()=>{const v=buf.readUInt32LE(o);o+=4;return v;}, str=()=>{const n=u32();const s=buf.slice(o,o+n).toString("utf8");o+=n;return s;}, skip32=()=>{o+=32;};
    u8(); skip32(); skip32(); const name=str().trim(); const symbol=str().trim(); str(); buf.readUInt16LE(o); o+=2;
    const hasC = u8(); if(hasC===1){const n=u32(); for(let i=0;i<n;i++){skip32(); u8(); u8();}}
    u8(); const isMutable = !!u8();
    return {name, symbol, isMutable};
  }catch{return null;}
}

// ==== sent dedup (perzisztens) ====
const SENT_FILE="/tmp/sent_sigs.json"; const SENT_TTL=48*60*60*1000; const SENT_MAX=5000;
let sent = new Map();
try{ const arr = JSON.parse(fs.readFileSync(SENT_FILE,"utf8")); const now=Date.now(); sent=new Map(arr.filter(([s,ts])=>now-ts<SENT_TTL)); }catch{}
const saveSent=()=>{ try{ const arr=[...sent.entries()].sort((a,b)=>a[1]-b[1]).slice(-SENT_MAX); fs.writeFileSync(SENT_FILE,JSON.stringify(arr)); }catch{} };

// ==== Telegram queue ====
const tgQ=[]; let tgRun=false;
async function sendTelegram(text){
  if(!TG_BOT_TOKEN||!TG_CHAT_ID) return;
  tgQ.push(text); if(tgRun) return; tgRun=true;
  while(tgQ.length){
    const msg=tgQ.shift();
    try{
      const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:TG_CHAT_ID,text:msg,parse_mode:"HTML"})});
      if(r.status===429){ let w=3000; try{const jr=await r.json(); if(jr?.parameters?.retry_after) w=jr.parameters.retry_after*1000;}catch{} await new Promise(r=>setTimeout(r,w)); tgQ.unshift(msg); }
      else await new Promise(r=>setTimeout(r,1200));
    }catch{ await new Promise(r=>setTimeout(r,2000)); }
  }
  tgRun=false;
}

// ==== util ====
const ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(buf){ if(!buf?.length) return ""; let x=[...buf]; let z=0; while(z<x.length&&x[z]===0) z++; const out=[]; let s=z; while(s<x.length){ let c=0; for(let i=s;i<x.length;i++){ const v=(x[i]&255)+c*256; x[i]=(v/58)|0; c=v%58; } out.push(ALPHABET[c]); while(s<x.length&&x[s]===0) s++; } for(let i=0;i<z;i++) out.push("1"); return out.reverse().join(""); }
function ago(ms){ const s=Math.max(1,((Date.now()-ms)/1000)|0); if(s<60) return `${s}s ago`; const m=(s/60)|0; if(m<60) return `${m} minutes ago`; const h=(m/60)|0; if(h<24) return `${h} hours ago`; const d=(h/24)|0; return `${d} days ago`; }

// ==== mint feloldások (baldiff/state/largest/freq) – változatlanok rövidítve ====
async function resolveMintsByBalanceDiff(tx, lpMint){
  const pre=tx?.meta?.preTokenBalances||[], post=tx?.meta?.postTokenBalances||[];
  const key=b=>`${b?.accountIndex||0}|${b?.mint||""}`; const map=new Map(pre.map(b=>[key(b),b]));
  const byMint=new Map();
  for(const b of post){ const k=key(b); const p=map.get(k); const mint=b?.mint; if(!mint||mint===lpMint) continue;
    const dec=Number(b?.uiTokenAmount?.decimals||0);
    const d=(Number(b?.uiTokenAmount?.amount||0)-Number(p?.uiTokenAmount?.amount||0))/(10**dec);
    const a=Math.abs(d); if(a>0) byMint.set(mint,(byMint.get(mint)||0)+a);
  }
  const ranked=[...byMint.entries()].sort((a,b)=>b[1]-a[1]);
  if(ranked.length>=2){ const [m1,m2]=ranked.slice(0,2).map(x=>x[0]);
    if(QUOTE_MINTS.has(m1)&&!QUOTE_MINTS.has(m2)) return {baseMint:m2,quoteMint:m1,source:"baldiff"};
    if(QUOTE_MINTS.has(m2)&&!QUOTE_MINTS.has(m1)) return {baseMint:m1,quoteMint:m2,source:"baldiff"};
    return {baseMint:m1,quoteMint:m2,source:"baldiff"};
  }
  return {baseMint:null,quoteMint:null,source:"baldiff-none"};
}
async function resolveMintsFromState(rayAccounts, lpMint){
  const bins=[]; for(const a of rayAccounts){ try{ const info=await getAccountInfoRaw(a); const owner=info?.value?.owner;
    if(owner===RAY_AMM_V4||owner===RAY_CPMM){ const d=info?.value?.data?.[0]; if(d) bins.push(Buffer.from(d,"base64")); }
    if(bins.length>=6) break; }catch{}
  }
  for(const buf of bins){
    const seen=new Set(); const found=[];
    for(let off=0;off+32<=buf.length;off++){ const pk=bs58(buf.slice(off,off+32)); if(seen.has(pk)) continue; seen.add(pk);
      if(pk.length<32||pk.length>44) continue; if(pk===lpMint) continue;
      const mi=await isMintAccount(pk); if(mi){ found.push(pk); if(found.length>4) break; }
    }
    const u=[...new Set(found)]; if(u.length===2){ const [m1,m2]=u;
      if(QUOTE_MINTS.has(m1)&&!QUOTE_MINTS.has(m2)) return {baseMint:m2,quoteMint:m1,source:"state"};
      if(QUOTE_MINTS.has(m2)&&!QUOTE_MINTS.has(m1)) return {baseMint:m1,quoteMint:m2,source:"state"};
      return {baseMint:m1,quoteMint:m2,source:"state"};
    }
  }
  return {baseMint:null,quoteMint:null,source:"state-none"};
}
async function resolveMintsByLargestVaults(rayAccounts, lpMint){
  const vaults=[]; let c=0; for(const a of rayAccounts){ if(c++>300) break; const ta=await tokenAccountInfo(a); const m=ta?.mint; if(!m||m===lpMint) continue;
    const amt=Number(ta?.tokenAmount?.amount||0); vaults.push({mint:m,amt});
  }
  vaults.sort((a,b)=>b.amt-a.amt); const uniq=[...new Set(vaults.slice(0,6).map(v=>v.mint))];
  if(uniq.length>=2){ const [m1,m2]=uniq;
    if(QUOTE_MINTS.has(m1)&&!QUOTE_MINTS.has(m2)) return {baseMint:m2,quoteMint:m1,source:"largest"};
    if(QUOTE_MINTS.has(m2)&&!QUOTE_MINTS.has(m1)) return {baseMint:m1,quoteMint:m2,source:"largest"};
    return {baseMint:m1,quoteMint:m2,source:"largest"};
  }
  return {baseMint:null,quoteMint:null,source:"largest-none"};
}
async function resolveMintsFallback(rayAccounts, lpMint){
  const freq=new Map(); let c=0; for(const a of rayAccounts){ if(c++>300) break; const ta=await tokenAccountInfo(a); const m=ta?.mint; if(m&&m!==lpMint) freq.set(m,(freq.get(m)||0)+1); }
  const sorted=[...freq.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  if(sorted.length>=2){ const [m1,m2]=sorted;
    if(QUOTE_MINTS.has(m1)&&!QUOTE_MINTS.has(m2)) return {baseMint:m2,quoteMint:m1,source:"freq"};
    if(QUOTE_MINTS.has(m2)&&!QUOTE_MINTS.has(m1)) return {baseMint:m1,quoteMint:m2,source:"freq"};
    return {baseMint:m1,quoteMint:m2,source:"freq"};
  }
  return {baseMint:null,quoteMint:null,source:"freq-none"};
}

// ==== ÚJ: pool vault delta guard ====
// Ha Raydiumhoz tartozó base/quote vaultok pre/post egyenlege érdemben változik → remove-liq → skip
function poolVaultDeltaChanged(tx, rayAccounts, baseMint, quoteMint){
  if(!baseMint && !quoteMint) return false; // nincs info → ne ejtsük el csak ezért
  const pre=tx?.meta?.preTokenBalances||[], post=tx?.meta?.postTokenBalances||[];
  const keys = tx?.transaction?.message?.accountKeys || [];
  const getKey = (idx)=> (typeof keys[idx]==="string"? keys[idx] : (keys[idx]?.pubkey || keys[idx]?.toString?.()));
  const preMap = new Map(pre.map(b=>[b.accountIndex, b]));
  let deltaBase=0, deltaQuote=0;
  for(const b of post){
    const idx=b.accountIndex; const preB=preMap.get(idx);
    const mint=b?.mint; if(!mint) continue;
    const accKey=getKey(idx); if(!accKey || !rayAccounts.has(accKey)) continue; // csak Raydium accountok
    const dec=Number(b?.uiTokenAmount?.decimals||0);
    const postAmt=Number(b?.uiTokenAmount?.amount||0), preAmt=Number(preB?.uiTokenAmount?.amount||0);
    const diff=(postAmt-preAmt)/(10**dec);
    if(mint===baseMint) deltaBase += diff;
    if(mint===quoteMint) deltaQuote += diff;
  }
  // kis tolerancia: ha bármelyik abs(delta) nagyobb, mint parányi küszöb → remove-liq
  const TH = 1e-6; // ~pár mikrotoken; elég arra, hogy a “semmi nem változott” esetre true legyen
  return (Math.abs(deltaBase) > TH) || (Math.abs(deltaQuote) > TH);
}

// ==== fő feldolgozás ====
async function processSignature(sig){
  if(sent.has(sig)) { dbg("skip already sent", sig); return; }
  const tx = await getTransaction(sig); if(!tx) return;

  const top=tx?.transaction?.message?.instructions||[];
  const inner=(tx?.meta?.innerInstructions||[]).flatMap(x=>x?.instructions||[]);
  const all=[...top,...inner];

  // Raydium-accounts
  const rayPrograms=new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts=new Set();
  for(const ix of all){
    const pid=typeof ix?.programId==="string"? ix.programId : null;
    if(pid && rayPrograms.has(pid)){
      const accs=(ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for(const a of accs) rayAccounts.add(a);
    }
  }
  const msgKeys=tx?.transaction?.message?.accountKeys||[];
  for(const k of msgKeys){ const pk=typeof k==="string"?k:(k?.pubkey||k?.toString?.()); if(pk) rayAccounts.add(pk); }
  dbg("rayAccounts count:", rayAccounts.size);

  // LOG alapú kizárás: Remove/Decrease Liquidity
  const wsLogs = tx?.meta?.logMessages || [];
  const hasRemove = wsLogs.some(l=>/Remove\s*Liquidity|Decrease\s*Liquidity/i.test(l));
  if(hasRemove){ dbg("skip: Remove/DecreaseLiquidity in logs"); return; }

  // Tokenkeg Burn + LP mint (STRICT: mint szerepel a Raydium accountok közt)
  let lpMint=null, burnAmountRaw=0;
  for(const ix of all){
    const pid=typeof ix?.programId==="string"? ix.programId : null;
    if(pid!==TOKENKEG) continue;
    const isBurn = ix?.parsed?.type==="burn" || ix?.instructionName==="Burn";
    if(!isBurn) continue;
    const cand = ix?.parsed?.info?.mint || ix?.mint;
    if(!cand) continue;
    if(!rayAccounts.has(cand)) { dbg("skip burn: not a Raydium LP mint", cand); continue; }
    lpMint=cand; burnAmountRaw=Number(ix?.parsed?.info?.amount||ix?.amount||0); break;
  }
  if(!lpMint){ dbg("no LP mint match (strict)"); return; }

  // LP supply + % burn
  let lpSupplyPost=0, lpDecimals=0;
  try{
    const mi=await getParsedCached(lpMint);
    const inf=mi?.value?.data?.parsed?.info;
    if(inf?.supply) lpSupplyPost=Number(inf.supply);
    if(inf?.decimals!=null) lpDecimals=Number(inf.decimals)||0;
  }catch{}
  const lpSupplyPre=lpSupplyPost+burnAmountRaw;
  const burnShare = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre) : 0;
  if(burnShare < MIN_LP_BURN_PCT){
    dbg(`skip: burnShare ${(burnShare*100).toFixed(2)}% < ${(MIN_LP_BURN_PCT*100).toFixed(2)}%`);
    return;
  }

  // base/quote feloldás (kell a delta guardhoz + infóhoz)
  let res = await resolveMintsByBalanceDiff(tx, lpMint);
  if(!res.baseMint){ const r1=await resolveMintsFromState(rayAccounts, lpMint); if(r1.baseMint) res=r1; }
  if(!res.baseMint){ const r2=await resolveMintsByLargestVaults(rayAccounts, lpMint); if(r2.baseMint) res=r2; }
  if(!res.baseMint){ const r3=await resolveMintsFallback(rayAccounts, lpMint); if(r3.baseMint) res=r3; }
  const {baseMint, quoteMint} = res;

  // ÚJ: pool-vault delta guard → ha változik a vault (base/quote) balansz → remove-liq → skip
  if(poolVaultDeltaChanged(tx, rayAccounts, baseMint, quoteMint)){
    dbg("skip: pool vault balances changed (looks like remove-liq)");
    return;
  }

  // becsült SOL (opcionális)
  let wsolVaultRaw=0, wsolDec=9, chk=0;
  for(const a of rayAccounts){
    if(chk++>120) break;
    const ta=await tokenAccountInfo(a);
    if(ta?.mint===WSOL_MINT){
      const t=ta?.tokenAmount;
      if(t?.amount) wsolVaultRaw = Number(t.amount);
      if(t?.decimals!=null) wsolDec = Number(t.decimals)||9;
      break;
    }
  }
  const estSolOut = burnShare * (wsolVaultRaw/10**wsolDec);
  if(MIN_SOL_BURN>0 && estSolOut < MIN_SOL_BURN){
    log(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN}) sig=${sig}`);
    return;
  }

  // Dexscreener (kártya)
  let dx=null; if(baseMint) dx=await fetchDexscreenerByToken(baseMint);

// Max token age (opcionális)
if (MAX_TOKEN_AGE_MIN > 0) {
  const createdAt = dx?.createdAt ? Number(dx.createdAt) : null;
  if (createdAt) {
    const ageMin = (Date.now() - createdAt) / 60000;
    if (ageMin > MAX_TOKEN_AGE_MIN) {
      dbg(`skip: age ${ageMin.toFixed(1)}min > ${MAX_TOKEN_AGE_MIN}min`);
      return;
    }
  } else {
    dbg("no pairCreatedAt → treating as fresh (pass)");
  }
}

  // Security flags
  let mintAuthNone=null, freezeNone=null, metaMutable=null;
  if(baseMint){
    try{
      const mi=await getParsedCached(baseMint);
      const inf=mi?.value?.data?.parsed?.info;
      mintAuthNone = (inf?.mintAuthority==null);
      freezeNone   = (inf?.freezeAuthority==null);
    }catch{}
    const md=await fetchMetaplexMetadata(baseMint);
    if(md) metaMutable = md.isMutable;
  }

  // TG message
  const link=`https://solscan.io/tx/${sig}`;
  const burnPct=(burnShare*100).toFixed(2);
  const when=tx?.blockTime? ago(tx.blockTime*1000) : "n/a";
  const title=(dx?.name&&dx?.symbol)? `${dx.name} (${dx.symbol})` : "Raydium LP Burn";

  const lines=[
    `Solana LP Burns`,
    `<b>${title}</b>`,
    ``,
    `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
    `🕒 <b>Burn Time:</b> ${when}`,
    ``,
    `📊 <b>Marketcap:</b> ${dx?.mcap!=null?`$${dx.mcap.toLocaleString()}`:"n/a"}`,
    `💧 <b>Liquidity:</b> ${dx?.liq!=null?`$${dx.liq.toLocaleString()}`:"n/a"}`,
    `💲 <b>Price:</b> ${dx?.price!=null?`$${dx.price}`:"n/a"}`,
    ``,
    baseMint?`🧾 <b>Token Mint:</b> <code>${baseMint}</code>`:`🧾 <b>Token Mint:</b> n/a`,
    ``,
    `⚙️ <b>Security:</b>`,
    `├ Mutable Metadata: ${metaMutable===null?"n/a":(metaMutable?"Yes ❌":"No ✅")}`,
    `├ Mint Authority: ${mintAuthNone===null?"n/a":(mintAuthNone?"No ✅":"Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone===null?"n/a":(freezeNone?"No ✅":"Yes ❌")}`,
    ``,
    dx?.url?dx.url:null,
    `🔗 <a href="${link}">Solscan</a>`,
    DEBUG?`\n<code>strict=1 vault-delta-guard=on</code>`:null
  ].filter(Boolean);

  sent.set(sig, Date.now()); saveSent();
  await sendTelegram(lines.join("\n"));
  log(`TG → ${title} | burn=${burnPct}% | sig=${sig}`);
}

// ==== WS (logsSubscribe) ====
let ws;
function wsSend(o){ if(ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(o)); }
function subscribeLogs(pid,id){ wsSend({jsonrpc:"2.0", id, method:"logsSubscribe", params:[{mentions:[pid]},{commitment:"confirmed"}]}); }
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws=new WebSocket(RPC_WSS);
  ws.onopen=()=>{ log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); };
  ws.onmessage=async ev=>{
    try{
      const data=JSON.parse(ev.data.toString());
      const res=data?.params?.result;
      const sig=res?.value?.signature;
      const logsArr=Array.isArray(res?.value?.logs)?res.value.logs:[];
      if(!sig||!logsArr.length) return;
      const hasBurnLog = logsArr.some(l=>/Instruction:\s*Burn\b/i.test(l));
      if(!hasBurnLog) return;
      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose=()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror=e=>{ log("WS error:", e?.message||String(e)); };
}

// ==== getTransaction rate limiter ====
const queue=[]; const seen=new Set(); let worker=false;
async function enqueueSignature(sig){
  if(seen.has(sig)) return; seen.add(sig); queue.push(sig);
  if(!worker){ worker=true; while(queue.length){ const s=queue.shift(); try{ await processSignature(s);}catch(e){log("proc err:",e.message);} await new Promise(r=>setTimeout(r,RATE_MS)); } worker=false; }
}

connectWS();
