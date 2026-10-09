// Busca no MyGeotab a última comunicação das placas de uma lista
// e devolve para a página. O resultado fica guardado por 1 hora
// no Netlify, para não consultar o MyGeotab a cada acesso.
import listas from "../../config/listas.mjs";

const API = "https://my.geotab.com/apiv1";

async function chamar(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

const limpar = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function montar(nomeLista) {
  const placas = listas[nomeLista];
  const auth = await chamar(API, "Authenticate", {
    database: process.env.GEOTAB_DATABASE,
    userName: process.env.GEOTAB_USER,
    password: process.env.GEOTAB_PASSWORD
  });
  const servidor = auth.path && auth.path !== "ThisServer" ? `https://${auth.path}/apiv1` : API;
  const credentials = auth.credentials;
  const get = (typeName, extra = {}) => chamar(servidor, "Get", { credentials, typeName, ...extra });

  const agora = new Date().toISOString();
  const [veiculos, status, grupos] = await Promise.all([
    get("Device", { search: { fromDate: agora }, resultsLimit: 10000 }), // só ativos
    get("DeviceStatusInfo", { resultsLimit: 10000 }),
    get("Group", { resultsLimit: 10000 })
  ]);

  const nomeGrupo = Object.fromEntries(grupos.map((g) => [g.id, g.name || ""]));
  const statusPorId = Object.fromEntries(status.map((s) => [s.device && s.device.id, s]));
  const alvo = new Set(placas.map(limpar));

  const rows = [];
  for (const v of veiculos) {
    const placa = limpar(v.licensePlate) || limpar(v.name);
    if (!alvo.has(placa)) continue;
    const s = statusPorId[v.id] || {};
    const cv = (v.groups || []).map((g) => nomeGrupo[g.id] || "").find((n) => /^\|\s*CV/i.test(n));
    rows.push({
      p: placa,
      s: v.serialNumber || "",
      u: cv ? cv.replace(/\|/g, "").trim() : "Sem unidade",
      t: s.dateTime || "1970-01-01T00:00:00Z",
      la: typeof s.latitude === "number" ? s.latitude : -1,
      lo: typeof s.longitude === "number" ? s.longitude : -1,
      sp: Math.round(s.speed || 0),
      dr: !!s.isDriving
    });
  }
  const achadas = new Set(rows.map((r) => r.p));
  const faltando = placas.filter((p) => !achadas.has(limpar(p)));
  return { ref: agora, rows, faltando };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const lista = new URL(req.url).searchParams.get("lista");
  if (!listas[lista]) {
    return Response.json({ erro: "Lista inválida. Use ?lista=carretas ou ?lista=cavalos" }, { status: 400, headers: CORS });
  }
  if (!process.env.GEOTAB_USER || !process.env.GEOTAB_PASSWORD || !process.env.GEOTAB_DATABASE) {
    return Response.json({ erro: "Faltam as credenciais do MyGeotab nas variáveis de ambiente do Netlify." }, { status: 500, headers: CORS });
  }
  try {
    const dados = await montar(lista);
    return Response.json(dados, {
      headers: {
        ...CORS,
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600"
      }
    });
  } catch (e) {
    return Response.json({ erro: "Não foi possível consultar o MyGeotab: " + e.message }, { status: 502, headers: CORS });
  }
};

export const config = { path: "/api/dados" };
