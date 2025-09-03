// Raydium LP burn watcher → TG (Dexs + on-chain)
// WS (nem enhanced): "Instruction: Burn" előszűrés
// 1 tx/s limit (írj át 2000-re ha 2 mp-enként akarod), TG throttle, MIN_SOL_BURN küszöb
// Base/Quote: (1) balance-diff → (2) pool state RAW scan → (3) largest vaults → (4) freq fallback

import WebSocket from "ws";
import http from "http";

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);
const DEBUG = process.env.DEBUG === "1";
const RATE_MS = Number(process.env.RATE_MS || 1000); // írd át 2000-re ha 2s kell

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

http.createServer((_, res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ===== JSON-RPC =====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const r = await fetch(RPC_HTTP, { method:"POST", headers:{ "content-type":"application/json" }, body });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json(); if (j.error) throw new Error(`RPC ${method} err: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTransaction(signature, tries=3){
  for (let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction",[signature,{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
    }catch(e){
      log(`getTransaction fail (${i+1}/${tries}) ${signature}:`, e.message);
      if (i<tries-1) await new Promise(r=>setTimeout(r,1500*(i+1)));
    }
  }
  return null;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo",[pubkey,{commitment:"confirmed"}]); }
async function getAccountInfoRaw(pubkey){ return rpc("getAccountInfo",[pubkey,{commitment:"confirmed",encoding:"base64"}]); }
async function getTokenLargestAccounts(mint){ return rpc("getTokenLargestAccounts",[mint,{commitment:"confirmed"}]); }
async function getProgramAccounts(programId, filters=[]) {
  return rpc("getProgramAccounts", [ programId, { commitment:"confirmed", encoding:"base64", filters } ]);
}

// cache
const parsedCache = new Map();
async function getParsedCached(pubkey){
  if (parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try{ const info = await getParsedAccountInfo(pubkey); parsedCache.set(pubkey,info); return info; }
  catch{ parsedCache.set(pubkey,null); return null; }
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
    if (!r.ok) { dbg("dexs HTTP", r.status); return null; }
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) { dbg("dexs pairs=0"); return null; }
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    const out = {
      name:   p?.baseToken?.name   || null,
      symbol: p?.baseToken?.symbol || null,
      price:  p?.priceUsd ? Number(p.priceUsd) : null,
      liq:    p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv:    p?.fdv ? Number(p.fdv) : null,
      mcap:   p?.marketCap ? Number(p.marketCap) : null,
      url:    p?.url || null
    };
    dbg("dexs ok:", out);
    return out;
  }catch(e){ dbg("dexs err:", e.message); return null; }
}

// ===== Metaplex metadata =====
async function fetchMetaplexMetadata(mint) {
  try {
    const accs = await getProgramAccounts(METAPLEX_META, [{ memcmp: { offset: 1 + 32, bytes: mint } }]);
    if (!Array.isArray(accs) || accs.length === 0) return null;
    const dataB64 = accs[0]?.account?.data?.[0];
    if (!dataB64) return null;
    const buf = Buffer.from(dataB64, "base64");
    let o = 0;
    const readU8  = () => buf[o++];
    const readU16 = () => { const v = buf.readUInt16LE(o); o+=2; return v; };
    const readU32 = () => { const v = buf.readUInt32LE(o); o+=4; return v; };
    const readStr = () => { const len = readU32(); const s = buf.slice(o, o+len).toString("utf8"); o += len; return s; };
    const skipPk = () => { o += 32; };
    readU8(); skipPk(); skipPk(); // key + updateAuth + mint
    const name   = readStr().trim();
    const symbol = readStr().trim();
    readStr(); readU16();
    const hasCreators = readU8();
    if (hasCreators === 1) { const n = readU32(); for (let i=0;i<n;i++){ skipPk(); readU8(); readU8(); } }
    readU8();
    const isMutable = !!readU8();
    return { name, symbol, isMutable };
  } catch { return null; }
}

// ===== Base58 encode =====
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(buf){
  if (!buf || !buf.length) return "";
  let x = [...buf];
  let zeros = 0;
  while (zeros < x.length && x[zeros] === 0) zeros++;
  const b58 = [];
  let start = zeros;
  while (start < x.length) {
    let carry = 0;
    for (let i = start; i < x.length; i++) {
      const v = (x[i] & 0xff) + carry * 256;
      x[i] = (v / 58) | 0;
      carry = v % 58;
    }
    b58.push(ALPHABET[carry]);
    while (start < x.length && x[start] === 0) start++;
  }
  for (let i = 0; i < zeros; i++) b58.push("1");
  return b58.reverse().join("");
}

// ===== Telegram =====
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
      await new Promise(r=>setTimeout(r, RATE_MS)); // ← állítsd 2000-re ha 2 mp
    }
    workerRunning=false;
  }
}

// ===== Utils =====
function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m} minutes ago`;
  const h = Math.floor(m/60); if (h<24) return `${h} hours ago`;
  const d = Math.floor(h/24); return `${d} days ago`;
}

// ===== 1) Mints a balance-diffből =====
function resolveMintsByBalanceDiff(tx, lpMint) {
  const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];

  const key = (b) => `${b?.accountIndex || 0}|${b?.mint || ""}`;
  const preMap = new Map(pre.map(b => [key(b), b]));
  const changes = [];

  for (const b of post) {
    const k = key(b);
    const p = preMap.get(k);
    const mint = b?.mint;
    if (!mint || mint === lpMint) continue;

    const dec = Number(b?.uiTokenAmount?.decimals || 0);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0);
    const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
    const diffRaw = postAmt - preAmt;
    const diffAbs = Math.abs(diffRaw) / (10 ** dec);

    if (diffAbs > 0) changes.push({ mint, diffAbs });
  }

  const byMint = new Map();
  for (const c of changes) byMint.set(c.mint, (byMint.get(c.mint) || 0) + c.diffAbs);
  const ranked = [...byMint.entries()].sort((a,b)=>b[1]-a[1]);
  dbg("balDiff ranked:", ranked.slice(0,4));

  if (ranked.length >= 2) {
    const [m1, m2] = ranked.slice(0,2).map(x=>x[0]);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint: m2, quoteMint: m1, source: "baldiff" };
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint: m1, quoteMint: m2, source: "baldiff" };
    return { baseMint: m1, quoteMint: m2, source: "baldiff" };
  }
  return { baseMint: null, quoteMint: null, source: "baldiff-none" };
}

// ===== 2) Mints a pool state RAW accountból =====
async function resolveMintsFromState(rayAccounts, lpMint) {
  const stateCandidates = [];
  for (const acc of rayAccounts) {
    try{
      const info = await getAccountInfoRaw(acc);
      const owner = info?.value?.owner;
      if (owner === RAY_AMM_V4 || owner === RAY_CPMM) {
        const b64 = info?.value?.data?.[0];
        if (b64) stateCandidates.push(Buffer.from(b64, "base64"));
      }
      if (stateCandidates.length >= 6) break;
    }catch{}
  }
  dbg("stateCandidates:", stateCandidates.length);
  for (const buf of stateCandidates) {
    const seen = new Set();
    const found = [];
    for (let off = 0; off + 32 <= buf.length; off++) {
      const pk = bs58encode(buf.slice(off, off + 32));
      if (seen.has(pk)) continue; seen.add(pk);
      if (pk.length < 32 || pk.length > 44) continue;
      if (pk === lpMint) continue;
      const mintInfo = await isMintAccount(pk);
      if (mintInfo) {
        found.push(pk);
        if (found.length > 4) break;
      }
    }
    const uniq = [...new Set(found)];
    dbg("state found uniq mints:", uniq.length, uniq.slice(0,4));
    if (uniq.length === 2) {
      const [m1, m2] = uniq;
      if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint:m2, quoteMint:m1, source:"state" };
      if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint:m1, quoteMint:m2, source:"state" };
      return { baseMint:m1, quoteMint:m2, source:"state" };
    }
  }
  return { baseMint:null, quoteMint:null, source:"state-none" };
}

// ===== 3) Largest vaults =====
async function resolveMintsByLargestVaults(rayAccounts, lpMint){
  const vaults = [];
  let checked = 0;
  for (const a of rayAccounts){
    if (checked++ > 120) break;
    const ta = await tokenAccountInfo(a);
    if (!ta) continue;
    const mint = ta?.mint;
    if (!mint || mint === lpMint) continue;
    const amt = Number(ta?.tokenAmount?.amount || 0);
    vaults.push({ mint, amt });
  }
  vaults.sort((a,b)=>b.amt - a.amt);
  const top = vaults.slice(0, 6);
  dbg("vaults top:", top.map(v=>({mint:v.mint, amt:v.amt})));
  const uniqMints = [...new Set(top.map(v=>v.mint))];
  if (uniqMints.length >= 2){
    const [m1, m2] = uniqMints.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint:m2, quoteMint:m1, source:"largest" };
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint:m1, quoteMint:m2, source:"largest" };
    return { baseMint:m1, quoteMint:m2, source:"largest" };
  }
  return { baseMint:null, quoteMint:null, source:"largest-none" };
}

// ===== 4) Fallback: vault mint frekvencia =====
async function resolveMintsFallback(rayAccounts, lpMint){
  const freq = new Map();
  let checked = 0;
  for (const a of rayAccounts){
    if (checked++ > 120) break;
    const ta = await tokenAccountInfo(a);
    const m = ta?.mint;
    if (m && m !== lpMint) freq.set(m, (freq.get(m)||0) + 1);
  }
  const sorted = [...freq.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  dbg("freq sorted:", sorted.slice(0,4));
  if (sorted.length >= 2){
    const [m1,m2] = sorted.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return { baseMint:m2, quoteMint:m1, source:"freq" };
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return { baseMint:m1, quoteMint:m2, source:"freq" };
    return { baseMint:m1, quoteMint:m2, source:"freq" };
  }
  return { baseMint:null, quoteMint:null, source:"freq-none" };
}

// ===== Main =====
async function processSignature(sig){
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];

  // --- Raydium accountok ---
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }
  // + message accountKeys is
  const msgKeys = tx?.transaction?.message?.accountKeys || [];
  for (const k of msgKeys) {
    const pk = typeof k === "string" ? k : (k?.pubkey || k?.toString?.());
    if (pk) rayAccounts.add(pk);
  }
  dbg("rayAccounts count:", rayAccounts.size);

  // --- Tokenkeg: Burn + LP mint (soft-accept) ---
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid!==TOKENKEG) continue;
    const isBurn = ix?.parsed?.type==="burn" || ix?.instructionName==="Burn";
    if (!isBurn) continue;
    const cand = ix?.parsed?.info?.mint || ix?.mint;
    if (!cand) continue;

    if (rayAccounts.has(cand)) {
      lpMint = cand;
    } else {
      if (DEBUG) console.log(new Date().toISOString(), "[DBG] LP mint NOT in rayAccounts → soft-accept", cand);
      lpMint = cand;
    }
    burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
    break;
  }
  if (!lpMint){ dbg("no LP mint match"); return; }
  dbg("LP mint:", lpMint, "burnAmountRaw:", burnAmountRaw);

  // --- LP supply/decimals + burn% ---
  let lpSupplyPost=0, lpDecimals=0;
  try{
    const mi = await getParsedCached(lpMint);
    const d = mi?.value?.data?.parsed?.info;
    if (d?.supply) lpSupplyPost = Number(d.supply);
    if (d?.decimals!=null) lpDecimals = Number(d.decimals)||0;
  }catch{}
  const lpSupplyPre = lpSupplyPost + burnAmountRaw;
  const burnShare = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre) : 0;

  // --- SOL küszöb WSOL vault alapján ---
  let wsolVaultRaw=0, wsolDecimals=9; let checked=0;
  for (const a of rayAccounts){
    if (checked++>80) break;
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
    log(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN}) sig=${sig}`);
    return;
  }

  // --- Base/Quote mints: 4-lépcsős (balDiff → state → largest → freq) ---
  let res = resolveMintsByBalanceDiff(tx, lpMint);
  if (!res.baseMint){ const r1 = await resolveMintsFromState(rayAccounts, lpMint); if (r1.baseMint) res = r1; }
  if (!res.baseMint){ const r2 = await resolveMintsByLargestVaults(rayAccounts, lpMint); if (r2.baseMint) res = r2; }
  if (!res.baseMint){ const r3 = await resolveMintsFallback(rayAccounts, lpMint); if (r3.baseMint) res = r3; }
  const { baseMint, quoteMint, source } = res;
  dbg("mint resolution:", { baseMint, quoteMint, source });

  // --- Base token on-chain + Metaplex ---
  let totalSupply=0, baseDecimals=0, mintAuthNone=null, freezeNone=null;
  let metaName=null, metaSymbol=null, metaMutable=null;
  if (baseMint){
    try{
      const mi = await getParsedCached(baseMint);
      const info = mi?.value?.data?.parsed?.info;
      totalSupply = info?.supply ? Number(info.supply) : 0;
      baseDecimals = info?.decimals!=null ? Number(info.decimals) : 0;
      mintAuthNone = (info?.mintAuthority===null || info?.mintAuthority===undefined);
      freezeNone   = (info?.freezeAuthority===null || info?.freezeAuthority===undefined);
    }catch{}
    const md = await fetchMetaplexMetadata(baseMint);
    if (md){ metaName = md.name || null; metaSymbol = md.symbol || null; metaMutable = md.isMutable; }
  }
  const totalSupplyUi = baseDecimals ? (totalSupply/10**baseDecimals) : (totalSupply||0);

  // Holders
  let holdersLines=[];
  if (baseMint){
    try{
      const largest = await getTokenLargestAccounts(baseMint);
      const arr = Array.isArray(largest?.value) ? largest.value.slice(0,5) : [];
      holdersLines = arr.map(x=>{
        const addr = x?.address || "";
        const amt  = Number(x?.amount || 0);
        const pct  = totalSupply>0 ? (amt/totalSupply*100) : 0;
        const short = addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : "–";
        return `├ ${short} | ${amt.toLocaleString()} | ${pct.toFixed(2)}%`;
      });
    }catch(e){ dbg("holders err:", e.message); }
  }

  // Dexscreener
  let dx=null; if (baseMint) dx = await fetchDexscreenerByToken(baseMint);

  // --- Üzenet ---
  const when = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
  const link = `https://solscan.io/tx/${sig}`;
  const burnPct = (burnShare*100).toFixed(2);

  if (dx){
    const headTitle = (dx.name && dx.symbol) ? `${dx.name} (${dx.symbol})` : "Raydium LP Burn";
    const mcapStr = dx.mcap!=null ? `$${dx.mcap.toLocaleString()}` : (dx.fdv!=null?`$${dx.fdv.toLocaleString()}`:"n/a");
    const liqStr  = dx.liq!=null  ? `$${dx.liq.toLocaleString()}` : "n/a";
    const priceStr= dx.price!=null? `$${dx.price}` : "n/a";

    const lines = [
      `Solana LP Burns`,
      `<b>${headTitle}</b>`,
      "",
      `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
      when ? `🕒 <b>Trading Start Time:</b> ${ago(tx.blockTime*1000)}` : `🕒 <b>Trading Start Time:</b> n/a`,
      "",
      `📊 <b>Marketcap:</b> ${mcapStr}`,
      `💧 <b>Liquidity:</b> ${liqStr}`,
      `💲 <b>Price:</b> ${priceStr}`,
      "",
      baseMint ? `🧾 <b>Base Mint:</b> <code>${baseMint}</code>` : `🧾 <b>Base Mint:</b> n/a`,
      `📜 <b>LP Mint:</b> <code>${lpMint}</code>`,
      "",
      `⚙️ <b>Security:</b>`,
      `├ Mutable Metadata: ${metaMutable===null ? "n/a" : (metaMutable ? "Yes ❌" : "No ✅")}`,
      `├ Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
      `└ Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`,
      "",
      `👥 <b>Top Holders:</b>`,
      ...(holdersLines.length ? holdersLines : ["├ n/a"]),
      "",
      dx.url ? dx.url : null,
      `🔗 <a href="${link}">Solscan</a>`,
      DEBUG ? `\n<code>mint_source=${source}</code>` : null
    ].filter(Boolean);
    await sendTelegram(lines.join("\n"));
    log(`TG card (Dexs) → ${headTitle} | burn=${burnPct}% | sig=${sig}`);
  } else {
    const msg = [
      "🔥 <b>Raydium LP BURN</b>",
      `Mint: <code>${lpMint}</code>`,
      `Amount: ${burnAmountRaw}`,
      `Est. SOL from LP: ${estSolOut.toFixed(4)} SOL`,
      when ? `Time: ${when}` : null,
      `Sig: <a href="${link}">${sig}</a>`,
      DEBUG && baseMint ? `\n<code>mint_source=${source} base=${baseMint}</code>` : null
    ].filter(Boolean).join("\n");
    await sendTelegram(msg);
    log(`TG simple → burn=${burnPct}% | sig=${sig}`);
  }
}

// ===== WebSocket =====
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
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn/i.test(l));
      if (!hasBurnLog) return;
      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=>{ log("WS error:", e?.message || String(e)); };
}
connectWS();
