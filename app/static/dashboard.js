"use strict";

const JANELA_MS = 60_000;          // largura da janela do modo tempo real
const INTERVALO_PONTOS_MS = 1_000; // polling de pontos novos
const INTERVALO_STATS_MS = 5_000;  // polling dos cards/tabela
const INTERVALO_DISPOSITIVOS_MS = 15_000;
const ZOOM_MIN_MS = 500;           // menor trecho que o zoom do histórico aceita
const ARRASTO_MIN_PX = 6;          // abaixo disso o arrasto é tratado como clique

const estado = {
  modo: "tempo-real",
  device: null,
  dispositivos: [],
  ultimoId: 0,
  periodo: null,     // {inicio, fim} em ms do histórico; os inputs só guardam segundos
  zoom: [],          // períodos anteriores, para "Voltar"
  geracao: 0,        // invalida respostas antigas quando o modo/dispositivo muda
  timers: [],
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtCurto = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
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

function fmtDuracao(ms) {
  const s = ms / 1000;
  if (s < 60) return `${fmtCurto.format(s)} s`;
  if (s < 3600) return `${fmtCurto.format(s / 60)} min`;
  if (s < 172_800) return `${fmtCurto.format(s / 3600)} h`;
  return `${fmtCurto.format(s / 86_400)} dias`;
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
    const p = estado.periodo;
    return { inicio: new Date(p.inicio).toISOString(), fim: new Date(p.fim).toISOString() };
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
  const x = grafico.options.scales.x;
  x.min = x.max = undefined;
  limparGrafico();
  if (!estado.device) return;
  repetir(buscarPontosRecentes, INTERVALO_PONTOS_MS, geracao);
  repetir(atualizarEstatisticas, INTERVALO_STATS_MS, geracao, INTERVALO_STATS_MS);
}

async function carregarHistorico() {
  const geracao = ++estado.geracao;
  pararTimers();
  atualizarFerramentas();
  if (!estado.device) return;

  // Fixa o eixo no período pedido: o zoom aparece na hora, com os dados que já
  // estão na tela, e é refinado quando chega a resposta com mais resolução.
  const p = estado.periodo;
  const x = grafico.options.scales.x;
  x.min = p.inicio;
  x.max = p.fim;
  grafico.update("none");

  setStatus("Carregando histórico…");
  try {
    const dados = await getJSON("/api/leituras?" + qs({ device_id: estado.device, ...periodoAtual() }));
    if (geracao !== estado.geracao) return;
    limparGrafico();
    adicionarPontos(dados.pontos);
    grafico.update("none");

    const leituras = `${fmtDuracao(p.fim - p.inicio)} · ${fmtInt.format(dados.total)} leituras`;
    $("nota-grafico").textContent = dados.agregado
      ? `${leituras} · média a cada ${fmt.format(dados.balde_s)} s`
      : leituras;
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
  $("ferramentas").hidden = modo !== "historico";
  $("dica-grafico").textContent = modo === "historico"
    ? "Arraste sobre o gráfico para ampliar um trecho · duplo clique para voltar · clique na legenda para ocultar um eixo"
    : "Arraste sobre o gráfico para congelar um trecho e analisá-lo no histórico · clique na legenda para ocultar um eixo";

  if (modo === "historico") {
    if (!estado.periodo) {
      const agora = Date.now();
      definirPeriodo({ inicio: agora - 3_600_000, fim: agora });
    }
    carregarHistorico();
  } else {
    iniciarTempoReal();
  }
}

// --------------------------------------------------------------------------- navegação do histórico

function definirPeriodo(p) {
  estado.periodo = { inicio: Math.round(p.inicio), fim: Math.round(p.fim) };
  $("inicio").value = paraInputLocal(new Date(estado.periodo.inicio));
  $("fim").value = paraInputLocal(new Date(estado.periodo.fim));
}

function lerPeriodoInputs() {
  const inicio = Date.parse($("inicio").value);
  const fim = Date.parse($("fim").value);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) throw new Error("Preencha início e fim");
  if (inicio >= fim) throw new Error("O início deve ser anterior ao fim");
  return { inicio, fim };
}

// Período novo (inputs ou atalho): descarta o histórico de zoom.
function novoPeriodo(p) {
  estado.zoom = [];
  definirPeriodo(p);
  carregarHistorico();
}

// Zoom/deslocamento: guarda o período atual para "Voltar".
function irPara(p) {
  estado.zoom.push(estado.periodo);
  definirPeriodo(p);
  carregarHistorico();
}

function voltar() {
  if (!estado.zoom.length) return;
  definirPeriodo(estado.zoom.pop());
  carregarHistorico();
}

function redefinir() {
  if (!estado.zoom.length) return;
  definirPeriodo(estado.zoom[0]);
  estado.zoom = [];
  carregarHistorico();
}

function deslocar(fracao) {
  const { inicio, fim } = estado.periodo;
  const passo = (fim - inicio) * fracao;
  irPara({ inicio: inicio + passo, fim: fim + passo });
}

function afastar() {
  const { inicio, fim } = estado.periodo;
  const meio = (fim - inicio) / 2;
  irPara({ inicio: inicio - meio, fim: fim + meio });
}

function atualizarFerramentas() {
  $("voltar").disabled = $("redefinir").disabled = !estado.zoom.length;
}

function selecionarTrecho(inicio, fim) {
  if (fim - inicio < ZOOM_MIN_MS) {
    const meio = (inicio + fim) / 2;
    inicio = meio - ZOOM_MIN_MS / 2;
    fim = meio + ZOOM_MIN_MS / 2;
  }
  if (estado.modo === "historico") {
    irPara({ inicio, fim });
    return;
  }
  // No tempo real, congela o trecho no histórico; "Voltar" mostra a janela inteira.
  const x = grafico.scales.x;
  estado.zoom = [{ inicio: Math.round(x.min), fim: Math.round(x.max) }];
  definirPeriodo({ inicio, fim });
  trocarModo("historico");
}

// --------------------------------------------------------------------------- seleção por arrasto

let arrasto = null;

function posicaoNoCanvas(e) {
  const r = grafico.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function desenharSelecao() {
  const a = grafico.chartArea;
  const el = $("selecao");
  el.style.left = `${Math.min(arrasto.x0, arrasto.x1)}px`;
  el.style.width = `${Math.abs(arrasto.x1 - arrasto.x0)}px`;
  el.style.top = `${a.top}px`;
  el.style.height = `${a.bottom - a.top}px`;
  el.hidden = false;
}

function encerrarArrasto() {
  arrasto = null;
  $("selecao").hidden = true;
}

grafico.canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !estado.device) return;
  if (estado.modo === "tempo-real" && !grafico.data.datasets[0].data.length) return;
  const { x, y } = posicaoNoCanvas(e);
  const a = grafico.chartArea;
  if (x < a.left || x > a.right || y < a.top || y > a.bottom) return;
  arrasto = { x0: x, x1: x };
  grafico.canvas.setPointerCapture(e.pointerId);
});

grafico.canvas.addEventListener("pointermove", (e) => {
  if (!arrasto) return;
  const a = grafico.chartArea;
  arrasto.x1 = Math.min(Math.max(posicaoNoCanvas(e).x, a.left), a.right);
  desenharSelecao();
});

grafico.canvas.addEventListener("pointerup", () => {
  if (!arrasto) return;
  const esq = Math.min(arrasto.x0, arrasto.x1);
  const dir = Math.max(arrasto.x0, arrasto.x1);
  encerrarArrasto();
  if (dir - esq < ARRASTO_MIN_PX) return;
  const x = grafico.scales.x;
  selecionarTrecho(x.getValueForPixel(esq), x.getValueForPixel(dir));
});

grafico.canvas.addEventListener("pointercancel", encerrarArrasto);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && arrasto) encerrarArrasto();
});
grafico.canvas.addEventListener("dblclick", () => {
  if (estado.modo === "historico") voltar();
});

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
$("aplicar").addEventListener("click", () => {
  try {
    novoPeriodo(lerPeriodoInputs());
  } catch (e) {
    setStatus(e.message, true);
  }
});
document.querySelectorAll("[data-minutos]").forEach((b) => b.addEventListener("click", () => {
  const agora = Date.now();
  novoPeriodo({ inicio: agora - Number(b.dataset.minutos) * 60_000, fim: agora });
}));
$("anterior").addEventListener("click", () => deslocar(-0.5));
$("proximo").addEventListener("click", () => deslocar(0.5));
$("afastar").addEventListener("click", afastar);
$("voltar").addEventListener("click", voltar);
$("redefinir").addEventListener("click", redefinir);

trocarModo("tempo-real");
atualizarDispositivos();
setInterval(atualizarDispositivos, INTERVALO_DISPOSITIVOS_MS);
