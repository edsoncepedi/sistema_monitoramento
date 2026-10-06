"use strict";

const JANELA_MS = 60_000;          // largura da janela do modo tempo real
const INTERVALO_PONTOS_MS = 1_000; // polling de pontos novos
const INTERVALO_STATS_MS = 5_000;  // polling dos cards/tabela
const INTERVALO_DISPOSITIVOS_MS = 15_000;

const estado = {
  modo: "tempo-real",
  device: null,
  dispositivos: [],
  ultimoId: 0,
  geracao: 0,        // invalida respostas antigas quando o modo/dispositivo muda
  timers: [],
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtHora = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" });

// --------------------------------------------------------------------------- utilitários

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== "") p.set(k, v);
  }
  return p.toString();
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).erro || msg; } catch (_) { /* resposta sem JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

function setStatus(texto, erro = false) {
  const el = $("status");
  el.textContent = texto;
  el.classList.toggle("erro", erro);
}

function num(v) {
  return v === null || v === undefined ? "–" : fmt.format(v);
}

// <input type="datetime-local"> trabalha em hora local, sem fuso.
function paraInputLocal(data) {
  const local = new Date(data.getTime() - data.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}
function deInputLocal(valor) {
  return valor ? new Date(valor).toISOString() : null;
}

function cssVar(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
}

// --------------------------------------------------------------------------- gráfico

const grafico = new Chart($("grafico"), {
  type: "line",
  data: {
    datasets: ["x", "y", "z"].map((eixo) => ({
      label: eixo.toUpperCase(),
      data: [],
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0,
    })),
  },
  options: {
    animation: false,
    parsing: false,
    normalized: true,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", axis: "x", intersect: false },
    scales: {
      x: {
        type: "time",
        time: {
          tooltipFormat: "dd/MM/yyyy HH:mm:ss.SSS",
          displayFormats: { millisecond: "HH:mm:ss.SSS", second: "HH:mm:ss", minute: "HH:mm", hour: "dd/MM HH:mm" },
        },
        ticks: { maxRotation: 0, autoSkipPadding: 16 },
      },
      y: { title: { display: true, text: "m/s²" } },
    },
    plugins: {
      legend: { position: "top", align: "end", labels: { boxWidth: 12, boxHeight: 12, usePointStyle: false } },
      tooltip: {
        callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt.format(ctx.parsed.y)} m/s²` },
      },
    },
  },
});

function aplicarCores() {
  const cores = [cssVar("--serie-x"), cssVar("--serie-y"), cssVar("--serie-z")];
  grafico.data.datasets.forEach((ds, i) => {
    ds.borderColor = cores[i];
    ds.backgroundColor = cores[i];
  });
  const texto2 = cssVar("--texto-2");
  const mudo = cssVar("--texto-mudo");
  const grade = cssVar("--grade");
  const eixo = cssVar("--eixo");
  for (const escala of Object.values(grafico.options.scales)) {
    escala.ticks.color = mudo;
    escala.grid = { color: grade };
    escala.border = { color: eixo };
    if (escala.title) escala.title.color = texto2;
  }
  grafico.options.plugins.legend.labels.color = texto2;
  grafico.update("none");
}
aplicarCores();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", aplicarCores);

function limparGrafico() {
  grafico.data.datasets.forEach((ds) => { ds.data = []; });
  grafico.update("none");
}

function adicionarPontos(pontos) {
  const [dx, dy, dz] = grafico.data.datasets;
  for (const p of pontos) {
    dx.data.push({ x: p.t, y: p.x });
    dy.data.push({ x: p.t, y: p.y });
    dz.data.push({ x: p.t, y: p.z });
  }
}

function cortarJanela() {
  const dados = grafico.data.datasets[0].data;
  if (!dados.length) return;
  const limite = dados[dados.length - 1].x - JANELA_MS;
  let corte = 0;
  while (corte < dados.length && dados[corte].x < limite) corte++;
  if (corte) grafico.data.datasets.forEach((ds) => ds.data.splice(0, corte));
}

// --------------------------------------------------------------------------- cards e tabela

function periodoAtual() {
  if (estado.modo === "historico") {
    return { inicio: deInputLocal($("inicio").value), fim: deInputLocal($("fim").value) };
  }
  const dados = grafico.data.datasets[0].data;
  const ultimo = dados.length ? dados[dados.length - 1].x : null;
  return { inicio: ultimo ? new Date(ultimo - JANELA_MS).toISOString() : null, fim: null };
}

async function atualizarEstatisticas(geracao) {
  if (!estado.device) return;
  const stats = await getJSON("/api/estatisticas?" + qs({ device_id: estado.device, ...periodoAtual() }));
  if (geracao !== estado.geracao) return;

  $("card-total").textContent = fmtInt.format(stats.total);
  const disp = estado.dispositivos.find((d) => d.device_id === estado.device);
  $("card-armazenado").textContent = disp ? fmtInt.format(disp.total) : "–";

  const u = stats.ultima;
  $("ultimo-x").textContent = u ? num(u.x) : "–";
  $("ultimo-y").textContent = u ? num(u.y) : "–";
  $("ultimo-z").textContent = u ? num(u.z) : "–";
  $("card-ultima-hora").textContent = u ? "· " + fmtHora.format(new Date(u.t)) : "";

  const corpo = $("tabela-stats");
  if (!stats.total) {
    corpo.innerHTML = '<tr><td colspan="5" class="vazio">Sem dados no período</td></tr>';
  } else {
    corpo.innerHTML = ["x", "y", "z"].map((e) => {
      const s = stats.eixos[e];
      return `<tr><td><i class="chip chip-${e}"></i>${e.toUpperCase()}</td>` +
        `<td>${num(s.min)}</td><td>${num(s.max)}</td><td>${num(s.media)}</td><td>${num(s.desvio)}</td></tr>`;
    }).join("");
  }
  atualizarLinksCsv();
}

function atualizarLinksCsv() {
  const params = { device_id: estado.device, ...periodoAtual() };
  $("csv").href = "/api/leituras.csv?" + qs(params);
  $("csv-excel").href = "/api/leituras.csv?" + qs({ ...params, excel: 1 });
}

// --------------------------------------------------------------------------- modos

function pararTimers() {
  estado.timers.forEach(clearTimeout);
  estado.timers = [];
}

// Agenda fn em loop sem sobrepor requisições; para quando a geração muda.
function repetir(fn, intervalo, geracao, atrasoInicial = 0) {
  const passo = async () => {
    if (geracao !== estado.geracao) return;
    try {
      await fn(geracao);
    } catch (e) {
      if (geracao === estado.geracao) setStatus("Erro: " + e.message, true);
    }
    if (geracao === estado.geracao) estado.timers.push(setTimeout(passo, intervalo));
  };
  estado.timers.push(setTimeout(passo, atrasoInicial));
}

async function buscarPontosRecentes(geracao) {
  const dados = await getJSON("/api/leituras/recentes?" + qs({
    device_id: estado.device,
    apos_id: estado.ultimoId || null,
    janela_s: JANELA_MS / 1000,
  }));
  if (geracao !== estado.geracao) return;

  const primeiraCarga = !estado.ultimoId;
  adicionarPontos(dados.pontos);
  estado.ultimoId = dados.ultimo_id;
  // Os cards usam a janela do gráfico; atualiza assim que ela existe.
  if (primeiraCarga && dados.pontos.length) atualizarEstatisticas(geracao).catch(() => {});
  cortarJanela();
  grafico.update("none");

  const qtd = grafico.data.datasets[0].data.length;
  $("nota-grafico").textContent = `últimos ${JANELA_MS / 1000} s · ${fmtInt.format(qtd)} pontos`;
  setStatus(`Tempo real · atualizado às ${new Date().toLocaleTimeString("pt-BR")}`);
}

function iniciarTempoReal() {
  const geracao = ++estado.geracao;
  pararTimers();
  estado.ultimoId = 0;
  limparGrafico();
  if (!estado.device) return;
  repetir(buscarPontosRecentes, INTERVALO_PONTOS_MS, geracao);
  repetir(atualizarEstatisticas, INTERVALO_STATS_MS, geracao, INTERVALO_STATS_MS);
}

async function carregarHistorico() {
  const geracao = ++estado.geracao;
  pararTimers();
  if (!estado.device) return;

  const periodo = periodoAtual();
  setStatus("Carregando histórico…");
  try {
    const dados = await getJSON("/api/leituras?" + qs({ device_id: estado.device, ...periodo }));
    if (geracao !== estado.geracao) return;
    limparGrafico();
    adicionarPontos(dados.pontos);
    grafico.update("none");

    $("nota-grafico").textContent = dados.agregado
      ? `${fmtInt.format(dados.total)} leituras · média a cada ${fmt.format(dados.balde_s)} s`
      : `${fmtInt.format(dados.total)} leituras`;
    await atualizarEstatisticas(geracao);
    setStatus("Histórico carregado");
  } catch (e) {
    setStatus("Erro: " + e.message, true);
  }
}

function trocarModo(modo) {
  estado.modo = modo;
  document.querySelectorAll(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.modo === modo));
  $("controles-historico").hidden = modo !== "historico";

  if (modo === "historico") {
    if (!$("inicio").value || !$("fim").value) {
      const agora = new Date();
      $("fim").value = paraInputLocal(agora);
      $("inicio").value = paraInputLocal(new Date(agora.getTime() - 3_600_000));
    }
    carregarHistorico();
  } else {
    iniciarTempoReal();
  }
}

function recarregar() {
  if (estado.modo === "historico") carregarHistorico();
  else iniciarTempoReal();
}

// --------------------------------------------------------------------------- dispositivos

async function atualizarDispositivos() {
  try {
    estado.dispositivos = await getJSON("/api/dispositivos");
  } catch (e) {
    setStatus("Erro ao listar dispositivos: " + e.message, true);
    return;
  }

  const select = $("dispositivo");
  const atuais = [...select.options].map((o) => o.value).join("|");
  const novos = estado.dispositivos.map((d) => d.device_id).join("|");
  if (atuais !== novos) {
    select.replaceChildren(...estado.dispositivos.map((d) => new Option(d.device_id, d.device_id)));
    if (estado.device && novos.split("|").includes(estado.device)) select.value = estado.device;
  }

  if (!estado.dispositivos.length) {
    setStatus("Nenhuma leitura recebida ainda. Aguardando o microcontrolador…");
    return;
  }
  if (!estado.device) {
    estado.device = select.value;
    recarregar();
  }
}

// --------------------------------------------------------------------------- eventos

$("dispositivo").addEventListener("change", (e) => {
  estado.device = e.target.value;
  recarregar();
});
document.querySelectorAll(".aba").forEach((b) => b.addEventListener("click", () => trocarModo(b.dataset.modo)));
$("aplicar").addEventListener("click", carregarHistorico);

atualizarDispositivos();
setInterval(atualizarDispositivos, INTERVALO_DISPOSITIVOS_MS);
