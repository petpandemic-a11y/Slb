// Raydium LP burn watcher (Helius WS - nem enhanced, stabil trigger)
// Trigger: ha a logokban "Instruction: Burn" VAGY "Program Tokenkeg... invoke" látszik
// Megmarad: 1 tx/s rate limit, retry/backoff, MIN_SOL_BURN küszöb (SOL-becslés), Dexs kártya, TG throttle

import WebSocket from "ws";
import http from "http";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
// Helius (nem enhanced):
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Dexscreener engedély + SOL küszöb
const DEXS_ENABLED = process.env.DEXS_ENABLED !== "0";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0); // pl. 0.5

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

// Gyakoribb quote mintek
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,                                       // WSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

// ==== logger ====
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ==== Health HTTP (Render ping) ====
http.createServer((_, res) => { res.writeHead(200, {"content-type":"text/plain"}); res.end("ok\n"); })
  .listen(PORT, () => log(`HTTP up :${PORT}`));

// ==== JSON-RPC helpers ====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const r = await fetch(RPC_HTTP, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo", [ pubkey, { commitment:"confirmed" } ]); }
async function getTokenLargestAccounts(mint){ return rpc("getTokenLargestAccounts", [ mint, { commitment:"confirmed" } ]); }
async function getTransaction(signature, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await rpc("getTransaction", [ signature, { encoding:"jsonParsed", maxSupportedTransactionVersion:0 } ]);
    } catch (e) {
      log(`getTransaction fail (${i+1}/${tries}) ${signature}:`, e.message);
      if (i < tries - 1) await new Promise(r=>setTimeout(r, 1500*(i+1)));
    }
  }
  return null;
}

// ==== Dexscreener ====
async function fetchDexsByToken(mint){
  if (!DEXS_ENABLED) return null;
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers:{ accept:"application/json" }});
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0]; if (!p) return null;
    return {
      tokenSymbol: p.baseToken?.symbol || (p.baseToken?.address||"").slice(0,4)+"…",
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv: p.fdv ? Number(p.fdv) : null,
      mcap: p.marketCap ? Number(p.marketCap) : null,
      dex: p.dexId || "",
      pairUrl: p.url || ""
    };
  } catch { return null; }
}

// ==== Telegram (queue + throttle) ====
const tgQ = []; let tgSending = false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { log("TG disabled"); return; }
  tgQ.push(text); if (tgSending) return; tgSending = true;
  while (tgQ.length){
    const msg = tgQ.shift();
    try{
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      if (r.status === 429){
        let wait = 3000;
        try{ const jr = await r.json(); if (jr?.parameters?.retry_after) wait = jr.parameters.retry_after*1000; }catch{}
        await new Promise(res=>setTimeout(res, wait)); tgQ.unshift(msg);
      } else {
        await new Promise(res=>setTimeout(res, 1200));
      }
    } catch (e) { log("TG send err:", e.message); await new Promise(res=>setTimeout(res, 2000)); }
  }
  tgSending = false;
}

// ==== Rate limiter getTransaction (1/sec) ====
const sigQueue = []; const seenSig = new Set(); let workerRunning = false;
async function enqueueSignature(sig){
  if (seenSig.has(sig)) return; seenSig.add(sig); sigQueue.push(sig);
  if (!workerRunning){
    workerRunning = true;
    while (sigQueue.length){
      const s = sigQueue.shift();
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

// ==== fő feldolgozás ====
async function processSignature(sig){
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x => x?.instructions || []);
  const all = [...top, ...inner];

  // Raydium accounts (LP + vaultok)
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts || []).map(a => typeof a==="string" ? a : (a?.pubkey || a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // SPL Token: Burn + mint ∈ rayAccounts => LP burn
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;
    const isBurn = ix?.parsed?.type === "burn" || ix?.instructionName === "Burn";
    if (!isBurn) continue;
    const mint = ix?.parsed?.info?.mint || ix?.mint;
    if (mint && rayAccounts.has(mint)){
      lpMint = mint;
      burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
      break;
    }
  }
  if (!lpMint) return;

  const blockTimeMs = tx?.blockTime ? tx.blockTime*1000 : Date.now();

  // LP mint info
  let supplyPostRaw=0, mintAuthNone=null, freezeNone=null, lpDecimals=0;
  try{
    const info = await getParsedCached(lpMint);
    const d = info?.value?.data?.parsed?.info;
    if (d?.supply) supplyPostRaw = Number(d.supply);
    if (d?.decimals != null) lpDecimals = Number(d.decimals) || 0;
    mintAuthNone = (d?.mintAuthority===null || d?.mintAuthority===undefined);
    freezeNone   = (d?.freezeAuthority===null || d?.freezeAuthority===undefined);
  }catch{}

  const supplyPreRaw = supplyPostRaw + burnAmountRaw;
  const share = supplyPreRaw > 0 ? (burnAmountRaw / supplyPreRaw) : 0;

  // WSOL vault SOL becslés
  let wsolVaultAmountRaw = 0, wsolDecimals = 9;
  const MAX_CHECK = 25; let checked = 0;
  for (const a of rayAccounts){
    if (checked>=MAX_CHECK) break; checked++;
    const acc = await tokenAccountInfo(a);
    if (!acc) continue;
    if (acc?.mint === WSOL_MINT){
      const ta = acc?.tokenAmount;
      if (ta?.amount) wsolVaultAmountRaw = Number(ta.amount);
      if (ta?.decimals != null) wsolDecimals = Number(ta.decimals) || 9;
      break;
    }
  }
  const wsolVaultSOL = wsolVaultAmountRaw / Math.pow(10, wsolDecimals);
  const estSolOut = share * wsolVaultSOL;
  if (MIN_SOL_BURN > 0 && estSolOut < MIN_SOL_BURN) return; // alatta nem küldünk

  // Underlying token mintek a Raydium acc-okból
  const candidateMints = [];
  let uChecked = 0;
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
    const [m1, m2] = underlying.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) { quoteMint=m1; baseMint=m2; }
    else if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) { quoteMint=m2; baseMint=m1; }
    else { baseMint=m1; quoteMint=m2; }
  }

  // Dexscreener
  let dexs=null;
  if (DEXS_ENABLED && baseMint) dexs = await fetchDexsByToken(baseMint);

  // Top LP holders
  let holdersLines=[];
  try{
    const largest = await getTokenLargestAccounts(lpMint);
    const arr = Array.isArray(largest?.value) ? largest.value.slice(0,3) : [];
    holdersLines = arr.map(x=>{
      const addr = x?.address || "";
      const amt  = Number(x?.amount || 0);
      const pct  = supplyPostRaw>0 ? ((amt/supplyPostRaw)*100) : 0;
      const short = addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : "–";
      return `├ ${short} | ${amt.toLocaleString()} | ${pct.toFixed(2)}%`;
    });
  }catch{}

  // Üzenet (kártya)
  const header     = "🔥 <b>Raydium LP Burn</b>";
  const burnPct    = supplyPreRaw>0 ? ((burnAmountRaw/supplyPreRaw)*100) : 0;
  const whenLine   = `🕒 <b>Time:</b> ${new Date(blockTimeMs).toISOString()} (${ago(blockTimeMs)})`;
  const burnLine   = `🔥 <b>Burn %:</b> ${burnPct.toFixed(2)}%`;
  const amountLP   = burnAmountRaw / Math.pow(10, lpDecimals||0);
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
    `└ FDV/MC: ${dexs.fdv!=null ? `$${dexs.fdv.toLocaleString()}` : (dexs.mcap!=null ? `$${dexs.mcap.toLocaleString()}` : "n/a")} (${dexs.dex||""})`,
    dexs.pairUrl ? `${dexs.pairUrl}` : ""
  ] : [];
  const sigLine = `🔗 <a href="https://solscan.io/tx/${sig}">Solscan</a>`;

  const msg = [
    header, burnLine, whenLine, amountLine, solLine, lpLine, pairLine, "",
    ...secLines, "", holdersTitle, holdersBlock, ...priceBlock, "", sigLine
  ].join("\n");

  log(`LP burn → ${lpMint} | estSOL ${estSolOut.toFixed(4)} | ${sig}`);
  await sendTelegram(msg);
}

// ==== WebSocket (Helius WSS - nem enhanced) ====
// Trigger: Burn-log VAGY Tokenkeg invoke
let ws;
function wsSend(o){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(o)); }
function subscribeLogs(programId, id){
  const msg = { jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] };
  wsSend(msg);
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM,   1002);
  };

  ws.onmessage = async (ev) => {
    try{
      const data = JSON.parse(ev.data.toString());
      if (data?.result && data?.id) return; // sub ack

      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length===0) return;

      const hasBurn = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn/i.test(l));
      const hasTokenInvoke = logsArr.some(l => typeof l==="string" && l.includes(`Program ${TOKENKEG} invoke`));

      if (!hasBurn && !hasTokenInvoke) return; // nincs érdemi hint → spórolunk

      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };

  ws.onclose = () => { log("WS closed, reconnecting in 3s…"); setTimeout(connectWS, 3000); };
  ws.onerror = (e) => { log("WS error:", e?.message || String(e)); };
}

// keep-alive ping
setInterval(()=>{ try{ ws?.ping?.(); }catch{} }, 30000);

connectWS();
