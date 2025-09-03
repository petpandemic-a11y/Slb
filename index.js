// Raydium LP burn watcher (Helius WS - nem enhanced, kreditkímélő)
// WS: logsSubscribe Raydium AMM v4 + CPMM -> signature + LOGS
//   -> csak akkor kérünk le tx-t, ha a LOG-okban tényleg "Instruction: Burn" van
// HTTP RPC: getTransaction(jsonParsed) -> inner Tokenkeg: Burn
// Jelzés: ha a Burn mint szerepel bármely Raydium-instrukció accounts közt (LP mint match)

import WebSocket from "ws";
import http from "http";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
// Helius:
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ==== logger ====
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ==== Health HTTP (Render health check) ====
http
  .createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  })
  .listen(PORT, () => log(`HTTP up on :${PORT}`));

// ==== JSON-RPC helpers (Helius HTTP RPC) ====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const r = await fetch(RPC_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getTransaction(signature, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ]);
    } catch (e) {
      log(`getTransaction fail (${i + 1}/${tries}):`, e.message);
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // backoff
      } else {
        return null;
      }
    }
  }
}

// ==== Telegram (queue + throttle) ====
const tgQueue = [];
let tgSending = false;
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQueue.push(text);
  if (tgSending) return;
  tgSending = true;
  while (tgQueue.length) {
    const msg = tgQueue.shift();
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: msg,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
      if (r.status === 429) {
        let wait = 3000;
        try {
          const jr = await r.json();
          if (jr?.parameters?.retry_after) wait = (jr.parameters.retry_after * 1000) | 0;
        } catch {}
        await new Promise((r) => setTimeout(r, wait));
        tgQueue.unshift(msg); // retry
      } else {
        await new Promise((r) => setTimeout(r, 1200)); // ~1 msg / 1.2s
      }
    } catch (e) {
      log("TG error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  tgSending = false;
}

// ==== getTransaction RATE LIMITER (max ~1/sec) ====
const sigQueue = [];
const seenSig = new Set(); // dedup: egy signature-t csak egyszer dolgozunk fel
let workerRunning = false;

async function enqueueSignature(sig) {
  if (seenSig.has(sig)) return;
  seenSig.add(sig);
  sigQueue.push(sig);
  if (!workerRunning) {
    workerRunning = true;
    while (sigQueue.length) {
      const s = sigQueue.shift();
      await processSignature(s);
      await new Promise((r) => setTimeout(r, 1000)); // 1 tx / sec
    }
    workerRunning = false;
  }
}

async function processSignature(sig) {
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x) => x?.instructions || []);
  const all = [...top, ...inner];

  // Raydium program accounts (LP mint is jellemzően itt szerepel)
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)) {
      const accs = (ix?.accounts || [])
        .map((a) => (typeof a === "string" ? a : (a?.pubkey || a?.toString?.())))
        .filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // SPL Token: Burn + mint in rayAccounts -> LP burn
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;

    const isBurn = ix?.parsed?.type === "burn" || ix?.instructionName === "Burn";
    if (!isBurn) continue;

    const mint = ix?.parsed?.info?.mint || ix?.mint;
    if (!mint) continue;
    if (!rayAccounts.has(mint)) continue; // nem Raydium LP mint

    const amount = ix?.parsed?.info?.amount || ix?.amount;
    const when = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
    const link = `https://solscan.io/tx/${sig}`;

    const msg = [
      "🔥 <b>Raydium LP BURN</b>",
      `Mint: <code>${mint}</code>`,
      amount ? `Amount: ${amount}` : null,
      when ? `Time: ${when}` : null,
      `Sig: <a href="${link}">${sig}</a>`
    ]
      .filter(Boolean)
      .join("\n");

    log(msg.replace(/<[^>]+>/g, ""));
    await sendTelegram(msg);
    break; // elég egy találat/tx
  }
}

// ==== Plain WebSocket kliens (Helius WSS - nem enhanced) ====
let ws;

function wsSend(obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeLogs(programId, id) {
  // logsSubscribe -> Raydium programokat “említő” tx-ek LOGS + signature
  const msg = {
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [{ mentions: [programId] }, { commitment: "confirmed" }]
  };
  wsSend(msg);
}

function connectWS() {
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM, 1002);
  };

  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length === 0) return;

      // ---- AGRESSZÍV ELŐSZŰRÉS ----
      // Csak akkor dolgozunk tovább, ha a logokban tényleg szerepel:
      // "Program log: Instruction: Burn"
      const hasBurnLog = logsArr.some(
        (l) => typeof l === "string" && /Instruction:\s*Burn/i.test(l)
      );
      if (!hasBurnLog) return;

      // Tedd a signature-t a rate-limites queue-ba
      await enqueueSignature(sig);
    } catch (e) {
      log("WS msg err:", e.message);
    }
  };

  ws.onclose = () => {
    log("WS closed, reconnecting in 3s…");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => {
    log("WS error:", e?.message || String(e));
  };
}

connectWS();
