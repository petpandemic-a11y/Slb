// Raydium LP burn watcher (Helius WS - nem enhanced) + RÉSZLETES DEBUG
// - logsSubscribe (Raydium AMM v4 + CPMM)
// - csak akkor fetch-el, ha Burn-hint van (de most debug-ként dumpolja a logok elejét, ha nincs)
// - rate limiter (1 getTransaction / sec)
// - retry/backoff RPC hívások
// - becsült SOL-kihozatal + MIN_SOL_BURN küszöb
// - Telegram (opcionális)

import WebSocket from "ws";
import http from "http";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";
const DEXS_ENABLED = process.env.DEXS_ENABLED !== "0";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);
const LOG_DUMP_LINES = Number(process.env.LOG_DUMP_LINES || 8);

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

// Quote mint jelöltek
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

// ==== logger + helpers ====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const maskUrl = (u) => {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch { return u; }
};

http.createServer((_, res) => { res.writeHead(200, {"content-type":"text/plain"}); res.end("ok\n"); })
  .listen(PORT, () => {
    log("Service booted.");
    log("ENV PORT:", PORT);
    log("ENV RPC_HTTP:", maskUrl(RPC_HTTP));
    log("ENV RPC_WSS:", maskUrl(RPC_WSS));
    log("ENV TG enabled:", !!(TG_BOT_TOKEN && TG_CHAT_ID));
    log("ENV DEXS_ENABLED:", DEXS_ENABLED);
    log("ENV MIN_SOL_BURN:", MIN_SOL_BURN);
    log("ENV LOG_DUMP_LINES:", LOG_DUMP_LINES);
  });

// ==== JSON-RPC ====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let r;
  try {
    r = await fetch(RPC_HTTP, { method:"POST", headers:{ "content-type":"application/json" }, body });
  } catch (e) {
    log(`RPC ${method} network error:`, e.message);
    throw e;
  }
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo", [pubkey, {commitment:"confirmed"}]); }
async function getTokenLargestAccounts(mint){ return rpc("getTokenLargestAccounts", [mint, {commitment:"confirmed"}]); }
async function getTransaction(signature, tries = 3) {
  for (let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction", [signature, {encoding:"jsonParsed", maxSupportedTransactionVersion:0}]);
    } catch(e){
      log(`getTransaction fail (${i+1}/${tries}) for ${signature}:`, e.message);
      if (i<tries-1) await new Promise(r=>setTimeout(r, 1500*(i+1)));
    }
  }
  return null;
}

// ==== Dexscreener (opcionális) ====
async function fetchDexsByToken(mint){
  if (!DEXS_ENABLED) return null;
  try{
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const r = await fetch(url, { headers:{accept:"application/json"} });
    if (!r.ok){ log("Dexscreener HTTP", r.status); return null; }
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    if (!p) return null;
    return {
      tokenSymbol: p.baseToken?.symbol || p.baseToken?.address?.slice(0,4)+"…",
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv: p.fdv ? Number(p.fdv) : null,
      mcap: p.marketCap ? Number(p.marketCap) : null,
      dex: p.dexId || "",
      pairUrl: p.url || ""
    };
  }catch(e){ log("Dexscreener err:", e.message); return null; }
}

// ==== Telegram (queue + throttle) ====
const tgQueue = []; let tgSending = false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID){ log("TG disabled, message skipped."); return; }
  tgQueue.push(text);
  if (tgSending) return;
  tgSending = true;
  while (tgQueue.length){
    const msg = tgQueue.shift();
    try{
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      if (r.status===429){
        let wait=3000;
        try{ const jr=await r.json(); if (jr?.parameters?.retry_after) wait=jr.parameters.retry_after*1000; }catch{}
        log("TG 429, retry after", wait,"ms");
        await new Promise(res=>setTimeout(res, wait));
        tgQueue.unshift(msg);
      }else{
        log("TG sent OK");
        await new Promise(res=>setTimeout(res, 1200));
      }
    }catch(e){ log("TG send err:", e.message); await new Promise(res=>setTimeout(res,2000)); }
  }
  tgSending=false;
}

// ==== Rate limiter getTransaction (1/sec) ====
const sigQueue = []; const seenSig = new Set(); let workerRunning = false;
async function enqueueSignature(sig){
  if (seenSig.has(sig)){ log("enqueue skip (dup):", sig); return; }
  seenSig.add(sig);
  sigQueue.push(sig);
  log("enqueue", sig, "queueLen=", sigQueue.length);
  if (!workerRunning){
    workerRunning = true;
    while (sigQueue.length){
      const s = sigQueue.shift();
      log("worker processing", s, "remaining=", sigQueue.length);
      try{ await processSignature(s); }catch(e){ log("processSignature err:", e.message); }
      await new Promise(r=>setTimeout(r, 1000));
    }
    workerRunning = false;
  }
}

// ==== utils ====
function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h<24) return `${h}h ago`;
  const d = Math.floor(h/24); return `${d}d ago`;
}
const parsedCache = new Map();
async function getParsedCached(pubkey){
  if (parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try{
    const info = await getParsedAccountInfo(pubkey);
    parsedCache.set(pubkey, info);
    return info;
  }catch(e){
    parsedCache.set(pubkey, null);
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

// ===== fő feldolgozás =====
async function processSignature(sig){
  const tx = await getTransaction(sig);
  if (!tx){ log("no tx, abort", sig); return; }

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x => x?.instructions || []);
  const all = [...top, ...inner];

  // Raydium accounts
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts || []).map(a => typeof a==="string" ? a : (a?.pubkey || a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // LP burn keresés
  let lpMint=null, burnAmount=0;
  for (const ix of all){
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;
    const isBurn = ix?.parsed?.type === "burn" || ix?.instructionName === "Burn";
    if (!isBurn) continue;
    const mint = ix?.parsed?.info?.mint || ix?.mint;
    if (mint && rayAccounts.has(mint)){
      lpMint = mint;
      burnAmount = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
      break;
    }
  }
  if (!lpMint) { log("no LP burn (Tokenkeg Burn not matching Raydium accounts)"); return; }

  const blockTimeMs = tx?.blockTime ? tx.blockTime*1000 : Date.now();

  // LP mint info
  let supplyPost=0, mintAuthNone=null, freezeNone=null, lpDecimals=0;
  try{
    const info = await getParsedCached(lpMint);
    const d = info?.value?.data?.parsed?.info;
    if (d?.supply) supplyPost = Number(d.supply);
    if (d?.decimals!=null) lpDecimals = Number(d.decimals) || 0;
    mintAuthNone = (d?.mintAuthority===null || d?.mintAuthority===undefined);
    freezeNone   = (d?.freezeAuthority===null || d?.freezeAuthority===undefined);
  }catch(e){ log("mint info err:", e.message); }
  const supplyPre = supplyPost + burnAmount;
  const share = supplyPre>0 ? (burnAmount/supplyPre) : 0;

  // WSOL vault becslés
  let wsolVaultAmountRaw=0, wsolDecimals=9;
  const MAX_CHECK=25; let checked=0;
  for (const a of rayAccounts){
    if (checked>=MAX_CHECK) break; checked++;
    const acc = await tokenAccountInfo(a);
    if (!acc) continue;
    if (acc?.mint === WSOL_MINT){
      const ta = acc?.tokenAmount;
      if (ta?.amount) wsolVaultAmountRaw = Number(ta.amount);
      if (ta?.decimals!=null) wsolDecimals = Number(ta.decimals)||9;
      break;
    }
  }
  const wsolVaultSOL = wsolVaultAmountRaw / Math.pow(10, wsolDecimals);
  const estSolOut = share * wsolVaultSOL;

  if (MIN_SOL_BURN>0 && estSolOut < MIN_SOL_BURN){
    log(`SKIP by MIN_SOL_BURN: ${estSolOut.toFixed(4)} < ${MIN_SOL_BURN}`);
    return;
  }

  // Underlying token mints (Dexs)
  const candidateMints=[]; let uChecked=0;
  for (const a of rayAccounts){
    if (a===lpMint) continue;
    if (uChecked>=MAX_CHECK) break; uChecked++;
    const m = await isMintAccount(a);
    if (m) candidateMints.push(a);
    if (candidateMints.length>=3) break;
  }
  const underlying = candidateMints.filter(m => m !== lpMint);
  let baseMint=null, quoteMint=null;
  if (underlying.length>=2){
    const [m1,m2] = underlying.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) { quoteMint=m1; baseMint=m2; }
    else if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) { quoteMint=m2; baseMint=m1; }
    else { baseMint=m1; quoteMint=m2; }
  }

  let dexs=null;
  if (DEXS_ENABLED && baseMint){
    dexs = await fetchDexsByToken(baseMint);
  }

  // Top LP holders
  let holdersLines=[];
  try{
    const largest = await getTokenLargestAccounts(lpMint);
    const arr = Array.isArray(largest?.value) ? largest.value.slice(0,3) : [];
    holdersLines = arr.map(x=>{
      const addr = x?.address || "";
      const amt  = Number(x?.amount || 0);
      const pct  = supplyPost>0 ? ((amt/supplyPost)*100) : 0;
      const short = addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : "–";
      return `├ ${short} | ${amt.toLocaleString()} | ${pct.toFixed(2)}%`;
    });
  }catch(e){ log("largest holders err:", e.message); }

  // Üzenet
  const header     = "🔥 <b>Raydium LP Burn</b>";
  const whenLine   = `🕒 <b>Time:</b> ${new Date(blockTimeMs).toISOString()} (${ago(blockTimeMs)})`;
  const burnPct    = supplyPre>0 ? (share*100) : 0;
  const burnLine   = `🔥 <b>Burn %:</b> ${burnPct.toFixed(2)}%`;
  const amountLP   = burnAmount / Math.pow(10, lpDecimals||0);
  const amountLine = `💧 <b>Amount (LP):</b> ${amountLP.toLocaleString()}`;
  const solLine    = `🟡 <b>Est. SOL from LP:</b> ${estSolOut.toFixed(4)} SOL`;
  const lpLine     = `🧾 <b>LP Mint:</b> <code>${lpMint}</code>`;
  const pairLine   = baseMint ? `🔀 <b>Pair:</b> <code>${baseMint}</code> / ${quoteMint ? `<code>${quoteMint}</code>` : "?"}` : `🔀 <b>Pair:</b> n/a`;
  const secLines = [
    "🌐 <b>Security (LP):</b>",
    `├ Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`
  ];
  const holdersTitle = "👥 <b>Top Holders (LP):</b>";
  const holdersBlock = holdersLines.length ? holdersLines.join("\n") : "├ n/a";
  const priceBlock = dexs ? [
    "",
    "💹 <b>Market</b>",
    `├ Price: ${dexs.priceUsd!=null ? `$${dexs.priceUsd}` : "n/a"}`,
    `├ Liquidity: ${dexs.liquidityUsd!=null ? `$${dexs.liquidityUsd.toLocaleString()}` : "n/a"}`,
    `└ FDV/MC: ${dexs.fdv!=null ? `$${dexs.fdv.toLocaleString()}` : (dexs.mcap!=null ? `$${dexs.mcap.toLocaleString()}` : "n/a")}  (${dexs.dex || ""})`,
    dexs.pairUrl ? `${dexs.pairUrl}` : ""
  ] : [];
  const sigLine = `🔗 <a href="https://solscan.io/tx/${sig}">Solscan</a>`;

  const msg = [
    header, burnLine, whenLine, amountLine, solLine, lpLine, pairLine, "",
    ...secLines, "", holdersTitle, holdersBlock, ...priceBlock, "", sigLine
  ].join("\n");

  log("FINAL MSG (plain):", msg.replace(/<[^>]+>/g,""));
  await sendTelegram(msg);
}

// ==== WebSocket (Helius WSS) + DEBUG dump ====
let ws;
function wsSend(obj){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  const msg = { jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] };
  wsSend(msg);
}

function connectWS(){
  log("Starting connectWS…", maskUrl(RPC_WSS));
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM,   1002);
    log("WS subscribed to Raydium programs");
  };

  ws.onmessage = async (ev) => {
    try{
      const data = JSON.parse(ev.data.toString());
      if (data?.result && data?.id){ log("WS sub ack id:", data.id, "sub:", data.result); return; }

      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig){ return; }
      log("WS event:", sig, "logsLen=", logsArr.length);

      // Burn hint keresés
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn/i.test(l));
      if (!hasBurnLog) {
        // DEBUG: mintát dobunk a logokból + Tokenkeg invoke számlálás
        const tokenInvokeCnt = logsArr.filter(l => typeof l==="string" && l.includes(`Program ${TOKENKEG} invoke`)).length;
        const sample = logsArr.slice(0, LOG_DUMP_LINES).map((l,i)=>`[${i}] ${String(l).slice(0,220)}`);
        log(`no Burn hint in logs → skip fetch | tokenkegInvoke=${tokenInvokeCnt}`);
        log("logs sample:", `\n${sample.join("\n")}`);
        return;
      }

      await enqueueSignature(sig);
    }catch(e){
      log("WS msg err:", e.message);
    }
  };

  ws.onclose = () => { log("WS closed, reconnect in 3s"); setTimeout(connectWS, 3000); };
  ws.onerror = (e) => { log("WS error:", e?.message || String(e)); };
}

// keep-alive ping
setInterval(()=> { try{ ws?.ping?.(); }catch{} }, 30000);

connectWS();
