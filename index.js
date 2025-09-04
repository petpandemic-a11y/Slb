// Raydium LP lock-burn watcher → Telegram (STRICT, no-dup, vault-delta guard)
//
// Csak akkor jelez, ha:
//  • WS logban tényleg: "Instruction: Burn"
//  • Tokenkeg Burn/BurnChecked történt olyan mintre, amely BENNE van a Raydium-instrukciók accounts[] listáiban (LP mint)
//  • Nem Remove/Decrease Liquidity (log alapján)
//  • Pool vaultok (base/quote) pre/post nem változnak érdemben (vault-delta guard)
//  • (opcionális) kor-szűrő: ha van pairCreatedAt → ellenőrzés; ha nincs → átengedjük
//
// ENV (példa):
// RPC_HTTP, RPC_WSS, TG_BOT_TOKEN, TG_CHAT_ID
// MIN_LP_BURN_PCT=0.99   RATE_MS=1200   MAX_TOKEN_AGE_MIN=60   DEBUG=1
// MIN_SOL_BURN=0   (SOL-küszöb kikapcsolva alapból)

import WebSocket from "ws";
import http from "http";
import fs from "fs";

// ===== ENV =====
const PORT = Number(process.env.PORT || 0); // Workerhez 0 is ok; ha >0, elindít health HTTP
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const RATE_MS           = Number(process.env.RATE_MS || 1200);
const DEBUG             = process.env.DEBUG === "1";
const MIN_LP_BURN_PCT   = Number(process.env.MIN_LP_BURN_PCT || 0.99); // 99%+
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 0);  // 0 = kikapcs
const MIN_SOL_BURN      = Number(process.env.MIN_SOL_BURN || 0);       // alapból 0 (=kikapcs)

// ===== Program IDs =====
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

// ===== Logger + health =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => { if (DEBUG) console.log(new Date().toISOString(), "[DBG]", ...a); };
if (PORT > 0) {
  http.createServer((_, res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
    .listen(PORT, ()=>log(`HTTP up on :${PORT}`));
}

// ===== JSON-RPC helpers =====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const r = await fetch(RPC_HTTP, { method:"POST", headers:{ "content-type":"application/json" }, body });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json(); if (j.error) throw new Error(`RPC ${method} err: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTransaction(signature, tries=3){
  for (let i=0;i<tries;i++){
    try { return await rpc("getTransaction",[signature,{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]); }
    catch(e){ dbg(`getTransaction fail (${i+1}/${tries}) ${signature}: ${e.message}`); if (i<tries-1) await new Promise(r=>setTimeout(r,1500*(i+1))); }
  }
  return null;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo",[pubkey,{commitment:"confirmed"}]); }
async function getAccountInfoRaw(pubkey){ return rpc("getAccountInfo",[pubkey,{commitment:"confirmed",encoding:"base64"}]); }
async function getProgramAccounts(programId, filters=[]) {
  return rpc("getProgramAccounts", [ programId, { commitment:"confirmed", encoding:"base64", filters } ]);
}
async function getMultipleAccounts(keys) {
  const res = await rpc("getMultipleAccounts", [ keys, { commitment: "confirmed", encoding: "jsonParsed" } ]);
  return res?.value || [];
}

// ===== parsed cache =====
const parsedCache = new Map();
async function getParsedCached(pubkey){
  const hit = parsedCache.get(pubkey);
  if (hit !== undefined) return hit;
  try{ const info = await getParsedAccountInfo(pubkey); parsedCache.set(pubkey, info); return info; }
  catch{ parsedCache.set(pubkey, null); return null; }
}
async function isMintAccount(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "mint" ? d : null;
}
async function tokenAccountInfo(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "account" ? d?.info : null;
}

// ===== Dexscreener =====
async function fetchDexscreenerByToken(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers:{accept:"application/json"} });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    return {
      name:   p?.baseToken?.name   || null,
      symbol: p?.baseToken?.symbol || null,
      price:  p?.priceUsd ? Number(p.priceUsd) : null,
      liq:    p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv:    p?.fdv ? Number(p.fdv) : null,
      mcap:   p?.marketCap ? Number(p.marketCap) : null,
      url:    p?.url || null,
      createdAt: p?.pairCreatedAt || null,
      dexId:  p?.dexId || null,
      quote:  p?.quoteToken?.address || null
    };
  }catch{ return null; }
}

// ===== Utils =====
function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m} minutes ago`;
  const h = Math.floor(m/60); if (h<24) return `${h} hours ago`;
  const d = Math.floor(h/24); return `${d} days ago`;
}

// ===== Base/Quote feloldás =====
function resolveByBalanceDiff(tx, lpMint) {
  const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
  const key = (b) => `${b?.accountIndex || 0}|${b?.mint || ""}`;
  const preMap = new Map(pre.map(b => [key(b), b]));
  const byMint = new Map();
  for (const b of post) {
    const k = key(b), p = preMap.get(k), mint = b?.mint;
    if (!mint || mint === lpMint) continue;
    const dec = Number(b?.uiTokenAmount?.decimals || 0);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0);
    const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
    const diffAbs = Math.abs(postAmt - preAmt) / (10 ** dec);
    if (diffAbs > 0) byMint.set(mint, (byMint.get(mint)||0) + diffAbs);
  }
  const ranked = [...byMint.entries()].sort((a,b)=>b[1]-a[1]);
  if (ranked.length >= 2) {
    const [m1, m2] = ranked.slice(0,2).map(x=>x[0]);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint: m2, quoteMint: m1, source: "baldiff" };
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint: m1, quoteMint: m2, source: "baldiff" };
    return { baseMint: m1, quoteMint: m2, source: "baldiff" };
  }
  return { baseMint: null, quoteMint: null, source: "baldiff-none" };
}
async function resolveByVaultsBatch(rayAccounts, lpMint){
  const keys = [...rayAccounts].slice(0, 200);
  const chunks = [];
  for (let i=0;i<keys.length;i+=100) chunks.push(keys.slice(i, i+100));
  const vaults = [];
  for (const chunk of chunks){
    const accs = await getMultipleAccounts(chunk);
    accs.forEach((acc)=>{
      const parsed = acc?.data?.parsed;
      if (parsed?.type === "account") {
        const info = parsed.info;
        const mint = info?.mint;
        if (mint && mint !== lpMint) {
          const amt = Number(info?.tokenAmount?.amount || 0);
          vaults.push({ mint, amt });
        }
      }
    });
  }
  vaults.sort((a,b)=>b.amt - a.amt);
  const uniq = [...new Set(vaults.map(v=>v.mint))];
  if (uniq.length >= 2) {
    const [m1, m2] = uniq.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint:m2, quoteMint:m1, source:"vaults" };
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint:m1, quoteMint:m2, source:"vaults" };
    return { baseMint:m1, quoteMint:m2, source:"vaults" };
  }
  return { baseMint:null, quoteMint:null, source:"vaults-none" };
}

// ===== Vault-delta guard =====
// Ha Raydiumhoz tartozó base/quote vaultok pre/post változnak → remove-liq → skip
function poolVaultDeltaChanged(tx, rayAccounts, baseMint, quoteMint){
  if (!baseMint && !quoteMint) return false;
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const keys = tx?.transaction?.message?.accountKeys || [];
  const keyOf = (i)=> (typeof keys[i]==="string" ? keys[i] : (keys[i]?.pubkey || keys[i]?.toString?.()));
  const preMap = new Map(pre.map(b=>[b.accountIndex, b]));
  let dBase = 0, dQuote = 0;

  for (const b of post){
    const accKey = keyOf(b.accountIndex);
    if (!accKey || !rayAccounts.has(accKey)) continue; // csak Raydiumhoz tartozó token account
    const mint = b?.mint; if (!mint) continue;
    const dec = Number(b?.uiTokenAmount?.decimals || 0);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0) / (10 ** dec);
    const preAmt  = Number(preMap.get(b.accountIndex)?.uiTokenAmount?.amount || 0) / (10 ** dec);
    const diff = postAmt - preAmt;
    if (mint === baseMint)  dBase  += diff;
    if (mint === quoteMint) dQuote += diff;
  }
  const TH = 1e-6;
  return (Math.abs(dBase) > TH) || (Math.abs(dQuote) > TH);
}

// ===== Telegram (queue + throttle) =====
const tgQ=[]; let tgSending=false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQ.push(text); if (tgSending) return; tgSending = true;
  while (tgQ.length){
    const msg = tgQ.shift();
    try{
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      if (r.status===429){
        let wait=3000; try{ const jr=await r.json(); if (jr?.parameters?.retry_after) wait=jr.parameters.retry_after*1000; }catch{}
        await new Promise(res=>setTimeout(res,wait)); tgQ.unshift(msg);
      } else {
        await new Promise(res=>setTimeout(res,1200));
      }
    }catch(e){ log("TG err:", e.message); await new Promise(res=>setTimeout(res,2000)); }
  }
  tgSending=false;
}

// ===== Perzisztens dedup (signature) =====
const SENT_FILE = "/tmp/sent_sigs.json";
const SENT_TTL_MS = 48*60*60*1000;
const SENT_MAX = 5000;
let sentMap = new Map();
(function loadSent(){
  try{
    const arr = JSON.parse(fs.readFileSync(SENT_FILE,"utf8"));
    const now = Date.now();
    sentMap = new Map(arr.filter(([sig,ts]) => now - ts < SENT_TTL_MS));
    log(`sent_sigs loaded: ${sentMap.size}`);
  }catch{ sentMap = new Map(); }
})();
function saveSent(){
  try{
    const entries = [...sentMap.entries()];
    entries.sort((a,b)=>a[1]-b[1]);
    const trimmed = entries.slice(Math.max(0, entries.length - SENT_MAX));
    fs.writeFileSync(SENT_FILE, JSON.stringify(trimmed), "utf8");
  }catch{}
}

// ===== Rate limiter =====
const sigQueue=[]; const seenSig=new Set(); let workerRunning=false;
async function enqueueSignature(sig){
  if (seenSig.has(sig)) return; seenSig.add(sig); sigQueue.push(sig);
  if (!workerRunning){
    workerRunning=true;
    while (sigQueue.length){
      const s = sigQueue.shift();
      try{ await processSignature(s); }catch(e){ log("processSignature err:", e.message); }
      await new Promise(r=>setTimeout(r, RATE_MS));
    }
    workerRunning=false;
  }
}

// ===== MAIN processing =====
async function processSignature(sig){
  if (sentMap.has(sig)) { dbg("skip already sent sig", sig); return; }

  const tx = await getTransaction(sig);
  if (!tx) return;

  // 1) Remove/Decrease Liquidity kizárás log alapján
  const logs = tx?.meta?.logMessages || [];
  if (logs.some(l => /Remove\s*Liquidity|Decrease\s*Liquidity/i.test(l))) {
    dbg("skip: Remove/DecreaseLiquidity in logs");
    return;
  }

  // 2) Raydium-instrukciók accounts[] → rayAccounts (NEM bővítjük message accountKeys-szel!)
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }
  dbg("rayAccounts count:", rayAccounts.size);

  // 3) Tokenkeg Burn/BurnChecked → LP mint (mint szerepeljen rayAccounts-ban)
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;
    const isBurn = ix?.parsed?.type?.toLowerCase?.() === "burn" || ix?.parsed?.type?.toLowerCase?.() === "burnchecked" || ix?.instructionName === "Burn" || ix?.instructionName === "BurnChecked";
    if (!isBurn) continue;
    const cand = ix?.parsed?.info?.mint || ix?.mint;
    if (!cand) continue;
    if (!rayAccounts.has(cand)) { dbg("skip burn: mint not among Raydium accounts", cand); continue; }
    const mintInfo = await isMintAccount(cand);
    if (!mintInfo) { dbg("skip burn: not a valid SPL mint", cand); continue; }
    lpMint = cand;
    burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
    break;
  }
  if (!lpMint){ dbg("no LP mint match (strict)"); return; }

  // 4) LP supply + burn %
  let lpSupplyPost=0;
  try{
    const mi = await getParsedCached(lpMint);
    const d = mi?.value?.data?.parsed?.info;
    if (d?.supply) lpSupplyPost = Number(d.supply);
  }catch{}
  const lpSupplyPre = lpSupplyPost + burnAmountRaw;
  const burnShare = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre) : 0;
  if (burnShare < MIN_LP_BURN_PCT){
    dbg(`skip: burnShare ${(burnShare*100).toFixed(2)}% < min ${(MIN_LP_BURN_PCT*100).toFixed(2)}%`);
    return;
  }

  // 5) Base/Quote mints – kell a vault-delta guardhoz
  let res = resolveByBalanceDiff(tx, lpMint);
  if (!res.baseMint){ res = await resolveByVaultsBatch(rayAccounts, lpMint); }
  const { baseMint, quoteMint, source } = res;
  if (!baseMint || !quoteMint || baseMint === quoteMint){
    dbg("skip: could not resolve distinct base+quote mints");
    return;
  }

  // 6) Vault-delta guard → ha változik a Raydium vaultok egyenlege → remove-liq → skip
  if (poolVaultDeltaChanged(tx, rayAccounts, baseMint, quoteMint)){
    dbg("skip: pool vault balances changed (remove-liq likely)");
    return;
  }

  // 7) Dexscreener
  const dx = await fetchDexscreenerByToken(baseMint);
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

  // 8) (opcionális) Est. SOL csak WSOL quote esetén – és csak ekkor szűrjünk
  if (MIN_SOL_BURN > 0 && quoteMint === WSOL_MINT) {
    const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
    const byKey = new Map(pre.map(b => [b?.accountIndex, b]));
    let deltaWSOL = 0;
    for (const b of post) {
      if (b?.mint !== WSOL_MINT) continue;
      const dec = Number(b?.uiTokenAmount?.decimals || 9);
      const postAmt = Number(b?.uiTokenAmount?.amount || 0) / (10 ** dec);
      const preAmt  = Number(byKey.get(b?.accountIndex)?.uiTokenAmount?.amount || 0) / (10 ** dec);
      deltaWSOL += (preAmt - postAmt); // mennyi tűnt el Raydium oldalon
    }
    // fallback vault becslés, ha nincs diff
    let estSolOut = deltaWSOL;
    if (estSolOut <= 0) {
      // olcsó vault-scan
      let wsolVaultRaw=0, wsolDecimals=9, checked=0;
      for (const a of rayAccounts){
        if (checked++>120) break;
        const acc = await tokenAccountInfo(a);
        if (acc?.mint===WSOL_MINT){
          const ta = acc?.tokenAmount;
          if (ta?.amount) wsolVaultRaw = Number(ta.amount);
          if (ta?.decimals!=null) wsolDecimals = Number(ta.decimals)||9;
          break;
        }
      }
      const burnShareLocal = burnShare || 0;
      estSolOut = burnShareLocal * (wsolVaultRaw/Math.pow(10,wsolDecimals));
    }
    if (estSolOut < MIN_SOL_BURN) {
      dbg(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN})`);
      return;
    }
  }

  // 9) Meta/security (jelzők a poszthoz)
  let mintAuthNone=null, freezeNone=null, metaMutable=null;
  try{
    const mi = await getParsedCached(baseMint);
    const info = mi?.value?.data?.parsed?.info;
    mintAuthNone = (info?.mintAuthority==null);
    freezeNone   = (info?.freezeAuthority==null);
  }catch{}
  try{
    const accs = await getProgramAccounts(METAPLEX_META, [{ memcmp: { offset: 1 + 32, bytes: baseMint } }]);
    if (Array.isArray(accs) && accs.length>0) {
      const buf = Buffer.from(accs[0]?.account?.data?.[0] || "", "base64");
      let o=0; const u8=()=>buf[o++], u32=()=>{const v=buf.readUInt32LE(o);o+=4;return v;}, str=()=>{const n=u32();const s=buf.slice(o,o+n).toString("utf8");o+=n;return s;}, skip32=()=>{o+=32;};
      if (buf.length>0){ u8(); skip32(); skip32(); str(); str(); str(); buf.readUInt16LE(o); o+=2; const hasC=u8(); if(hasC===1){ const n=u32(); for(let i=0;i<n;i++){ skip32(); u8(); u8(); } } u8(); metaMutable=!!u8(); }
    }
  }catch{}

  // 10) Üzenet (csak base token mint + alap adatok)
  const sigLink = `https://solscan.io/tx/${sig}`;
  const burnPct = (burnShare*100).toFixed(2);
  const burnAgo = tx?.blockTime ? ago(tx.blockTime*1000) : "n/a";
  const headTitle = (dx?.name && dx?.symbol) ? `${dx.name} (${dx.symbol})` : "Raydium LP Burn";
  const mcapStr = dx?.mcap!=null ? `$${dx.mcap.toLocaleString()}` : (dx?.fdv!=null?`$${dx.fdv.toLocaleString()}`:"n/a");
  const liqStr  = dx?.liq!=null  ? `$${dx.liq.toLocaleString()}` : "n/a";
  const priceStr= dx?.price!=null? `$${dx.price}` : "n/a";

  const lines = [
    `Solana LP Burns`,
    `<b>${headTitle}</b>`,
    "",
    `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
    `🕒 <b>Burn Time:</b> ${burnAgo}`,
    "",
    `📊 <b>Marketcap:</b> ${mcapStr}`,
    `💧 <b>Liquidity:</b> ${liqStr}`,
    `💲 <b>Price:</b> ${priceStr}`,
    "",
    `🧾 <b>Token Mint:</b> <code>${baseMint}</code>`,
    "",
    `⚙️ <b>Security:</b>`,
    `├ Mutable Metadata: ${metaMutable===null ? "n/a" : (metaMutable ? "Yes ❌" : "No ✅")}`,
    `├ Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`,
    "",
    dx?.url ? dx.url : null,
    `🔗 <a href="${sigLink}">Solscan</a>`,
    DEBUG ? `\n<code>mint_source=${source} strict=1 vault-guard=on</code>` : null
  ].filter(Boolean);

  sentMap.set(sig, Date.now()); saveSent();
  await sendTelegram(lines.join("\n"));
  log(`TG → ${headTitle} | burn=${burnPct}% | sig=${sig}`);
}

// ===== WS (logsSubscribe) =====
let ws;
function wsSend(obj){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  wsSend({ jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] });
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = () => { log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); };
  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length===0) return;
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn\b/i.test(l));
      if (!hasBurnLog) return;
      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=>{ dbg("WS error:", e?.message || String(e)); };
}
connectWS();
