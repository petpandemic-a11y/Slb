// Raydium LP Burn Watcher → Telegram (STRICT + CREDIT-SAVER)
// Csak akkor posztol, ha:
//  - WS logban "Instruction: Burn"
//  - a Burn mintje BENNE van a Raydium-instrukciók accountjai között (LP mint)
//  - SIKERÜLT feloldani a pool mindkét tokenjét (base+quote) → különböző mintek
//  - (opcionális) átmegy a kapukon: MIN_LP_BURN_PCT, MIN_SOL_BURN, MAX_TOKEN_AGE_MIN,
//    + Dex-szűrők (Raydium only / min liq / min FDV / min price / allowed quotes).
// Perzisztens dedup: ugyanarra a signature-re nincs duplikált TG poszt.

import WebSocket from "ws";
import http from "http";
import fs from "fs";

// ===== ENV =====
const PORT = Number(process.env.PORT || 0); // workerhez nem kell; ha >0, health HTTP indul
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const RATE_MS          = Number(process.env.RATE_MS || 1200);          // getTransaction tempó
const DEBUG            = process.env.DEBUG === "1";

// Kapuk (opcionálisak)
const MIN_LP_BURN_PCT  = Number(process.env.MIN_LP_BURN_PCT || 0.99);  // 0.99 = 99%+
const MIN_SOL_BURN     = Number(process.env.MIN_SOL_BURN || 0);        // becsült SOL küszöb (WSOL vault * burn%)
const MAX_TOKEN_AGE_MIN= Number(process.env.MAX_TOKEN_AGE_MIN || 0);   // Dexs pairCreatedAt → max kor (0 = kikapcs)

// Dexscreener szűrők (opcionálisak)
const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 0);
const MIN_FDV_USD     = Number(process.env.MIN_FDV_USD || 0);
const MIN_PRICE_USD   = Number(process.env.MIN_PRICE_USD || 0);
const REQUIRE_RAYDIUM = process.env.REQUIRE_RAYDIUM_DEX === "1";
const ALLOWED_QUOTES  = (process.env.ALLOWED_QUOTES || "").split(",").map(s=>s.trim()).filter(Boolean);
const MINT_COOLDOWN_MIN = Number(process.env.MINT_COOLDOWN_MIN || 0);  // per-token cooldown (perc)

// Kreditspóroló kapcsolók
const TRY_BALDIFF_ONLY   = process.env.TRY_BALDIFF_ONLY === "1";        // ha baldiff nem talál base-t, skippeljük a drága lépéseket
const MAX_RAY_ACCTS_SCAN = Number(process.env.MAX_RAY_ACCTS_SCAN || 60);// vault/state scan max ennyi account

// ===== Program IDs =====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const METAPLEX_META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Gyakori quote mint-ek
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
async function getTransaction(signature, tries=2){
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

// ===== Perzisztens dedup =====
const SENT_FILE = "/tmp/sent_sigs.json";
const SENT_TTL_MS = 48 * 60 * 60 * 1000;
const SENT_MAX = 5000;
let sentMap = new Map(); // sig -> ts
function loadSent() {
  try {
    const raw = fs.readFileSync(SENT_FILE, "utf8");
    const arr = JSON.parse(raw);
    const now = Date.now();
    sentMap = new Map(arr.filter(([sig, ts]) => now - ts < SENT_TTL_MS));
    log(`sent_sigs loaded: ${sentMap.size}`);
  } catch { sentMap = new Map(); }
}
function saveSent() {
  try {
    const entries = [...sentMap.entries()];
    entries.sort((a,b)=>a[1]-b[1]);
    const trimmed = entries.slice(Math.max(0, entries.length - SENT_MAX));
    fs.writeFileSync(SENT_FILE, JSON.stringify(trimmed), "utf8");
  } catch (e) { dbg("saveSent err:", e.message); }
}
loadSent();

// ===== Cache (olcsóbbá teszi az account olvasásokat) =====
const PARSED_CACHE_FILE = "/tmp/parsed_cache.json";
const PARSED_TTL_MS = 24 * 60 * 60 * 1000;
const PARSED_MAX = 15000;
let parsedCache = new Map(); // pubkey -> { savedAt, value }
function loadParsedCache(){
  try{
    const raw = fs.readFileSync(PARSED_CACHE_FILE, "utf8");
    const arr = JSON.parse(raw);
    const now = Date.now();
    parsedCache = new Map(arr.filter(([_, v]) => now - (v?.savedAt||0) < PARSED_TTL_MS));
    log(`parsed_cache loaded: ${parsedCache.size}`);
  }catch{ parsedCache = new Map(); }
}
function saveParsedCache(threshold=100){
  if (parsedCache.size % threshold !== 0) return;
  try{
    const entries = [...parsedCache.entries()];
    if (entries.length > PARSED_MAX) entries.sort((a,b)=> (a[1]?.savedAt||0) - (b[1]?.savedAt||0));
    const trimmed = entries.slice(-PARSED_MAX);
    fs.writeFileSync(PARSED_CACHE_FILE, JSON.stringify(trimmed), "utf8");
  }catch(e){ dbg("saveParsedCache err:", e.message); }
}
loadParsedCache();

async function getParsedCached(pubkey){
  const hit = parsedCache.get(pubkey);
  if (hit && Date.now() - (hit.savedAt||0) < PARSED_TTL_MS) return hit.value;
  try{
    const info = await getParsedAccountInfo(pubkey);
    parsedCache.set(pubkey, { savedAt: Date.now(), value: info });
    saveParsedCache();
    return info;
  }catch{
    parsedCache.set(pubkey, { savedAt: Date.now(), value: null });
    saveParsedCache();
    return null;
  }
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

// ===== Util =====
function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m} minutes ago`;
  const h = Math.floor(m/60); if (h<24) return `${h} hours ago`;
  const d = Math.floor(h/24); return `${d} days ago`;
}
function isAllowedQuote(q) {
  if (!q || ALLOWED_QUOTES.length === 0) return true;
  return ALLOWED_QUOTES.includes(q);
}

// ===== 1) Base/Quote feloldás (olcsótól a drágáig) =====
function resolveByBalanceDiff(tx, lpMint) {
  const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
  const key = (b) => `${b?.accountIndex || 0}|${b?.mint || ""}`;
  const preMap = new Map(pre.map(b => [key(b), b]));
  const changes = [];
  for (const b of post) {
    const k = key(b), p = preMap.get(k), mint = b?.mint;
    if (!mint || mint === lpMint) continue;
    const dec = Number(b?.uiTokenAmount?.decimals || 0);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0);
    const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
    const diffAbs = Math.abs(postAmt - preAmt) / (10 ** dec);
    if (diffAbs > 0) changes.push({ mint, diffAbs });
  }
  const byMint = new Map();
  for (const c of changes) byMint.set(c.mint, (byMint.get(c.mint)||0) + c.diffAbs);
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
  const keys = [...rayAccounts].slice(0, Math.min(MAX_RAY_ACCTS_SCAN, 300));
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

// ===== Telegram (queue + throttle) =====
const tgQ=[]; let tgSending=false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQ.push(text); if (tgSending) return; tgSending=true;
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

// ===== MAIN =====
async function processSignature(sig){
  // Perzisztens dedup
  if (sentMap.has(sig)) { dbg("skip already sent sig:", sig); return; }

  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];

  // Raydium accountok a tx-ben
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }
  // plusz accountKeys
  const msgKeys = tx?.transaction?.message?.accountKeys || [];
  for (const k of msgKeys) {
    const pk = typeof k === "string" ? k : (k?.pubkey || k?.toString?.());
    if (pk) rayAccounts.add(pk);
  }

  // Tokenkeg Burn → LP mint (STRICT: a mintnek benne kell lennie a rayAccounts-ban és valid mint legyen)
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid!==TOKENKEG) continue;
    const isBurn = ix?.parsed?.type==="burn" || ix?.instructionName==="Burn";
    if (!isBurn) continue;
    const cand = ix?.parsed?.info?.mint || ix?.mint;
    if (!cand) continue;
    if (!rayAccounts.has(cand)) { dbg("skip burn: mint not among Raydium accounts", cand); continue; }
    const mintInfo = await isMintAccount(cand);
    if (!mintInfo) { dbg("skip burn: not a valid mint account", cand); continue; }
    lpMint = cand;
    burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
    break;
  }
  if (!lpMint){ dbg("no LP mint match (strict)"); return; }

  // LP supply + burn%
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

  // Becsült SOL (WSOL vault * burn%) – olcsón, limitált scan
  let wsolVaultRaw=0, wsolDecimals=9, checked=0;
  for (const a of rayAccounts){
    if (checked++>Math.min(120, MAX_RAY_ACCTS_SCAN)) break;
    const acc = await tokenAccountInfo(a);
    if (acc?.mint===WSOL_MINT){
      const ta = acc?.tokenAmount;
      if (ta?.amount) wsolVaultRaw = Number(ta.amount);
      if (ta?.decimals!=null) wsolDecimals = Number(ta.decimals)||9;
      break;
    }
  }
  const estSolOut = burnShare * (wsolVaultRaw/Math.pow(10,wsolDecimals));
  if (MIN_SOL_BURN>0 && estSolOut < MIN_SOL_BURN){
    dbg(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN}) sig=${sig}`);
    return;
  }

  // Base/Quote feloldás — KÖTELEZŐ, különben skip
  let res = resolveByBalanceDiff(tx, lpMint);
  if (!res.baseMint){
    if (TRY_BALDIFF_ONLY) { dbg("skip: baldiff-only mode, no base"); return; }
    res = await resolveByVaultsBatch(rayAccounts, lpMint);
  }
  const { baseMint, quoteMint, source } = res;
  if (!baseMint || !quoteMint || baseMint === quoteMint){
    dbg("skip: could not resolve distinct base+quote mints");
    return;
  }

  // Dexscreener (base mintről)
  const dx = await fetchDexscreenerByToken(baseMint);
  if (!dx){ dbg("skip: no dexs data"); return; }

  // Max token age (opcionális)
  if (MAX_TOKEN_AGE_MIN > 0) {
    const createdAt = dx?.createdAt ? Number(dx.createdAt) : null;
    if (!createdAt) { dbg("skip: no pairCreatedAt (age unknown)"); return; }
    const ageMin = (Date.now() - createdAt) / 60000;
    if (ageMin > MAX_TOKEN_AGE_MIN) { dbg(`skip: token age ${ageMin.toFixed(1)}min > max ${MAX_TOKEN_AGE_MIN}min`); return; }
  }

  // Dex-szűrők (opcionális)
  if (REQUIRE_RAYDIUM && (dx?.dexId||"").toLowerCase()!=="raydium") { dbg("skip: not raydium pair"); return; }
  if (MIN_LIQ_USD && (dx.liq||0) < MIN_LIQ_USD) { dbg(`skip: liq ${dx.liq} < ${MIN_LIQ_USD}`); return; }
  const cap = (dx.mcap || dx.fdv || 0);
  if (MIN_FDV_USD && cap < MIN_FDV_USD) { dbg(`skip: cap ${cap} < ${MIN_FDV_USD}`); return; }
  if (MIN_PRICE_USD && (dx.price||0) < MIN_PRICE_USD) { dbg(`skip: price ${dx.price} < ${MIN_PRICE_USD}`); return; }
  if (!isAllowedQuote(quoteMint)) { dbg("skip: quote not allowed", quoteMint); return; }

  // Meta/security (olcsó, cache-elt) — posztban csak jelzés
  let mintAuthNone=null, freezeNone=null, metaMutable=null;
  try{
    const mi = await getParsedCached(baseMint);
    const info = mi?.value?.data?.parsed?.info;
    mintAuthNone = (info?.mintAuthority===null || info?.mintAuthority===undefined);
    freezeNone   = (info?.freezeAuthority===null || info?.freezeAuthority===undefined);
  }catch{}
  try {
    const accs = await getProgramAccounts(METAPLEX_META, [{ memcmp: { offset: 1 + 32, bytes: baseMint } }]);
    if (Array.isArray(accs) && accs.length>0) {
      const dataB64 = accs[0]?.account?.data?.[0];
      if (dataB64) {
        const buf = Buffer.from(dataB64, "base64");
        let o = 0; const readU8=()=>buf[o++]; const readU32=()=>{const v=buf.readUInt32LE(o);o+=4;return v;}; const skipPk=()=>{o+=32;};
        readU8(); skipPk(); skipPk(); const nameLen=readU32(); o+=nameLen; const symLen=readU32(); o+=symLen; const uriLen=readU32(); o+=uriLen;
        o+=2; const hasCr = readU8(); if (hasCr===1){ const n=readU32(); for (let i=0;i<n;i++){ skipPk(); o+=1; o+=1; } }
        o+=1; metaMutable = !!readU8();
      }
    }
  } catch {}

  // Üzenet (csak base Token Mint a kérésed szerint)
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
    DEBUG ? `\n<code>mint_source=${source}</code>` : null
  ].filter(Boolean);

  // Dedup + per-token cooldown
  sentMap.set(sig, Date.now()); saveSent();
  if (MINT_COOLDOWN_MIN > 0) {
    globalThis.__mintLastSent = globalThis.__mintLastSent || new Map();
    const last = globalThis.__mintLastSent.get(baseMint) || 0;
    const since = (Date.now() - last) / 60000;
    if (since < MINT_COOLDOWN_MIN) { dbg(`skip: cooldown ${since.toFixed(1)}min < ${MINT_COOLDOWN_MIN}min for ${baseMint}`); return; }
    globalThis.__mintLastSent.set(baseMint, Date.now());
  }

  await sendTelegram(lines.join("\n"));
  log(`TG → ${headTitle} | burn=${burnPct}% | sig=${sig}`);
}

// ===== WS (logsSubscribe + heartbeat) =====
let ws, pingTimer, lastPong=Date.now();
function wsSend(obj){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  wsSend({ jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] });
}
function startHeartbeat(){
  stopHeartbeat();
  pingTimer = setInterval(()=>{
    if (!ws || ws.readyState!==ws.OPEN) return;
    try { ws.ping?.(); } catch {}
    if (Date.now() - lastPong > 60000) { try{ ws.terminate?.(); }catch{} }
  }, 20000);
}
function stopHeartbeat(){ if (pingTimer) clearInterval(pingTimer); pingTimer=null; }

function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = () => { log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); startHeartbeat(); };
  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      if (data?.method === "ping" || data?.result === "pong") { lastPong=Date.now(); return; }
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length===0) return;
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn/i.test(l));
      if (!hasBurnLog) return;
      await enqueueSignature(sig);
    }catch(e){ dbg("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); stopHeartbeat(); setTimeout(connectWS,3000); };
  ws.onerror = (e)=>{ dbg("WS error:", e?.message || String(e)); };
  ws.on("pong", ()=>{ lastPong=Date.now(); });
}
connectWS();
