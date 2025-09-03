// Raydium LP burn watcher -> TG kártya (Dexs + on-chain), pontosabb base/quote feloldással
// WS (nem enhanced): csak akkor fetch, ha "Instruction: Burn" a logokban
// 1 tx/s rate limit, TG throttle; MIN_SOL_BURN küszöb (WSOL-vault alapján)

import WebSocket from "ws";
import http from "http";

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";
const DEXS_ENABLED = process.env.DEXS_ENABLED !== "0";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);

// ===== Program IDs =====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

// gyakori quote-ok
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

// ===== Logger + health =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
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
async function getTokenLargestAccounts(mint){ return rpc("getTokenLargestAccounts",[mint,{commitment:"confirmed"}]); }

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
async function fetchDexsByToken(mint){
  if (!DEXS_ENABLED) return null;
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers:{accept:"application/json"} });
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
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ? Number(p.liquidity.usd) : null,
      mcap: p.marketCap ? Number(p.marketCap) : null,
      fdv: p.fdv ? Number(p.fdv) : null,
      pairUrl: p.url || "",
      pairCreatedAt: p.pairCreatedAt || null,
      dex: p.dexId || "",
      socials: {
        website: p.info?.website || null,
        twitter: p.info?.twitter || null,
        telegram: p.info?.telegram || null
      }
    };
  }catch{ return null; }
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
      await new Promise(r=>setTimeout(r,1000));
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

// ===== Main =====
async function processSignature(sig){
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];

  // Raydium accounts
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // SPL Token Burn + mint ∈ Raydium-accounts
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid!==TOKENKEG) continue;
    const isBurn = ix?.parsed?.type==="burn" || ix?.instructionName==="Burn";
    if (!isBurn) continue;
    const mint = ix?.parsed?.info?.mint || ix?.mint;
    if (mint && rayAccounts.has(mint)){
      lpMint = mint;
      burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
      break;
    }
  }
  if (!lpMint) return;

  // LP supply (post) + decimals → burn % és SOL küszöb
  let lpSupplyPost=0, lpDecimals=0;
  try{
    const mi = await getParsedCached(lpMint);
    const d = mi?.value?.data?.parsed?.info;
    if (d?.supply) lpSupplyPost = Number(d.supply);
    if (d?.decimals!=null) lpDecimals = Number(d.decimals)||0;
  }catch{}
  const lpSupplyPre = lpSupplyPost + burnAmountRaw;
  const burnShare = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre) : 0;

  // WSOL vault (ha van) → SOL küszöb
  let wsolVaultRaw=0, wsolDecimals=9; let checked=0;
  for (const a of rayAccounts){
    if (checked++>30) break;
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

  // ===== Underlying minta feloldás (pontosabb): token-számlák mintjeinek gyakorisága =====
  const mintFreq = new Map(); checked=0;
  for (const a of rayAccounts){
    if (checked++>60) break;
    const acc = await tokenAccountInfo(a);
    const m = acc?.mint;
    if (!m) continue;
    mintFreq.set(m, (mintFreq.get(m)||0) + 1);
  }
  // a LP mintet dobjuk
  mintFreq.delete(lpMint);

  // leggyakoribb 2 mint
  const sorted = [...mintFreq.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  let baseMint=null, quoteMint=null;
  if (sorted.length>=2){
    const m1=sorted[0], m2=sorted[1];
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) { quoteMint=m1; baseMint=m2; }
    else if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) { quoteMint=m2; baseMint=m1; }
    else { baseMint=m1; quoteMint=m2; }
  }

  // ===== Base token adatok (mindig megpróbáljuk, Dexs nélkül is) =====
  let totalSupply=0, baseDecimals=0, mintAuthNone=null, freezeNone=null;
  if (baseMint){
    try{
      const mi = await getParsedCached(baseMint);
      const info = mi?.value?.data?.parsed?.info;
      totalSupply = info?.supply ? Number(info.supply) : 0;
      baseDecimals = info?.decimals!=null ? Number(info.decimals) : 0;
      mintAuthNone = (info?.mintAuthority===null || info?.mintAuthority===undefined);
      freezeNone   = (info?.freezeAuthority===null || info?.freezeAuthority===undefined);
    }catch{}
  }
  const totalSupplyUi = baseDecimals ? (totalSupply/10**baseDecimals) : (totalSupply||0);

  // Top holders (base mint)
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
    }catch(e){ log("largest holders err:", e.message); }
  }

  // Dexscreener (opcionális)
  let dexs=null; if (DEXS_ENABLED && baseMint) dexs = await fetchDexsByToken(baseMint);

  // ===== Üzenet (card) =====
  const burnPct = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre*100) : 0;
  const tradingStart = dexs?.pairCreatedAt ? ago(dexs.pairCreatedAt) : "n/a";
  const priceStr = dexs?.priceUsd!=null ? `$${Number(dexs.priceUsd)}` : "n/a";
  const liqStr   = dexs?.liquidityUsd!=null ? `$${dexs.liquidityUsd.toLocaleString()}` : "n/a";
  const mcapStr  = (dexs?.mcap!=null ? `$${dexs.mcap.toLocaleString()}` :
                   dexs?.fdv!=null ? `$${dexs.fdv.toLocaleString()}` : "n/a");

  const socials = [];
  if (dexs?.socials?.website) socials.push(`Website: ${dexs.socials.website}`);
  if (dexs?.socials?.twitter) socials.push(`Twitter: ${dexs.socials.twitter}`);
  if (dexs?.socials?.telegram) socials.push(`Telegram: ${dexs.socials.telegram}`);
  if (!socials.length) socials.push("n/a");

  const security = [
    `Mutable Metadata: n/a`, // (Metaplex olvasás később hozzáadható)
    `Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`
  ];

  const solscan = `https://solscan.io/tx/${sig}`;

  const header = `Solana LP Burns\n<b>Raydium LP Burn</b>`;
  const lines = [
    header,
    "",
    `🔥 <b>Burn Percentage:</b> ${burnPct.toFixed(2)}%`,
    `🕒 <b>Trading Start Time:</b> ${tradingStart}`,
    "",
    `📊 <b>Marketcap:</b> ${mcapStr}`,
    `💧 <b>Liquidity:</b> ${liqStr}`,
    `💲 <b>Price:</b> ${priceStr}`,
    "",
    `📦 <b>Total Supply:</b> ${ totalSupplyUi ? totalSupplyUi.toLocaleString() : "n/a" }`,
    baseMint ? `🔗 <b>Base Mint:</b> <code>${baseMint}</code>` : `🔗 <b>Base Mint:</b> n/a`,
    `🧾 <b>LP Mint:</b> <code>${lpMint}</code>`,
    "",
    `🌐 <b>Socials</b>:`,
    `├ ${socials[0]}`,
    ...(socials.slice(1).map(s=>`├ ${s}`)),
    "",
    `⚙️ <b>Security:</b>`,
    `├ ${security[0]}`,
    `├ ${security[1]}`,
    `└ ${security[2]}`,
    "",
    `👥 <b>Top Holders:</b>`,
    ...(holdersLines.length ? holdersLines : ["├ n/a"]),
    "",
    (dexs?.pairUrl ? `${dexs.pairUrl}\n` : ""),
    `🔗 <a href="${solscan}">Solscan</a>`
  ];
  const msg = lines.join("\n");

  log(`TG card → burn=${burnPct.toFixed(2)}% base=${baseMint||"n/a"} | sig=${sig}`);
  await sendTelegram(msg);
}

// ===== WebSocket (Helius WSS – agresszív előszűrés) =====
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
