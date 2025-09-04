// Raydium LP burn watcher — CPI-kapcsolat SZIGORÚ
import WebSocket from "ws";
import http from "http";

const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RAY_PROGRAMS = new Set([RAY_AMM_V4, RAY_CPMM]);

const log = (...a) => console.log(new Date().toISOString(), ...a);

http.createServer((_,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

async function rpc(method, params){
  const r = await fetch(RPC_HTTP, {
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

const sigQ=[]; const seen=new Set(); let worker=false;
async function enqueue(sig){ if(seen.has(sig)) return; seen.add(sig); sigQ.push(sig); if(worker) return;
  worker=true; while(sigQ.length){ const s=sigQ.shift(); await processSig(s); await new Promise(r=>setTimeout(r,1000)); }
  worker=false;
}

const s = (x)=> typeof x==="string" ? x : (x?.pubkey || x?.toString?.() || null);
const isBurnType = (t)=> !!t && /^(burn|burnchecked)$/i.test(t);
const hasBurnLog  = (logs)=> logs?.some?.(l=>/Instruction:\s*Burn(?:Checked)?/i.test(l));
const hasRemoveLog= (logs)=> logs?.some?.(l=>/Remove\s*Liquidity/i.test(l));

async function processSig(sig){
  const tx = await getTransaction(sig);
  if(!tx){ log("[DBG] no tx"); return; }

  const top = tx?.transaction?.message?.instructions || [];
  const innerGroups = tx?.meta?.innerInstructions || []; // [{index: number, instructions:[]},...]

  // 1) mely outer indexek Raydium-programok?
  const rayParentIdx = new Set();
  top.forEach((ix, idx)=>{
    const pid = s(ix?.programId);
    if(pid && RAY_PROGRAMS.has(pid)) rayParentIdx.add(idx);
  });
  if(rayParentIdx.size===0){ log("[DBG] skip: no outer Raydium ix"); return; }

  // 2) nézzük meg az inner csoportokat, amelyek ezekhez az indexekhez tartoznak
  const candidateBurns = [];
  const rayAccounts = new Set(); // debugginghez gyűjtjük

  // gyűjtsük Raydium outer ixek accounts-át (debug/LP mint ellenőrzés)
  top.forEach((ix, idx)=>{
    if(!rayParentIdx.has(idx)) return;
    (ix?.accounts||[]).map(s).filter(Boolean).forEach(a=>rayAccounts.add(a));
  });

  for(const g of innerGroups){
    if(!rayParentIdx.has(g?.index)) continue;     // csak Raydium outer alatt
    for(const ix of (g?.instructions||[])){
      const pid = s(ix?.programId);
      const t = ix?.parsed?.type?.toLowerCase?.();
      if(pid===TOKENKEG && isBurnType(t)){
        const mint  = ix?.parsed?.info?.mint || null;
        const amt   = ix?.parsed?.info?.amount || null;
        candidateBurns.push({ mint, amt, parentIndex:g.index });
      }
    }
  }

  if(candidateBurns.length===0){
    log("[DBG] skip: no TokenProgram burn under Raydium CPI");
    return;
  }

  // 3) ha akarjuk, ellenőrizzük, hogy a burn mint tényleg szerepel a Raydium outer accounts között (extra szigor)
  let chosen = null;
  for(const b of candidateBurns){
    if(!b.mint) continue;
    if(rayAccounts.size===0 || rayAccounts.has(b.mint)){ chosen = b; break; }
  }
  if(!chosen){ log("[DBG] skip: burn found but LP mint not in Raydium accounts"); return; }

  const logsArr = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
  const hadRemove = hasRemoveLog(logsArr);

  const when = tx?.blockTime ? new Date(tx.blockTime*1000).toISOString() : "";
  const solscan = `https://solscan.io/tx/${sig}`;
  const title = hadRemove ? "Raydium LP BURN + RemoveLiquidity" : "Raydium LP BURN";
  const msg = [
    `<b>🔥 ${title}</b>`,
    `Mint: <code>${chosen.mint}</code>`,
    chosen.amt ? `Amount (raw): ${chosen.amt}` : null,
    when ? `Time: ${when}` : null,
    `<a href="${solscan}">Solscan</a>`
  ].filter(Boolean).join("\n");

  log(`[ALERT] ${title} | mint=${chosen.mint} | parentIdx=${chosen.parentIndex} | sig=${sig}`);
  await sendTelegram(msg);
}

let ws;
function wsSend(obj){ if(ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  wsSend({ jsonrpc:"2.0", id, method:"logsSubscribe",
           params:[ { mentions:[programId] }, { commitment:"confirmed" } ] });
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = ()=>{ log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); };
  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if(!sig || logsArr.length===0) return;
      if(!hasBurnLog(logsArr)) return;    // előszűrés: csak ha a logban is Burn van
      await enqueue(sig);                 // mély ellenőrzés a processSig-ben
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=> log("WS error:", e?.message || String(e));
}
connectWS();
