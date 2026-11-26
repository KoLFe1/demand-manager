// Registro das visualizações (telas) do Demand Manager.
//
//   import { views, viewById, viewByPath, loadViews } from './views/index.js';
//   await loadViews();          // o boot chama uma vez, antes de montar a casca
//
// Cada tela é um módulo em js/ui/views/<id>.js com a forma
//   { id, path, title, icon, order, section, render(app, ctx), badge?(app), onEnter?(app, ctx), onLeave?(app) }
// (export default; `export const view` também é aceito).
//
// As telas são carregadas com import() dinâmico, UMA POR UMA e isoladas: se o módulo de uma tela não carrega
// (erro de sintaxe, arquivo faltando, falha numa dependência só dela), só aquela tela vira um cartão de erro —
// a navegação continua completa e as outras telas funcionam.
//
// A ordem da navegação é FIXA aqui (CANONICAL), para não depender do `order` que cada tela declara; os campos
// que uma tela não informar (caminho, seção, ícone, título) são completados com os padrões abaixo. Uma tela
// que não está na lista canônica entra depois das conhecidas, pela ordem do seu `order`.

/** Seções da navegação, na ordem em que aparecem na barra lateral. */
export const VIEW_SECTIONS = Object.freeze([
  Object.freeze({ id: 'main', label: '' }),
  Object.freeze({ id: 'views', label: 'Visualizações' }),
  Object.freeze({ id: 'analysis', label: 'Análise' }),
  Object.freeze({ id: 'system', label: '' }),
]);

/** Ordem canônica da navegação e padrões de cada tela. */
const CANONICAL = Object.freeze([
  { id: 'dashboard', title: 'Início', icon: 'home', section: 'main' },
  { id: 'semana', title: 'Minha Semana', icon: 'calendar-week', section: 'main' },
  { id: 'demandas', title: 'Demandas', icon: 'list', section: 'main' },
  { id: 'kanban', title: 'Kanban', icon: 'kanban', section: 'main' },
  { id: 'aguardando', title: 'Aguardando', icon: 'hourglass', section: 'main' },
  { id: 'calendario', title: 'Calendário', icon: 'calendar', section: 'views' },
  { id: 'hierarquia', title: 'Hierarquia', icon: 'tree', section: 'views' },
  { id: 'backlog', title: 'Backlog', icon: 'inbox', section: 'views' },
  { id: 'dependencias', title: 'Dependências', icon: 'git-branch', section: 'views' },
  { id: 'cronograma', title: 'Cronograma', icon: 'rows', section: 'views' },
  { id: 'tempo', title: 'Tempo', icon: 'timer', section: 'analysis' },
  { id: 'metricas', title: 'Métricas', icon: 'chart', section: 'analysis' },
  { id: 'relatorio', title: 'Relatório', icon: 'file-text', section: 'analysis' },
  { id: 'config', title: 'Configurações', icon: 'settings', section: 'system' },
]);

const SECTION_IDS = new Set(VIEW_SECTIONS.map((section) => section.id));

/** Encontra o objeto da tela dentro de um módulo (export default, `view`, ou o primeiro export com render). */
function pickView(module) {
  if (!module || typeof module !== 'object') return null;
  const candidates = [module.default, module.view, ...Object.values(module)];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate.render === 'function') return candidate;
  }
  return null;
}

/** Tela mostrada no lugar de um módulo que não exporta uma visualização válida (ou que não carregou). */
function brokenView(id, error = null) {
  const reason = error
    ? `O arquivo da tela (js/ui/views/${id}.js) não pôde ser carregado: ${error && error.message ? error.message : String(error)}`
    : `O módulo js/ui/views/${id}.js não exporta uma visualização válida (falta render).`;
  return {
    render() {
      throw new Error(reason);
    },
  };
}

/** Módulo ainda não carregado (antes de loadViews()): a tela aparece como "carregando". */
function pendingView() {
  return {
    render() {
      throw new Error('A tela ainda está sendo carregada.');
    },
  };
}

/** Marcador de módulo que falhou ao carregar (buildRegistry transforma em brokenView com o motivo). */
const FAILED = Symbol('falhou');

/**
 * Normaliza a lista de módulos de tela: completa os campos ausentes, garante caminhos únicos e aplica a
 * ordem canônica da navegação.
 * @param {Array<[string, object]>} modules pares [id esperado, módulo importado]
 * @returns {ReadonlyArray<object>} telas prontas para a casca, já ordenadas
 */
export function buildRegistry(modules) {
  const list = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const [expectedId, module] of modules) {
    const found =
      module && module[FAILED] ? brokenView(expectedId, module[FAILED]) : module === null ? pendingView() : pickView(module) || brokenView(expectedId);
    const index = CANONICAL.findIndex((entry) => entry.id === expectedId);
    const defaults = index >= 0 ? CANONICAL[index] : { id: expectedId, title: expectedId, icon: 'file-text', section: 'views' };
    // A identidade vem do nome do arquivo: assim a navegação continua completa mesmo se a tela declarar outro id.
    const id = expectedId;
    if (seenIds.has(id)) continue;
    let path = typeof found.path === 'string' && found.path.trim() ? found.path.trim() : `/${id}`;
    if (path[0] !== '/') path = `/${path}`;
    if (seenPaths.has(path)) path = `/${id}`;
    const view = Object.freeze({
      ...found,
      id,
      path,
      title: typeof found.title === 'string' && found.title.trim() ? found.title : defaults.title,
      icon: typeof found.icon === 'string' && found.icon ? found.icon : defaults.icon,
      section: index >= 0 ? defaults.section : SECTION_IDS.has(found.section) ? found.section : defaults.section,
      order: index >= 0 ? (index + 1) * 10 : 1000 + (Number.isFinite(found.order) ? found.order : 0),
      render: found.render.bind(found),
      badge: typeof found.badge === 'function' ? found.badge.bind(found) : null,
      onEnter: typeof found.onEnter === 'function' ? found.onEnter.bind(found) : null,
      onLeave: typeof found.onLeave === 'function' ? found.onLeave.bind(found) : null,
    });
    seenIds.add(id);
    seenPaths.add(path);
    list.push(view);
  }
  list.sort((a, b) => a.order - b.order);
  return Object.freeze(list);
}

/** Identificadores (= nomes de arquivo) das telas carregadas por loadViews(), na ordem canônica. */
export const VIEW_IDS = Object.freeze(CANONICAL.map((entry) => entry.id));

/** Carregador padrão: o módulo js/ui/views/<id>.js. */
export const importView = (id) => import(`./${id}.js`);

/**
 * Todas as telas, na ordem da navegação (Configurações por último, na seção 'system').
 * Antes de loadViews() cada tela é um marcador "ainda carregando"; depois, as telas reais (ligação viva: quem
 * importou `views` passa a ver a lista nova).
 */
export let views = buildRegistry(VIEW_IDS.map((id) => [id, null]));

let loading = null;

/**
 * Carrega os módulos das telas, cada um isolado: um módulo que falha vira uma tela com cartão de erro (o motivo
 * aparece na mensagem) e o resto continua funcionando. Chamado pelo boot antes de montar a casca.
 * @param {{ importer?: (id: string) => Promise<object>, force?: boolean }} [options]
 *        importer: carregador (testes); force: carrega de novo mesmo se já carregou
 * @returns {Promise<ReadonlyArray<object>>} as telas
 */
export function loadViews({ importer = importView, force = false } = {}) {
  if (loading && !force) return loading;
  loading = Promise.all(
    VIEW_IDS.map((id) =>
      Promise.resolve()
        .then(() => importer(id))
        .then(
          (module) => [id, module || {}],
          (error) => {
            console.error(`[telas] a tela "${id}" não pôde ser carregada`, error);
            return [id, { [FAILED]: error || new Error('falha desconhecida') }];
          },
        ),
    ),
  ).then((modules) => {
    views = buildRegistry(modules);
    return views;
  });
  return loading;
}

/**
 * Tela pelo identificador.
 * @param {string} id
 * @returns {object|null}
 */
export function viewById(id) {
  return views.find((view) => view.id === id) || null;
}

/**
 * Tela pelo caminho da rota (ex.: '/kanban').
 * @param {string} path
 * @returns {object|null}
 */
export function viewByPath(path) {
  return views.find((view) => view.path === path) || null;
}
