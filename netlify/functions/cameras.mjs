// Watchdog de câmeras: cruza a Surfsight (status, última conexão e alarmes
// da câmera) com o MyGeotab (última comunicação do rastreador do veículo).
// O resultado fica guardado por 1 hora no Netlify.
import mapa, { ignorar } from "../../config/cameras.mjs";

const SURF = process.env.SURFSIGHT_API || "https://api-prod.surfsight.net";
const GEOTAB = "https://my.geotab.com/apiv1";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const limpar = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------------- Surfsight ----------------
async function surf(path, token, opts = {}) {
  const r = await fetch(SURF + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(opts.headers || {})
    }
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
  if (!r.ok) {
    const msg = (j && (j.message || j.error || (j.data && j.data.message))) || txt.slice(0, 200);
    throw new Error(`Surfsight ${path.split("?")[0]} (${r.status}): ${msg}`);
  }
  return j;
}

function lista(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  if (j && j.data && Array.isArray(j.data.items)) return j.data.items;
  if (j && Array.isArray(j.items)) return j.items;
  return [];
}

async function paginar(montarPath, token, limite) {
  const tudo = [];
  for (let offset = 0, voltas = 0; voltas < 20; voltas++, offset += limite) {
    const pagina = lista(await surf(montarPath(limite, offset), token));
    tudo.push(...pagina);
    if (pagina.length < limite) break;
  }
  return tudo;
}

async function dadosSurfsight() {
  const auth = await surf("/v2/authenticate", null, {
    method: "POST",
    body: JSON.stringify({ email: process.env.SURFSIGHT_EMAIL, password: process.env.SURFSIGHT_PASSWORD })
  });
  const token = (auth.data && (auth.data.token || auth.data.accessToken)) || auth.token || auth.accessToken ||
    (typeof auth.data === "string" ? auth.data : null);
  if (!token) throw new Error("Surfsight: login feito, mas não veio o token na resposta.");

  // Organização da Bimbo: pelo ID cadastrado no Netlify, ou procurando pelo nome.
  let orgId = process.env.SURFSIGHT_ORG_ID;
  let orgNome = "";
  if (!orgId) {
    const orgs = lista(await surf("/v2/organizations", token));
    const busca = (process.env.SURFSIGHT_ORG_NOME || "bimbo").toLowerCase();
    const achadas = orgs.filter((o) => String(o.name || "").toLowerCase().includes(busca));
    if (achadas.length !== 1) {
      throw new Error(achadas.length
        ? `Mais de uma organização com "${busca}" no nome. Cadastre a variável SURFSIGHT_ORG_ID no Netlify.`
        : `Nenhuma organização com "${busca}" no nome na Surfsight. Cadastre a variável SURFSIGHT_ORG_ID no Netlify.`);
    }
    orgId = achadas[0].id;
    orgNome = achadas[0].name;
  }

  const [devices, saude] = await Promise.all([
    paginar((l, o) => `/v2/organizations/${orgId}/devices?limit=${l}&offset=${o}`, token, 1500),
    paginar((l, o) => `/v2/device-health?organizationId=${orgId}&limit=${l}&offset=${o}`, token, 1000)
      .catch((e) => ({ erro: e.message }))
  ]);
  return { orgId, orgNome, devices, saude };
}

// ---------------- MyGeotab ----------------
async function geotab(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(`MyGeotab ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

async function dadosGeotab() {
  const auth = await geotab(GEOTAB, "Authenticate", {
    database: process.env.GEOTAB_DATABASE,
    userName: process.env.GEOTAB_USER,
    password: process.env.GEOTAB_PASSWORD
  });
  const servidor = auth.path && auth.path !== "ThisServer" ? `https://${auth.path}/apiv1` : GEOTAB;
  const get = (typeName, extra = {}) =>
    geotab(servidor, "Get", { credentials: auth.credentials, typeName, ...extra });
  const agora = new Date().toISOString();
  const [veiculos, status, grupos] = await Promise.all([
    get("Device", { search: { fromDate: agora }, resultsLimit: 10000 }),
    get("DeviceStatusInfo", { resultsLimit: 10000 }),
    get("Group", { resultsLimit: 10000 })
  ]);
  return { veiculos, status, grupos };
}

// ---------------- Junta tudo ----------------
const maisRecente = (...ds) => ds.filter(Boolean).sort().pop() || null;

export async function montar(debug = false) {
  const [S, G] = await Promise.all([dadosSurfsight(), dadosGeotab()]);

  const nomeGrupo = Object.fromEntries(G.grupos.map((g) => [g.id, g.name || ""]));
  const cvDe = (v) => {
    const n = (v && v.groups || []).map((g) => nomeGrupo[g.id] || "").find((x) => /^\|\s*CV/i.test(x));
    return n ? n.replace(/\|/g, "").trim() : "";
  };
  const veicPorId = Object.fromEntries(G.veiculos.map((v) => [v.id, v]));
  const veicPorPlaca = {};
  for (const v of G.veiculos) {
    const p = limpar(v.licensePlate) || limpar(v.name);
    if (p && !veicPorPlaca[p]) veicPorPlaca[p] = v;
  }
  const statusPorId = Object.fromEntries(G.status.map((s) => [s.device && s.device.id, s]));
  const mapaPorImei = Object.fromEntries(mapa.map(([imei, id, p, cv]) => [String(imei), { id, p, cv }]));
  const ignorarSet = new Set((ignorar || []).map(String));
  const saudePorImei = Array.isArray(S.saude)
    ? Object.fromEntries(S.saude.map((h) => [String(h.imei), h])) : {};

  const rows = [];
  for (const d of S.devices) {
    const imei = String(d.imei || "");
    if (!imei || ignorarSet.has(imei)) continue;
    const h = saudePorImei[imei] || {};
    const ref = mapaPorImei[imei];
    const v = (ref && veicPorId[ref.id]) || veicPorPlaca[limpar(d.name)] || null;
    const st = v ? statusPorId[v.id] || {} : {};
    rows.push({
      imei,
      p: (v && (limpar(v.licensePlate) || limpar(v.name))) || (ref && ref.p) || String(d.name || imei),
      u: cvDe(v) || (ref && ref.cv) || "Sem unidade",
      cs: String(d.status || "").toLowerCase() || "desconhecido",
      semi: !!d.isSemiOnline,
      cv: maisRecente(d.lastSeenOnline, h.lastConnectedAt),
      rec: h.lastRecordingHealth === undefined ? null : h.lastRecordingHealth,
      al: (h.alarms || []).map((a) => a.details || a.code).filter(Boolean),
      vinc: !!v,
      gt: st.dateTime || null,
      dr: !!st.isDriving,
      sp: Math.round(st.speed || 0),
      la: typeof d.lat === "number" ? d.lat : (typeof st.latitude === "number" ? st.latitude : -1),
      lo: typeof d.lon === "number" ? d.lon : (typeof st.longitude === "number" ? st.longitude : -1)
    });
  }

  const out = { ref: new Date().toISOString(), rows, avisos: [] };
  if (!Array.isArray(S.saude)) out.avisos.push("Alarmes de saúde indisponíveis: " + S.saude.erro);
  if (debug) {
    const contar = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
    out.debug = {
      organizacao: S.orgNome || S.orgId,
      cameras_surfsight: S.devices.length,
      status_encontrados: contar(S.devices, "status"),
      campos_device: S.devices[0] ? Object.keys(S.devices[0]) : [],
      exemplo_device: S.devices[0] || null,
      campos_saude: Array.isArray(S.saude) && S.saude[0] ? Object.keys(S.saude[0]) : [],
      exemplo_saude: Array.isArray(S.saude) ? S.saude[0] || null : S.saude,
      sem_vinculo_mygeotab: rows.filter((r) => !r.vinc).length
    };
  }
  return out;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const faltando = ["SURFSIGHT_EMAIL", "SURFSIGHT_PASSWORD", "GEOTAB_DATABASE", "GEOTAB_USER", "GEOTAB_PASSWORD"]
    .filter((k) => !process.env[k]);
  if (faltando.length) {
    return Response.json({ erro: "Faltam variáveis no Netlify: " + faltando.join(", ") }, { status: 500, headers: CORS });
  }
  const debug = new URL(req.url).searchParams.has("debug");
  try {
    const dados = await montar(debug);
    return Response.json(dados, {
      headers: debug ? { ...CORS, "Cache-Control": "no-store" } : {
        ...CORS,
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600"
      }
    });
  } catch (e) {
    return Response.json({ erro: "Não foi possível montar o watchdog de câmeras: " + e.message }, { status: 502, headers: CORS });
  }
};

export const config = { path: "/api/cameras" };
