"use strict";

const JANELA_MS = 60_000;          // largura da janela do modo tempo real
const INTERVALO_PONTOS_MS = 1_000; // polling de pontos novos
const INTERVALO_STATS_MS = 5_000;  // polling dos cards/tabela
const INTERVALO_DISPOSITIVOS_MS = 15_000;
const ZOOM_MIN_MS = 500;           // menor trecho que o zoom do histórico aceita
const ARRASTO_MIN_PX = 6;          // abaixo disso o arrasto é tratado como clique
const LARGURA_EIXO_Y = 64;         // fixa para os gráficos empilhados ficarem alinhados

// Cada bloco é um tipo de medição, com seu próprio dispositivo, rotas e gráficos.
// Modo (tempo real/histórico), período e zoom são compartilhados por todos.
const BLOCOS = [
  {
    id: "acel",
    rotas: {
      dispositivos: "/api/dispositivos",
      pontos: "/api/leituras",
      recentes: "/api/leituras/recentes",
      estatisticas: "/api/estatisticas",
      csv: "/api/leituras.csv",
    },
    campos: [
      { chave: "x", rotulo: "X", unidade: "m/s²", cor: "--serie-x", casas: 3 },
      { chave: "y", rotulo: "Y", unidade: "m/s²", cor: "--serie-y", casas: 3 },
      { chave: "z", rotulo: "Z", unidade: "m/s²", cor: "--serie-z", casas: 3 },
    ],
    graficos: [{ canvas: "acel-grafico", campos: ["x", "y", "z"] }],
  },
  {
    id: "energia",
    rotas: {
      dispositivos: "/api/energia/dispositivos",
      pontos: "/api/energia",
      recentes: "/api/energia/recentes",
      estatisticas: "/api/energia/estatisticas",
      csv: "/api/energia.csv",
    },
    campos: [
      { chave: "tensao", rotulo: "Tensão", unidade: "V", cor: "--serie-tensao", casas: 1 },
      { chave: "corrente", rotulo: "Corrente", unidade: "A", cor: "--serie-corrente", casas: 3 },
      { chave: "potencia", rotulo: "Potência", unidade: "W", cor: "--serie-potencia", casas: 1 },
    ],
    graficos: [
      { canvas: "energia-tensao", campos: ["tensao"] },
      { canvas: "energia-corrente", campos: ["corrente"] },
      { canvas: "energia-potencia", campos: ["potencia"] },
    ],
  },
];

const estado = {
  modo: "tempo-real",
  periodo: null,     // {inicio, fim} em ms do histórico; os inputs só guardam segundos
  zoom: [],          // períodos anteriores, para "Voltar"
  geracao: 0,        // invalida respostas antigas quando o modo/dispositivo muda
  timers: [],
};

const $ = (id) => document.getElementById(id);
const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtCurto = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const fmtSegundos = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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

function num(campo, v) {
  return v === null || v === undefined ? "–" : campo.fmt.format(v);
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

// --------------------------------------------------------------------------- gráficos

function criarGrafico(canvas, campos) {
  const unidade = campos[0].unidade;
  const grafico = new Chart(canvas, {
    type: "line",
    data: {
      datasets: campos.map((c) => ({
        label: c.rotulo,
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
        y: {
          title: { display: true, text: unidade },
          afterFit: (escala) => { escala.width = LARGURA_EIXO_Y; },
        },
      },
      plugins: {
        // Uma série só: o título do gráfico já a identifica.
        legend: {
          display: campos.length > 1,
          position: "top",
          align: "end",
          labels: { boxWidth: 12, boxHeight: 12, usePointStyle: false },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const c = campos[ctx.datasetIndex];
              return ` ${c.rotulo}: ${c.fmt.format(ctx.parsed.y)} ${c.unidade}`;
            },
          },
        },
      },
    },
  });
  grafico.$campos = campos;

  // Retângulo da seleção por arrasto, por cima do canvas.
  const selecao = document.createElement("div");
  selecao.className = "selecao";
  selecao.hidden = true;
  canvas.parentElement.append(selecao);
  grafico.$selecao = selecao;
  return grafico;
}

for (const bloco of BLOCOS) {
  for (const c of bloco.campos) {
    c.fmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: c.casas, maximumFractionDigits: c.casas });
  }
  const porChave = Object.fromEntries(bloco.campos.map((c) => [c.chave, c]));
  bloco.graficos = bloco.graficos.map((g) => criarGrafico($(g.canvas), g.campos.map((k) => porChave[k])));
  bloco.device = null;
  bloco.dispositivos = [];
  bloco.ultimoId = 0;

  $(`${bloco.id}-ultima`).innerHTML = bloco.campos.map((c) =>
    `<span><i class="chip" style="background: var(${c.cor})"></i>${c.rotulo} ` +
    `<b id="${bloco.id}-ultimo-${c.chave}">–</b><small>${c.unidade}</small></span>`
  ).join("");
}

const todosGraficos = () => BLOCOS.flatMap((b) => b.graficos);

function aplicarCores() {
  const texto2 = cssVar("--texto-2");
  const mudo = cssVar("--texto-mudo");
  const grade = cssVar("--grade");
  const eixo = cssVar("--eixo");
  for (const grafico of todosGraficos()) {
    grafico.data.datasets.forEach((ds, i) => {
      const cor = cssVar(grafico.$campos[i].cor);
      ds.borderColor = cor;
      ds.backgroundColor = cor;
    });
    for (const escala of Object.values(grafico.options.scales)) {
      escala.ticks.color = mudo;
      escala.grid = { color: grade };
      escala.border = { color: eixo };
      if (escala.title) escala.title.color = texto2;
    }
    grafico.options.plugins.legend.labels.color = texto2;
    grafico.update("none");
  }
}
aplicarCores();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", aplicarCores);

function atualizarGraficos(bloco) {
  bloco.graficos.forEach((g) => g.update("none"));
}

function limparGraficos(bloco) {
  for (const g of bloco.graficos) g.data.datasets.forEach((ds) => { ds.data = []; });
  atualizarGraficos(bloco);
}

function adicionarPontos(bloco, pontos) {
  for (const g of bloco.graficos) {
    g.data.datasets.forEach((ds, i) => {
      const chave = g.$campos[i].chave;
      for (const p of pontos) ds.data.push({ x: p.t, y: p[chave] });
    });
  }
}

// Todas as séries de um bloco vêm das mesmas leituras: a primeira serve de referência.
function dadosReferencia(bloco) {
  return bloco.graficos[0].data.datasets[0].data;
}

function cortarJanela(bloco) {
  const dados = dadosReferencia(bloco);
  if (!dados.length) return;
  const limite = dados[dados.length - 1].x - JANELA_MS;
  let corte = 0;
  while (corte < dados.length && dados[corte].x < limite) corte++;
  if (corte) {
    for (const g of bloco.graficos) g.data.datasets.forEach((ds) => ds.data.splice(0, corte));
  }
}

function fixarEixoX(min, max) {
  for (const g of todosGraficos()) {
    g.options.scales.x.min = min;
    g.options.scales.x.max = max;
    g.update("none");
  }
}

// --------------------------------------------------------------------------- cards e tabela

function periodoAtual(bloco) {
  if (estado.modo === "historico") {
    const p = estado.periodo;
    return { inicio: new Date(p.inicio).toISOString(), fim: new Date(p.fim).toISOString() };
  }
  const dados = dadosReferencia(bloco);
  const ultimo = dados.length ? dados[dados.length - 1].x : null;
  return { inicio: ultimo ? new Date(ultimo - JANELA_MS).toISOString() : null, fim: null };
}

async function atualizarEstatisticas(bloco, geracao) {
  if (!bloco.device) return;
  const stats = await getJSON(bloco.rotas.estatisticas + "?" + qs({ device_id: bloco.device, ...periodoAtual(bloco) }));
  if (geracao !== estado.geracao) return;

  $(`${bloco.id}-total`).textContent = fmtInt.format(stats.total);
  const disp = bloco.dispositivos.find((d) => d.device_id === bloco.device);
  $(`${bloco.id}-armazenado`).textContent = disp ? fmtInt.format(disp.total) : "–";

  const u = stats.ultima;
  for (const c of bloco.campos) {
    $(`${bloco.id}-ultimo-${c.chave}`).textContent = u ? num(c, u[c.chave]) : "–";
  }
  $(`${bloco.id}-ultima-hora`).textContent = u ? "· " + fmtHora.format(new Date(u.t)) : "";

  const corpo = $(`${bloco.id}-stats`);
  if (!stats.total) {
    corpo.innerHTML = '<tr><td colspan="5" class="vazio">Sem dados no período</td></tr>';
  } else {
    corpo.innerHTML = bloco.campos.map((c) => {
      const s = stats.campos[c.chave];
      return `<tr><td><i class="chip" style="background: var(${c.cor})"></i>${c.rotulo} (${c.unidade})</td>` +
        `<td>${num(c, s.min)}</td><td>${num(c, s.max)}</td><td>${num(c, s.media)}</td><td>${num(c, s.desvio)}</td></tr>`;
    }).join("");
  }
  atualizarLinksCsv(bloco);
}

function atualizarLinksCsv(bloco) {
  const params = { device_id: bloco.device, ...periodoAtual(bloco) };
  $(`${bloco.id}-csv`).href = bloco.rotas.csv + "?" + qs(params);
  $(`${bloco.id}-csv-excel`).href = bloco.rotas.csv + "?" + qs({ ...params, excel: 1 });
}

function limparCards(bloco) {
  for (const sufixo of ["total", "armazenado"]) $(`${bloco.id}-${sufixo}`).textContent = "–";
  for (const c of bloco.campos) $(`${bloco.id}-ultimo-${c.chave}`).textContent = "–";
  $(`${bloco.id}-ultima-hora`).textContent = "";
  $(`${bloco.id}-stats`).innerHTML = '<tr><td colspan="5" class="vazio">Sem dados</td></tr>';
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

async function buscarPontosRecentes(bloco, geracao) {
  const dados = await getJSON(bloco.rotas.recentes + "?" + qs({
    device_id: bloco.device,
    apos_id: bloco.ultimoId || null,
    janela_s: JANELA_MS / 1000,
  }));
  if (geracao !== estado.geracao) return;

  const primeiraCarga = !bloco.ultimoId;
  adicionarPontos(bloco, dados.pontos);
  bloco.ultimoId = dados.ultimo_id;
  // Os cards usam a janela do gráfico; atualiza assim que ela existe.
  if (primeiraCarga && dados.pontos.length) atualizarEstatisticas(bloco, geracao).catch(() => {});
  cortarJanela(bloco);
  atualizarGraficos(bloco);

  const qtd = dadosReferencia(bloco).length;
  $(`${bloco.id}-nota`).textContent = `últimos ${JANELA_MS / 1000} s · ${fmtInt.format(qtd)} pontos`;
  setStatus(`Tempo real · atualizado às ${new Date().toLocaleTimeString("pt-BR")}`);
}

function iniciarTempoReal() {
  const geracao = ++estado.geracao;
  pararTimers();
  fixarEixoX(undefined, undefined);
  for (const bloco of BLOCOS) {
    bloco.ultimoId = 0;
    limparGraficos(bloco);
    if (!bloco.device) continue;
    repetir((g) => buscarPontosRecentes(bloco, g), INTERVALO_PONTOS_MS, geracao);
    repetir((g) => atualizarEstatisticas(bloco, g), INTERVALO_STATS_MS, geracao, INTERVALO_STATS_MS);
  }
}

async function carregarHistoricoBloco(bloco, geracao) {
  const p = estado.periodo;
  const dados = await getJSON(bloco.rotas.pontos + "?" + qs({ device_id: bloco.device, ...periodoAtual(bloco) }));
  if (geracao !== estado.geracao) return;
  limparGraficos(bloco);
  adicionarPontos(bloco, dados.pontos);
  atualizarGraficos(bloco);

  const leituras = `${fmtDuracao(p.fim - p.inicio)} · ${fmtInt.format(dados.total)} leituras`;
  $(`${bloco.id}-nota`).textContent = dados.agregado
    ? `${leituras} · média a cada ${fmtSegundos.format(dados.balde_s)} s`
    : leituras;
  await atualizarEstatisticas(bloco, geracao);
}

async function carregarHistorico() {
  const geracao = ++estado.geracao;
  pararTimers();
  atualizarFerramentas();

  // Fixa o eixo no período pedido: o zoom aparece na hora, com os dados que já
  // estão na tela, e é refinado quando chega a resposta com mais resolução.
  fixarEixoX(estado.periodo.inicio, estado.periodo.fim);

  const ativos = BLOCOS.filter((b) => b.device);
  if (!ativos.length) return;
  setStatus("Carregando histórico…");
  const resultados = await Promise.allSettled(ativos.map((b) => carregarHistoricoBloco(b, geracao)));
  if (geracao !== estado.geracao) return;
  const falha = resultados.find((r) => r.status === "rejected");
  if (falha) setStatus("Erro: " + falha.reason.message, true);
  else setStatus("Histórico carregado");
}

function trocarModo(modo) {
  estado.modo = modo;
  document.querySelectorAll(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.modo === modo));
  $("controles-historico").hidden = modo !== "historico";
  $("ferramentas").hidden = modo !== "historico";
  $("dica-grafico").textContent = modo === "historico"
    ? "Arraste sobre qualquer gráfico para ampliar um trecho em todos · duplo clique para voltar · clique na legenda para ocultar um eixo"
    : "Arraste sobre um gráfico para congelar um trecho e analisá-lo no histórico · clique na legenda para ocultar um eixo";

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

function selecionarTrecho(grafico, inicio, fim) {
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

let arrasto = null;  // {grafico, x0, x1}

function posicaoNoCanvas(grafico, e) {
  const r = grafico.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function desenharSelecao() {
  const a = arrasto.grafico.chartArea;
  const el = arrasto.grafico.$selecao;
  el.style.left = `${Math.min(arrasto.x0, arrasto.x1)}px`;
  el.style.width = `${Math.abs(arrasto.x1 - arrasto.x0)}px`;
  el.style.top = `${a.top}px`;
  el.style.height = `${a.bottom - a.top}px`;
  el.hidden = false;
}

function encerrarArrasto() {
  if (arrasto) arrasto.grafico.$selecao.hidden = true;
  arrasto = null;
}

function ativarArrasto(bloco, grafico) {
  const canvas = grafico.canvas;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !bloco.device) return;
    if (estado.modo === "tempo-real" && !dadosReferencia(bloco).length) return;
    const { x, y } = posicaoNoCanvas(grafico, e);
    const a = grafico.chartArea;
    if (x < a.left || x > a.right || y < a.top || y > a.bottom) return;
    arrasto = { grafico, x0: x, x1: x };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!arrasto || arrasto.grafico !== grafico) return;
    const a = grafico.chartArea;
    arrasto.x1 = Math.min(Math.max(posicaoNoCanvas(grafico, e).x, a.left), a.right);
    desenharSelecao();
  });

  canvas.addEventListener("pointerup", () => {
    if (!arrasto || arrasto.grafico !== grafico) return;
    const esq = Math.min(arrasto.x0, arrasto.x1);
    const dir = Math.max(arrasto.x0, arrasto.x1);
    encerrarArrasto();
    if (dir - esq < ARRASTO_MIN_PX) return;
    const x = grafico.scales.x;
    selecionarTrecho(grafico, x.getValueForPixel(esq), x.getValueForPixel(dir));
  });

  canvas.addEventListener("pointercancel", encerrarArrasto);
  canvas.addEventListener("dblclick", () => {
    if (estado.modo === "historico") voltar();
  });
}

for (const bloco of BLOCOS) bloco.graficos.forEach((g) => ativarArrasto(bloco, g));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && arrasto) encerrarArrasto();
});

function recarregar() {
  if (estado.modo === "historico") carregarHistorico();
  else iniciarTempoReal();
}

// --------------------------------------------------------------------------- dispositivos

// Atualiza a lista de um bloco; devolve true se o bloco ganhou um dispositivo agora.
async function atualizarDispositivosBloco(bloco) {
  bloco.dispositivos = await getJSON(bloco.rotas.dispositivos);

  const select = $(`${bloco.id}-dispositivo`);
  const atuais = [...select.options].map((o) => o.value).join("|");
  const novos = bloco.dispositivos.map((d) => d.device_id).join("|");
  if (atuais !== novos) {
    select.replaceChildren(...bloco.dispositivos.map((d) => new Option(d.device_id, d.device_id)));
    if (bloco.device && novos.split("|").includes(bloco.device)) select.value = bloco.device;
  }

  if (!bloco.dispositivos.length) {
    $(`${bloco.id}-nota`).textContent = "Nenhuma leitura recebida ainda. Aguardando o microcontrolador…";
    return false;
  }
  if (!bloco.device) {
    bloco.device = select.value;
    return true;
  }
  return false;
}

async function atualizarDispositivos() {
  const resultados = await Promise.allSettled(BLOCOS.map(atualizarDispositivosBloco));
  const falha = resultados.find((r) => r.status === "rejected");
  if (falha) setStatus("Erro ao listar dispositivos: " + falha.reason.message, true);
  else if (BLOCOS.every((b) => !b.dispositivos.length)) {
    setStatus("Nenhuma leitura recebida ainda. Aguardando os microcontroladores…");
  }
  if (resultados.some((r) => r.value === true)) recarregar();
}

// --------------------------------------------------------------------------- eventos

for (const bloco of BLOCOS) {
  $(`${bloco.id}-dispositivo`).addEventListener("change", (e) => {
    bloco.device = e.target.value;
    limparCards(bloco);
    recarregar();
  });
}
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
