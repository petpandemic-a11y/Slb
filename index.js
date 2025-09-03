// Raydium LP burn watcher (Helius WS - nem enhanced)
// WS: logsSubscribe Raydium AMM v4 + CPMM -> signature
// HTTP RPC: getTransaction(jsonParsed) -> inner Tokenkeg: Burn
// LP-burn jelzés akkor, ha a Burn mint szerepel a Raydium-instrukciók accountjai között
// Opcionális Telegram értesítés (throttled)

import http from "http";

// ---- ENV ----
const PORT = Number(process.env.PORT || 8080);
// Helius endpointok (rakd mögé az api-key paramot):
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Program ID-k
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ---- mini logger ----
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Health HTTP (Render health check) ----
const server = http.createServer((_, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok\n");
});
server.listen(PORT, () => log(`HTTP up on :${PORT}`));

// ---- JSON-RPC helpers (Helius HTTP RPC) ----
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

async function getTransaction(signature) {
  return rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
  ]);
}

// ---- Telegram (egyszerű sor + throttle) ----
const q = [];
let sending = false;
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  q.push(text);
  if (sending) return;
  sending = true;
  while (q.length) {
    const msg = q.shift();
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
        await new Promise(r => setTimeout(r, wait));
        q.unshift(msg); // retry
      } else {
        await new Promise(r => setTimeout(r, 1200)); // ~1 üzi / 1.2s
      }
    } catch (e) {
      log("TG error:", e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  sending = false;
}

// ---- Sima WebSocket kliens (Helius WSS - nem enhanced) ----
let ws;

function wsSend(obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeLogs(programId, id) {
  // logsSubscribe -> a megadott programot “említő” tx-ek signature-jeit adja
  const msg = {
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [
      { mentions: [programId] },
      { commitment: "confirmed" }
    ]
  };
  wsSend(msg);
}

function connectWS() {
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    // Két külön Raydium programra iratkozunk fel
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM,   1002);
  };

  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());

      // Az első válaszok a subscription ID-k; a tényleges eseményekben params.result.value.signature van
      const sig = data?.params?.result?.value?.signature;
      if (!sig) return;

      // Részletes tranzakció beolvasása (jsonParsed, inner instrukciókkal)
      const tx = await getTransaction(sig);
      if (!tx) return;

      const top = tx?.transaction?.message?.instructions || [];
      const inner = (tx?.meta?.innerInstructions || []).flatMap(x => x?.instructions || []);
      const all = [...top, ...inner];

      // Gyűjtsük ki a Raydium-instrukciók accountjait (LP mint is ezek közt van)
      const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
      const rayAccounts = new Set();
      for (const ix of all) {
        const pid = typeof ix?.programId === "string" ? ix.programId : null;
        if (pid && rayPrograms.has(pid)) {
          const accs = (ix?.accounts || []).map(a =>
            typeof a === "string" ? a : (a?.pubkey || a?.toString?.())
          ).filter(Boolean);
          for (const a of accs) rayAccounts.add(a);
        }
      }

      // Keressük az SPL Token: Burn-t; a mint legyen benne rayAccounts-ban -> LP burn
      for (const ix of all) {
        const pid = typeof ix?.programId === "string" ? ix.programId : null;
        if (pid !== TOKENKEG) continue;

        const isBurn = (ix?.parsed?.type === "burn") || (ix?.instructionName === "Burn");
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
        ].filter(Boolean).join("\n");

        log(msg.replace(/<[^>]+>/g, "")); // plain log
        await sendTelegram(msg);
        break; // egy tx-ben elég egyszer jelezni
      }
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
