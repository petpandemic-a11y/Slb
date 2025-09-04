// Raydium LP burn watcher — STRICT (csak Raydium LP mint burn mehet át)

import WebSocket from "ws";
import http from "http";

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);

// Helius (nem enhanced):
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Programs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const RAY_PROGRAMS = new Set([RAY_AMM_V4, RAY_CPMM]);

// ===== utils / log =====
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ===== tiny HTTP health =====
http.createServer((_,res)=>{
  res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");
}).listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ===== JSON-RPC helper =====
async function rpc(method, params){
  const r = await fetch(RPC_HTTP,{
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
  });
  if(!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if(j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getTransaction(signature, tries=3){
  for(let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction", [
        signature,
        { encoding:"jsonParsed", maxSupportedTransactionVersion:0 }
      ]);
    }catch(e){
      log(`getTransaction fail (${i+1}/${tries}):`, e.message);
      if(i<tries-1) await new Promise(r=>setTimeout(r, 1500*(i+1)));
    }
  }
  return null;
}

// ===== Telegram (rate-limited queue) =====
const tgQ=[]; let tgBusy=false;
async function sendTelegram(text){
  if(!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQ.push(text); if(tgBusy) return; tgBusy=true;
  while(tgQ.length){
    const msg=tgQ.shift();
    try{
      const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
        method:"POST",
        headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:true })
      });
      if(r.status===429){
        let wait=3000; try{ const jr=await r.json(); if(jr?.parameters?.retry_after) wait=jr.parameters.retry_after*1000;}catch{}
        await new Promise(r=>setTimeout(r, wait)); tgQ.unshift(msg);
      }else{
        await new Promise(r=>setTimeout(r, 1200));
      }
    }catch(e){ log("TG error:", e.message); await new Promise(r=>setTimeout(r,2000)); }
  }
  tgBusy=false;
}

// ===== Signature worker (1 tx/sec) =====
const sigQ=[]; const seen=new Set(); let worker=false;
async function enqueue(sig){ if(seen.has(sig)) return; seen.add(sig); sigQ.push(sig); if(worker) return;
  worker=true; while(sigQ.length){ const s=sigQ.shift(); await processSig(s); await new Promise(r=>setTimeout(r,1000)); }
  worker=false;
}

// ===== core: only Raydium-LP Burn =====
function pickStr(x){ return typeof x==="string" ? x : (x?.pubkey || x?.toString?.() || null); }

function looksLikeRemoveLog(l){
  // nagyon változékony; a legtöbb Raydium log ezt a mintát használja:
  // "Instruction: RemoveLiquidity" / "Remove Liquidity" / "RemoveLiquidityWithBaseOut" stb.
  return /Remove\s*Liquidity/i.test(l);
}
function looksLikeBurnLog(l){ return /Instruction:\s*Burn(?:Checked)?/i.test(l); }

async function processSig(sig){
  const tx = await getTransaction(sig);
  if(!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(ii=>ii?.instructions||[]);
  const all = [...top, ...inner];

  // 1) Gyűjtsünk minden Raydium-instrukció accountját → itt szokott szerepelni az LP mint
  const rayAccounts = new Set();
  for(const ix of all){
    const pid = pickStr(ix?.programId);
    if(pid && RAY_PROGRAMS.has(pid)){
      const accs = (ix?.accounts||[]).map(pickStr).filter(Boolean);
      for(const a of accs) rayAccounts.add(a);
    }
  }
  // ha nincs semmi Raydium account, akkor biztos nem LP burn
  if(rayAccounts.size===0){
    log("[DBG] skip: no Raydium accounts in tx");
    return;
  }
  log("[DBG] ray account count:", rayAccounts.size);

  // 2) Keressük meg a Token Program Burn / BurnChecked ixeit
  const burns = [];
  for(const ix of all){
    const pid = pickStr(ix?.programId);
    if(pid!==TOKENKEG) continue;
    const t = ix?.parsed?.type?.toLowerCase?.();
    if(t==="burn" || t==="burnchecked") burns.push(ix);
  }
  if(burns.length===0){
    log("[DBG] skip: no TokenProgram burn in tx");
    return;
  }

  // 3) Legalább az egyik burn mintje legyen a Raydium accounts között → Raydium LP mint
  let matched = null;
  let amount = null;
  for(const b of burns){
    const mint = b?.parsed?.info?.mint;
    if(!mint) continue;
    if(rayAccounts.has(mint)){
      matched = mint;
      amount = b?.parsed?.info?.amount || null;
      break;
    }
  }
  if(!matched){
    log("[DBG] skip: burn mint not among Raydium accounts");
    return;
  }

  // 4) (opcionális) Volt-e RemoveLiquidity Raydium log? (csak display cél)
  const rayLogs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
  const hadRemove = rayLogs.some(looksLikeRemoveLog);

  // 5) Jelentés
  const when = tx?.blockTime ? new Date(tx.blockTime*1000).toISOString() : "";
  const solscan = `https://solscan.io/tx/${sig}`;
  const title = hadRemove ? "Raydium LP BURN + RemoveLiquidity" : "Raydium LP BURN";

  const msg = [
    `<b>🔥 ${title}</b>`,
    `Mint: <code>${matched}</code>`,
    amount ? `Amount (raw): ${amount}` : null,
    when ? `Time: ${when}` : null,
    `<a href="${solscan}">Solscan</a>`
  ].filter(Boolean).join("\n");

  log(`[ALERT] ${title} | mint=${matched} | sig=${sig}`);
  await sendTelegram(msg);
}

// ===== WS (logsSubscribe Raydium + előszűrés a logokban) =====
let ws;
function wsSend(obj){ if(ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }

function subscribeLogs(programId, id){
  wsSend({
    jsonrpc:"2.0", id,
    method:"logsSubscribe",
    params:[ { mentions:[programId] }, { commitment:"confirmed" } ]
  });
}

function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = ()=>{
    log("WS open");
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM,   1002);
  };

  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if(!sig || logsArr.length===0) return;

      // csak akkor kérünk le, ha tényleg Burn(Checked) van a logokban
      const hasBurnLog = logsArr.some(looksLikeBurnLog);
      if(!hasBurnLog) return;

      // mehet a queue-ba (a szigorú Raydium-LP check a processSig-ben van)
      await enqueue(sig);
    }catch(e){
      log("WS msg err:", e.message);
    }
  };

  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=> log("WS error:", e?.message || String(e));
}
connectWS();
