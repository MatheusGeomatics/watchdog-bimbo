// Busca no MyGeotab a última comunicação das placas de uma lista
// e devolve para a página. O resultado fica guardado por 1 hora
// no Netlify, para não consultar o MyGeotab a cada acesso.
import listasBase from "../../config/listas.mjs";
import listasFrota, { responsavel } from "../../config/listas_frota.mjs";

const listas = { ...listasBase, ...listasFrota };
// Canais considerados (grupos do MyGeotab com asterisco no nome)
const CANAIS = ["Canal Auto Serviço", "Canal Tradicional", "Expedição", "Logistica", "Manutenção"];
const semAcento = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const canalDe = (n) => CANAIS.find((c) => semAcento(c) === semAcento(n));
const MODELOS = ["Mobi","Logan","Voyage","Onix","Kwid","Iveco","Master","Accelo","Atego","6160","9170","17190","HR","IEV 1200T","Bongo"];

const API = "https://my.geotab.com/apiv1";

// ---- Regional (SP, SUL, RJ, NE, DF) a partir da árvore de grupos do MyGeotab ----
const REGIONAIS = { SP: "SP", RJ: "RJ", RS: "SUL", SUL: "SUL", NE: "NE", DF: "DF" };
const REG_POR_CV = {
  "cv raposo": "SP", "cv guarulhos": "SP", "cv anhanguera": "SP", "cv valinhos": "SP", "cv santo andre": "SP", "cv sorocaba": "SP", "cv mogi das cruzes": "SP",
  "cv inhauma": "RJ", "cv pavuna": "RJ", "cv campo grande": "RJ", "cv sao goncalo": "RJ", "cv sao pedro": "RJ", "cv jacarepagua": "RJ",
  "cv gravatai": "SUL", "cv sia": "DF",
  "cv jaboatao": "NE", "cv caruaru": "NE", "cv natal": "NE", "cv joao pessoa": "NE", "cv igarassu": "NE"
};
const tiraAcento = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function montaRegional(grupos) {
  const nome = {}, pai = {};
  for (const g of grupos) { nome[g.id] = (g.name || "").trim(); for (const c of g.children || []) pai[c.id] = g.id; }
  return (idsGrupos, cv) => {
    for (const id of idsGrupos) {
      let x = id, n = 0;
      while (x && n++ < 20) { const r = REGIONAIS[(nome[x] || "").toUpperCase()]; if (r) return r; x = pai[x]; }
    }
    return REG_POR_CV[tiraAcento(cv)] || "";
  };
}


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
  const regionalDe = montaRegional(grupos);
  const statusPorId = Object.fromEntries(status.map((s) => [s.device && s.device.id, s]));
  const alvo = new Set(placas.map(limpar));

  const rows = [];
  for (const v of veiculos) {
    const placa = limpar(v.licensePlate) || limpar(v.name);
    if (!alvo.has(placa)) continue;
    const s = statusPorId[v.id] || {};
    const nomesGrupo = (v.groups || []).map((g) => (nomeGrupo[g.id] || "").replace(/\u00a0/g, " ").trim());
    // Veículos do grupo Patrimonial ficam fora de todos os watchdogs
    if (nomesGrupo.some((n) => semAcento(n) === "patrimonial")) continue;
    const cv = nomesGrupo.find((n) => /^\|\s*CV/i.test(n));
    rows.push({
      p: placa,
      s: v.serialNumber || "",
      u: cv ? cv.replace(/\|/g, "").trim() : "Sem unidade",
      g: regionalDe((v.groups || []).map((x) => x.id), cv ? cv.replace(/\|/g, "").trim() : ""),
      t: s.dateTime || "1970-01-01T00:00:00Z",
      la: typeof s.latitude === "number" ? s.latitude : -1,
      lo: typeof s.longitude === "number" ? s.longitude : -1,
      sp: Math.round(s.speed || 0),
      dr: !!s.isDriving,
      m: nomesGrupo.find((n) => MODELOS.includes(n)) || "",
      k: nomesGrupo.filter((n) => /^\*.*\*$/.test(n)).map((n) => canalDe(n.replace(/\*/g, "").replace(/\s+/g, " ").trim())).filter(Boolean),
      r: responsavel[placa] || (nomesGrupo.includes("Vendedores") ? "Vendedor" : nomesGrupo.includes("Supervisão") ? "Supervisão" : nomesGrupo.includes("Patrimonial") ? "Patrimonial" : "")
    });
  }
  const patrimoniais = new Set(veiculos.filter((v) => (v.groups || []).some((g) => semAcento((nomeGrupo[g.id] || "").trim()) === "patrimonial")).map((v) => limpar(v.licensePlate) || limpar(v.name)));
  const achadas = new Set([...rows.map((r) => r.p), ...patrimoniais]);
  const faltando = placas.filter((p) => !achadas.has(limpar(p)));
  return { ref: agora, rows, faltando };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const lista = new URL(req.url).searchParams.get("lista");
  if (!listas[lista]) {
    return Response.json({ erro: "Lista inválida. Use ?lista=carretas, cavalos, leves ou pesados" }, { status: 400, headers: CORS });
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
