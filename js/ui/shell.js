// Casca do aplicativo: barra lateral, barra superior, área da tela, painel lateral, barra de abas do celular,
// roteamento, atalhos de teclado, indicador de sincronização e cronômetro ativo.
//
//   const ui = startShell(app, document.getElementById('app'));   // também define app.ui
//
// app.ui = {
//   navigate(path, params), route() → { path, params }, openPanel(type, id, { tab?, state?, replace? }), closePanel(),
//   panel() → { type, id } | null, rerender(), toast(message, opts), scope: { projectId }, setScope(patch),
//   viewState(viewId), setViewState(viewId, patch)   // estado de qualquer tela (ex.: abrir outra já filtrada)
//   current() → { type, id } | null, quickCreate(type, defaults), isMobile(), theme(), setTheme(t),
//   // extras: shortcuts, showHelp(), openPalette(query), showDigest(), checkDailyDigest(), showWhatsNew(), checkWhatsNew(), createProject(), openSync(anchor), destroy()
// }
//
// Renderização: três mount() (core/dom.js) — casca, tela e painel. A casca deixa os hospedeiros da tela
// (<main>) e do painel com data-morph="skip"; cada região tem seu próprio desenho e o agendador da casca junta
// os pedidos por quadro marcando só as regiões afetadas: trocar de aba no painel desenha só o painel; abrir/
// fechar o painel desenha casca + painel (e a tela apenas se ela leu app.ui.panel() no último desenho, p. ex.
// para destacar a linha). Banco, rota e estado das telas desenham tudo; sincronização desenha a casca (e a
// tela que declara `sync: true`). O tique de 1 min desenha a casca e, se um cronômetro roda ou o dia virou,
// também tela e painel. Contadores em app.ui.__renders. Erro numa tela vira um cartão de erro no lugar
// dela — a casca continua usável.

import { formatDateTime, formatRelativeTime } from '../core/dates.js';
import { cx, h, mount } from '../core/dom.js';
import { createRouter, parseHash } from '../core/router.js';
import { createShortcuts } from '../core/shortcuts.js';
import { TIMER, elapsedSeconds, formatDuration, isLongRunning, timerState } from '../domain/timetracking.js';
import { alertsButton } from './alerts.js';
import { accountSummary, openAccountDialog } from './auth.js';
import { checkDailyDigest, openDigestModal } from './digest.js';
import { checkWhatsNew, openWhatsNew } from './whatsnew.js';
import { openShortcutHelp } from './help.js';
import { button, iconButton, textArea } from './kit/controls.js';
import { alertBox, avatar, countBadge } from './kit/display.js';
import { icon } from './kit/icons.js';
import { closeAllOverlays, isOverlayOpen, openMenu, openPopover, toast } from './kit/overlays.js';
import { NAV_SHORTCUTS, openPalette } from './palette.js';
import { panels } from './panels/index.js';
import { openProjectDialog, openProjectMenu, projectDot } from './projects.js';
import { openQuickCreate } from './quick-create.js';
import { openTemplateDialog } from './templates.js';
import { entityActions, openEntityMenu } from './shared/entity.js';
import { VIEW_SECTIONS, viewById, viewByPath, views } from './views/index.js';

/** Largura (px) a partir da qual a interface é de computador; abaixo dela, de celular. */
export const MOBILE_BREAKPOINT = 768;

/** Rota padrão (e destino de rotas desconhecidas). */
export const DEFAULT_PATH = '/dashboard';

/** Destinos da barra de abas do celular (o quinto botão, "Mais…", abre a gaveta). */
export const TAB_BAR_VIEWS = Object.freeze(['dashboard', 'semana', 'demandas', 'kanban']);

/** Rótulos curtos da barra de abas. */
const TAB_LABELS = Object.freeze({ dashboard: 'Início', semana: 'Semana', demandas: 'Demandas', kanban: 'Kanban' });

/** Tipos de entidade que abrem no painel lateral. */
const PANEL_TYPES = new Set(['task', 'demand']);

const THEMES = new Set(['light', 'dark', 'system']);
const THEME_COLORS = Object.freeze({ light: '#ffffff', dark: '#17171a' });

/** Nome legível de cada tabela (falhas de sincronização). */
export const SYNC_TABLE_LABELS = Object.freeze({
  settings: 'Configuração',
  projects: 'Projeto',
  demands: 'Demanda',
  tasks: 'Tarefa',
  task_dependencies: 'Dependência',
  time_entries: 'Apontamento de tempo',
  week_items: 'Planejamento semanal',
  notes: 'Observação',
  activity_log: 'Histórico',
});

// ---------------------------------------------------------------------------
// Utilidades puras (exportadas para testes e para a tela de Configurações)
// ---------------------------------------------------------------------------

/**
 * Interpreta o parâmetro `panel` da URL ('task:<id>' ou 'demand:<id>').
 * @param {string|null|undefined} value
 * @returns {{ type: 'task'|'demand', id: string }|null}
 */
export function parsePanelParam(value) {
  if (typeof value !== 'string') return null;
  const match = /^(task|demand):(.+)$/.exec(value.trim());
  return match ? { type: match[1], id: match[2] } : null;
}

/**
 * Interpreta um atributo data-entity ('task:<id>' / 'demand:<id>').
 * @param {string|null|undefined} value
 * @returns {{ type: 'task'|'demand', id: string }|null}
 */
export function parseEntityRef(value) {
  return parsePanelParam(value);
}

/** "há 2 min" → "Sincronizado há 2 min"; "agora" → "Sincronizado agora". */
function syncedText(relative) {
  if (!relative) return 'Sincronizado';
  return `Sincronizado ${relative}`;
}

/**
 * Resumo do estado da sincronização para o indicador e para a tela de Configurações.
 * @param {object} app
 * @param {{ online?: boolean }} [options] online: estado da conexão do navegador (padrão navigator.onLine)
 * @returns {{ state: string, label: string, description: string, icon: string, tone: string, pending: number,
 *             lastSyncAt: string|null, lastError: object|null, failures: Array, user: object|null, busy: boolean }}
 */
export function syncSummary(app, { online } = {}) {
  const demo = !!(app && app.env && app.env.demo);
  const isOnline = typeof online === 'boolean' ? online : typeof navigator === 'undefined' || navigator.onLine !== false;
  let status = null;
  if (app && app.sync && typeof app.sync.status === 'function') {
    try {
      status = app.sync.status();
    } catch {
      status = null;
    }
  }
  let pending = 0;
  try {
    pending = status && Number.isFinite(status.pending) ? status.pending : app && app.store ? app.store.pendingCount() : 0;
  } catch {
    pending = 0;
  }
  const base = {
    pending,
    lastSyncAt: status ? status.lastSyncAt || null : null,
    lastError: status ? status.lastError || null : null,
    failures: status && Array.isArray(status.failures) ? status.failures : [],
    user: status ? status.user || null : null,
    busy: false,
  };
  let state = status ? status.state : 'disabled';
  if (!isOnline && state !== 'disabled' && state !== 'needs-login' && state !== 'needs-reload' && state !== 'schema-outdated') state = 'offline';
  const pendingText = pending === 1 ? '1 pendente' : `${pending} pendentes`;
  switch (state) {
    case 'needs-reload':
      return {
        ...base,
        state,
        label: 'Recarregue para sincronizar',
        icon: 'refresh',
        tone: 'warning',
        description:
          (base.lastError && base.lastError.message) ||
          'A conta conectada não é a dona dos dados abertos nesta aba. Nada é enviado nem recebido até você recarregar a página.',
      };
    case 'needs-login':
      return { ...base, state, label: 'Entrar para sincronizar', icon: 'login', tone: 'warning', description: 'O Supabase está configurado, mas você ainda não entrou na conta. As alterações ficam guardadas aqui e serão enviadas quando você entrar.' };
    case 'syncing':
      return { ...base, state, busy: true, label: 'Sincronizando…', icon: 'refresh', tone: 'accent', description: 'Enviando e recebendo alterações.' };
    case 'idle': {
      const now = app.clock.now();
      const label = pending > 0 ? `${pending === 1 ? '1 alteração' : `${pending} alterações`} a enviar` : base.lastSyncAt ? syncedText(formatRelativeTime(base.lastSyncAt, now)) : 'Sincronizado';
      return { ...base, state, label, icon: 'cloud', tone: pending > 0 ? 'warning' : 'success', description: 'Os dados estão sincronizados com a sua conta.' };
    }
    case 'offline':
      return { ...base, state, label: pending > 0 ? `Offline · ${pendingText}` : 'Offline', icon: 'cloud-off', tone: 'warning', description: 'Sem conexão. As alterações continuam guardadas neste dispositivo e serão enviadas quando a conexão voltar.' };
    case 'error':
      return { ...base, state, label: 'Erro na sincronização', icon: 'alert-triangle', tone: 'danger', description: 'A última tentativa de sincronizar falhou. Nada foi perdido: as alterações continuam guardadas neste dispositivo.' };
    case 'schema-outdated':
      return { ...base, state, label: 'Atualize o banco do Supabase', icon: 'alert-circle', tone: 'danger', description: 'A sincronização está pausada porque o banco do Supabase é de uma versão anterior do app. Continue usando normalmente: nada é perdido — as alterações ficam guardadas neste dispositivo e são enviadas depois da atualização.' };
    default:
      return {
        ...base,
        state: 'disabled',
        label: 'Somente neste dispositivo',
        icon: 'cloud-off',
        tone: 'muted',
        description: demo
          ? 'Modo demonstração: os dados de exemplo ficam só neste navegador e nunca são sincronizados.'
          : 'Os dados ficam guardados só neste navegador. Para usar o Demand Manager em outros dispositivos, configure o Supabase em Configurações.',
      };
  }
}

/**
 * Corpo dos detalhes da sincronização (popover do indicador e tela de Configurações).
 * @param {object} app
 * @param {{ onNavigate?: () => void, compact?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function syncDetails(app, { onNavigate, compact = false } = {}) {
  const s = syncSummary(app);
  const now = app.clock.now();
  const canSync = !!app.sync && s.state !== 'disabled' && s.state !== 'needs-login' && s.state !== 'needs-reload';
  const session = app.remote && app.remote.configured ? safeSession(app) : null;
  const rows = [];
  if (s.state !== 'disabled') {
    rows.push(['Alterações pendentes', String(s.pending)]);
    rows.push(['Última sincronização', s.lastSyncAt ? `${formatDateTime(s.lastSyncAt)} (${formatRelativeTime(s.lastSyncAt, now)})` : 'ainda não sincronizou']);
    if (session) rows.push(['Conta', session.user.email || 'conectada']);
  } else if (s.pending > 0 && app.remote) {
    rows.push(['Alterações pendentes', String(s.pending)]);
  }
  return h(
    'div',
    { class: cx('sync-details', compact && 'is-compact'), 'data-sync-details': s.state },
    h('div', { class: cx('sync-details-head', `tone-${s.tone}`) }, icon(s.icon, { size: 16, class: cx(s.busy && 'is-spinning') }), h('span', { class: 'strong' }, s.label)),
    h('p', { class: 'sync-details-text' }, s.description),
    s.lastError && s.state !== 'idle' && s.state !== 'syncing'
      ? alertBox({ tone: s.state === 'offline' ? 'warning' : 'danger', title: s.lastError.message || 'Falha na sincronização', text: s.lastError.hint || null })
      : null,
    rows.length ? h('dl', { class: 'sync-details-list' }, rows.map(([label, value]) => h('div', { class: 'sync-details-row', key: label }, h('dt', null, label), h('dd', { class: 'tabular' }, value)))) : null,
    s.failures.length
      ? h(
          'div',
          { class: 'sync-failures' },
          h('div', { class: 'sync-failures-title' }, `${s.failures.length === 1 ? '1 registro recusado' : `${s.failures.length} registros recusados`} pelo servidor`),
          h(
            'ul',
            { class: 'sync-failures-list' },
            s.failures.slice(0, compact ? 4 : 20).map((f) =>
              h(
                'li',
                { key: `${f.table}:${f.id}` },
                h('span', { class: 'strong' }, SYNC_TABLE_LABELS[f.table] || f.table),
                h('span', { class: 'faint mono' }, ` ${String(f.id || '').slice(0, 8)}`),
                h('span', { class: 'sync-failure-msg' }, f.message || 'Recusado pelo servidor.'),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'sync-details-actions' },
      canSync
        ? button({
            label: s.failures.length ? 'Tentar de novo' : 'Sincronizar agora',
            icon: 'refresh',
            size: 'sm',
            variant: 'primary',
            disabled: s.busy,
            attrs: { 'data-action': 'sync-now' },
            onclick: () => app.sync.syncNow({ reason: 'manual' }),
          })
        : null,
      s.state === 'needs-login' ? button({ label: 'Entrar', icon: 'login', size: 'sm', variant: 'primary', onclick: () => openAccountDialog(app) }) : null,
      s.state === 'needs-reload'
        ? button({ label: 'Recarregar', icon: 'refresh', size: 'sm', variant: 'primary', attrs: { 'data-action': 'reload' }, onclick: () => reloadPage(app) })
        : null,
      onNavigate ? button({ label: 'Configurações', icon: 'settings', size: 'sm', onclick: onNavigate }) : null,
    ),
  );
}

function reloadPage(app) {
  if (app && app.env && typeof app.env.reload === 'function') app.env.reload();
  else if (typeof location !== 'undefined') location.reload();
}

function safeSession(app) {
  try {
    return app.remote.auth.session();
  } catch {
    return null;
  }
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error('[casca]', err);
    return fallback;
  }
}

function errorText(err) {
  return err && typeof err.message === 'string' && err.message ? err.message : String(err || 'Erro desconhecido.');
}

// ---------------------------------------------------------------------------
// startShell
// ---------------------------------------------------------------------------

/**
 * Monta a casca do aplicativo dentro de `root` e define `app.ui`.
 * @param {object} app objeto do app (createApp), já com o banco aberto
 * @param {Element} root contêiner (o conteúdo anterior, como a tela de abertura, é substituído)
 * @returns {object} app.ui
 */
export function startShell(app, root) {
  if (!app || !app.store) throw new TypeError('startShell: informe o app.');
  if (!root || typeof root.appendChild !== 'function') throw new TypeError('startShell: informe o contêiner.');
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  const prefs = app.prefs;

  const router = createRouter({ fallback: DEFAULT_PATH, win });
  const media = typeof win.matchMedia === 'function' ? win.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`) : null;
  const darkMedia = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;

  // ----- estado da casca --------------------------------------------------------------------------
  let mobile = !!(media && media.matches);
  let drawerOpen = false;
  let collapsed = prefs.get('shell.sidebarCollapsed', false) === true;
  let showArchivedProjects = prefs.get('shell.showArchivedProjects', false) === true;
  let hovered = null;
  let focused = null;
  let lastPath = null;
  let pushedPanelRoute = null;
  // closePanel() pode fechar com history.back(), que só chega depois (popstate assíncrono). Uma navegação pedida
  // nesse intervalo seria desfeita pelo "voltar" atrasado: ela espera numa fila e roda quando ele chegar.
  let pendingBack = null; // { timer, queue: Function[] }
  function afterPendingBack(fn) {
    if (!pendingBack) return fn();
    pendingBack.queue.push(fn);
    return true;
  }
  function settlePendingBack() {
    if (!pendingBack) return;
    const { timer, queue } = pendingBack;
    pendingBack = null;
    win.clearTimeout(timer);
    for (const fn of queue) safeCall(fn);
  }
  let syncPopover = null;
  const viewStates = new Map();
  let panelState = { key: null, state: {} };
  const cleanups = [];

  const savedScope = prefs.get('shell.scope', null);
  const scope0 = savedScope && typeof savedScope.projectId === 'string' && savedScope.projectId ? savedScope.projectId : null;

  // ----- rota -----------------------------------------------------------------------------------
  function currentPanel() {
    return parsePanelParam(router.current().params.panel);
  }

  function activeView() {
    return viewByPath(router.current().path) || viewById('dashboard') || views[0];
  }

  // ----- tema -----------------------------------------------------------------------------------
  function storedTheme() {
    const value = prefs.get('theme', 'system');
    return THEMES.has(value) ? value : 'system';
  }

  function effectiveTheme() {
    const t = storedTheme();
    if (t !== 'system') return t;
    return darkMedia && darkMedia.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const t = storedTheme();
    const html = doc.documentElement;
    if (t === 'light' || t === 'dark') html.setAttribute('data-theme', t);
    else html.removeAttribute('data-theme');
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
      if (t === 'system') {
        const media = meta.getAttribute('media') || '';
        meta.setAttribute('content', /dark/.test(media) ? THEME_COLORS.dark : THEME_COLORS.light);
      } else {
        meta.setAttribute('content', THEME_COLORS[t]);
      }
    }
  }

  // ----- estado das telas -----------------------------------------------------------------------
  function viewState(id) {
    if (!viewStates.has(id)) {
      const saved = prefs.get(`view.${id}`, null);
      viewStates.set(id, Object.freeze(saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {}));
    }
    return viewStates.get(id);
  }

  function setViewState(id, patch) {
    const prev = viewState(id);
    const change = typeof patch === 'function' ? patch(prev) : patch;
    if (!change || typeof change !== 'object') return;
    const next = Object.freeze({ ...prev, ...change });
    viewStates.set(id, next);
    prefs.set(`view.${id}`, next);
    schedule({ shell: true, view: true });
  }

  function viewCtx(view) {
    const route = router.current();
    return {
      state: viewState(view.id),
      setState: (patch) => setViewState(view.id, patch),
      params: Object.freeze({ ...route.params }),
      isMobile: mobile,
    };
  }

  // ----- seleção para atalhos -------------------------------------------------------------------
  function entityExists(ref) {
    if (!ref) return false;
    return !!(ref.type === 'task' ? app.sel.task(ref.id) : app.sel.demand(ref.id));
  }

  /** O foco do teclado está dentro do painel lateral? */
  function focusInPanel() {
    const active = doc.activeElement;
    const panelEl = root.querySelector('.shell-panel');
    return !!(active && panelEl && panelEl.contains(active));
  }

  /**
   * Entidade alvo dos atalhos de item. Ordem: a linha com o foco do teclado (na lista ao lado do painel ou
   * dentro dele — tarefas da demanda, subtarefas) → o painel, quando o foco está nele fora de uma linha → a
   * linha sob o mouse → o painel aberto.
   */
  function current() {
    const panel = currentPanel();
    const panelRef = panel && entityExists(panel) ? { type: panel.type, id: panel.id } : null;
    if (focused && focused.el.isConnected && entityExists(focused)) return { type: focused.type, id: focused.id };
    if (panelRef && focusInPanel()) return panelRef;
    if (hovered && hovered.el.isConnected && entityExists(hovered)) return { type: hovered.type, id: hovered.id };
    return panelRef;
  }

  function anchorFor(ref) {
    if (!ref) return null;
    for (const candidate of [focused, hovered]) {
      if (candidate && candidate.type === ref.type && candidate.id === ref.id && candidate.el.isConnected) return candidate.el;
    }
    const selector = `[data-entity="${ref.type}:${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ref.id) : ref.id}"]`;
    const inView = root.querySelector(`.shell-content ${selector}`) || root.querySelector(selector);
    if (inView) return inView;
    const panel = currentPanel();
    if (panel && panel.type === ref.type && panel.id === ref.id) return root.querySelector('.shell-panel-body') || null;
    return null;
  }

  function entityFromEvent(ev) {
    const target = ev.target && typeof ev.target.closest === 'function' ? ev.target : null;
    const el = target ? target.closest('[data-entity]') : null;
    if (!el || !root.contains(el)) return null;
    const ref = parseEntityRef(el.getAttribute('data-entity'));
    return ref ? { ...ref, el } : null;
  }

  // ----- escopo (filtro global de projeto) --------------------------------------------------------
  function validScopeId(projectId) {
    if (typeof projectId !== 'string' || !projectId) return null;
    const project = app.sel.project(projectId);
    return project && !project.archived_at ? projectId : null;
  }

  // ----- ações da casca ---------------------------------------------------------------------------
  function createDefaults(type) {
    const defaults = {};
    const panel = currentPanel();
    if (type === 'task' && panel) {
      if (panel.type === 'demand' && app.sel.demand(panel.id)) defaults.demand_id = panel.id;
      else if (panel.type === 'task') {
        const task = app.sel.task(panel.id);
        if (task && task.demand_id && app.sel.demand(task.demand_id)) defaults.demand_id = task.demand_id;
      }
    }
    if (type === 'demand' && ui.scope.projectId) defaults.project_id = ui.scope.projectId;
    return defaults;
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    schedule();
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    prefs.set('shell.sidebarCollapsed', collapsed);
    schedule();
  }

  function openThemeMenu(anchor) {
    const t = storedTheme();
    openMenu(
      anchor,
      [
        { label: 'Claro', icon: 'sun', checked: t === 'light', onclick: () => ui.setTheme('light') },
        { label: 'Escuro', icon: 'moon', checked: t === 'dark', onclick: () => ui.setTheme('dark') },
        { label: 'Sistema', icon: 'circle-half', checked: t === 'system', onclick: () => ui.setTheme('system') },
      ],
      { title: 'Tema', align: 'end', class: 'shell-theme-menu' },
    );
  }

  function openNewMenu(anchor) {
    openMenu(
      anchor,
      [
        { label: 'Tarefa', icon: 'circle', kbd: 'N', onclick: () => ui.quickCreate('task') },
        { label: 'Demanda', icon: 'layers', kbd: 'Shift+N', onclick: () => ui.quickCreate('demand') },
        { label: 'Demanda a partir de modelo…', icon: 'copy', onclick: () => openTemplateDialog(app) },
        { separator: true },
        { label: 'Projeto', icon: 'folder', onclick: () => ui.createProject() },
      ],
      { align: 'end', class: 'shell-new-menu' },
    );
  }

  function openSync(anchor) {
    if (syncPopover && syncPopover.isOpen()) {
      syncPopover.close();
      return syncPopover;
    }
    syncPopover = openPopover(
      anchor,
      (close) =>
        syncDetails(app, {
          compact: true,
          onNavigate: () => {
            close('navigate');
            ui.navigate('/config');
          },
        }),
      { placement: mobile ? 'bottom-start' : 'top-start', width: 320, class: 'sync-popover', ariaLabel: 'Sincronização', onclose: () => (syncPopover = null) },
    );
    return syncPopover;
  }

  function openProjectsMenu(anchor) {
    openMenu(
      anchor,
      [
        { label: 'Novo projeto', icon: 'plus', onclick: () => ui.createProject() },
        { separator: true },
        {
          label: 'Mostrar arquivados',
          checked: showArchivedProjects,
          onclick: () => {
            showArchivedProjects = !showArchivedProjects;
            prefs.set('shell.showArchivedProjects', showArchivedProjects);
            schedule();
          },
        },
      ],
      { title: 'Projetos' },
    );
  }

  // ----- cronômetro ativo -----------------------------------------------------------------------
  function activeTimerInfo() {
    const list = safeCall(() => app.sel.activeTimers(), []) || [];
    const timers = list.filter((entry) => entry && app.sel.task(entry.task_id));
    if (!timers.length) return null;
    const running = timers.filter((entry) => timerState(entry) === TIMER.RUNNING);
    const primary = running.length ? running[running.length - 1] : timers[timers.length - 1];
    const nowMs = app.clock.now().getTime();
    const long = running.some((entry) => isLongRunning(entry, nowMs));
    return { primary, timers, running, warn: running.length > 1 || long, long, task: app.sel.task(primary.task_id) };
  }

  function timerText(entry) {
    return formatDuration(elapsedSeconds(entry, app.clock.now().getTime()), { style: 'clock' });
  }

  function pauseOrResume(entry) {
    try {
      if (timerState(entry) === TIMER.RUNNING) app.cmd.pauseTimer(entry.id);
      else app.cmd.resumeTimer(entry.id, { others: 'ask' });
    } catch (err) {
      if (err && (err.code === 'timer_running' || err.code === 'timer_active')) {
        try {
          app.cmd.resumeTimer(entry.id, { others: 'pause' });
          toast('O outro cronômetro foi pausado.', { tone: 'default' });
        } catch (inner) {
          toast(errorText(inner), { tone: 'danger' });
        }
      } else {
        toast(errorText(err), { tone: 'danger' });
      }
    }
  }

  function openStopTimer(entry, anchor) {
    let description = '';
    openPopover(
      anchor,
      (close) => {
        const stop = () => {
          try {
            const done = app.cmd.stopTimer(entry.id, { description: description.trim() || null });
            close('stopped');
            toast(`Tempo registrado: ${formatDuration(done && done.duration_seconds)}`, { tone: 'success' });
          } catch (err) {
            toast(errorText(err), { tone: 'danger' });
          }
        };
        return h(
          'div',
          { class: 'timer-stop', 'data-timer-stop': 'true' },
          h('div', { class: 'timer-stop-title' }, 'Encerrar o cronômetro'),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'O que foi feito? (opcional)'), textArea({ value: description, rows: 3, autofocus: true, placeholder: 'Descreva o trabalho realizado', oninput: (text) => (description = text), onsubmit: stop })),
          h('div', { class: 'row row-end gap-2' }, button({ label: 'Cancelar', size: 'sm', onclick: () => close('cancel') }), button({ label: 'Encerrar', icon: 'stop', size: 'sm', variant: 'primary', attrs: { 'data-action': 'stop-timer' }, onclick: stop })),
        );
      },
      { placement: 'bottom-end', width: 300, ariaLabel: 'Encerrar o cronômetro' },
    );
  }

  function renderTimerChip() {
    const info = activeTimerInfo();
    if (!info) return null;
    const { primary, task, timers, warn, long } = info;
    const running = timerState(primary) === TIMER.RUNNING;
    const extra = timers.length - 1;
    const title = [
      `Cronômetro ${running ? 'rodando' : 'pausado'}: ${task.name || 'tarefa'}`,
      info.running.length > 1 ? `Atenção: ${info.running.length} cronômetros rodando ao mesmo tempo.` : null,
      long ? 'Atenção: um cronômetro está ligado há mais de 10 horas.' : null,
    ]
      .filter(Boolean)
      .join('\n');
    return h(
      'div',
      { class: cx('shell-timer', !running && 'is-paused', warn && 'is-warning'), 'data-timer-chip': primary.id, title },
      h(
        'button',
        { type: 'button', class: 'shell-timer-main', 'aria-label': `Abrir a tarefa ${task.name || ''}`, onclick: () => ui.openPanel('task', task.id) },
        h('span', { class: 'shell-timer-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'shell-timer-name truncate' }, task.name || 'Tarefa sem nome'),
        h('span', { class: 'shell-timer-elapsed tabular', 'data-timer-elapsed': primary.id }, timerText(primary)),
        extra > 0 ? h('span', { class: 'shell-timer-more tabular' }, `+${extra}`) : null,
      ),
      iconButton({ icon: running ? 'pause' : 'play', title: running ? 'Pausar cronômetro' : 'Retomar cronômetro', size: 'sm', onclick: () => pauseOrResume(primary), attrs: { 'data-action': running ? 'pause-timer' : 'resume-timer' } }),
      iconButton({ icon: 'stop', title: 'Encerrar cronômetro', size: 'sm', onclick: (ev) => openStopTimer(primary, ev.currentTarget), attrs: { 'data-action': 'open-stop-timer' } }),
    );
  }

  function tickTimers() {
    for (const el of root.querySelectorAll('[data-timer-elapsed]')) {
      const entry = app.store.get('time_entries', el.getAttribute('data-timer-elapsed'));
      if (!entry) continue;
      const text = timerText(entry);
      if (el.textContent !== text) el.textContent = text;
    }
  }

  // ----- renderização ---------------------------------------------------------------------------
  function navItem(view, active) {
    const badge = view.badge ? safeCall(() => view.badge(app), null) : null;
    const keys = NAV_SHORTCUTS[view.id];
    return h(
      'a',
      {
        key: view.id,
        href: `#${view.path}`,
        class: cx('shell-nav-item', active && 'is-active'),
        'data-nav': view.id,
        'aria-current': active ? 'page' : null,
        title: collapsed && !mobile ? view.title : keys ? `${view.title} (${keys.toUpperCase().replace(' ', ' então ')})` : view.title,
        onclick: (ev) => {
          if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          ui.navigate(view.path);
          closeDrawer();
        },
      },
      h('span', { class: 'shell-nav-icon' }, icon(view.icon || 'file-text', { size: 16 })),
      h('span', { class: 'shell-nav-label truncate' }, view.title),
      Number.isFinite(badge) && badge > 0 ? countBadge(badge, { max: 99, class: 'shell-nav-badge' }) : null,
    );
  }

  function renderNav(active) {
    return h(
      'nav',
      { class: 'shell-nav', 'aria-label': 'Navegação principal' },
      VIEW_SECTIONS.filter((section) => section.id !== 'system').map((section) => {
        const list = views.filter((view) => view.section === section.id);
        if (!list.length) return null;
        return h(
          'div',
          { class: 'shell-nav-section', key: section.id },
          section.label ? h('div', { class: 'shell-section-label' }, section.label) : null,
          list.map((view) => navItem(view, view === active)),
        );
      }),
    );
  }

  function renderProjects() {
    const list = safeCall(() => app.sel.projects({ includeArchived: showArchivedProjects }), []) || [];
    const scopeId = ui.scope.projectId;
    return h(
      'section',
      { class: 'shell-projects', 'aria-label': 'Projetos' },
      h(
        'div',
        { class: 'shell-projects-head' },
        h('span', { class: 'shell-section-label' }, 'Projetos'),
        h(
          'span',
          { class: 'shell-projects-actions' },
          iconButton({ icon: 'more-horizontal', title: 'Opções dos projetos', size: 'sm', onclick: (ev) => openProjectsMenu(ev.currentTarget) }),
          iconButton({ icon: 'plus', title: 'Novo projeto', size: 'sm', onclick: () => ui.createProject(), attrs: { 'data-action': 'new-project' } }),
        ),
      ),
      list.length === 0
        ? h('button', { type: 'button', class: 'shell-projects-empty', onclick: () => ui.createProject() }, icon('plus', { size: 14 }), h('span', null, 'Criar o primeiro projeto'))
        : h(
            'div',
            { class: 'shell-project-list' },
            list.map((project) => {
              const active = scopeId === project.id;
              const open = safeCall(() => app.sel.demands({ projectId: project.id }).filter((d) => app.sel.isOpen(d)).length, 0);
              return h(
                'div',
                { key: project.id, class: cx('shell-project', active && 'is-active', project.archived_at && 'is-archived'), 'data-project': project.id },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'shell-project-btn',
                    'aria-pressed': active,
                    title: project.archived_at ? `${project.name} (arquivado)` : active ? `Mostrar todos os projetos` : `Filtrar por ${project.name}`,
                    onclick: (ev) => {
                      if (project.archived_at) {
                        openProjectMenu(app, project.id, ev.currentTarget);
                        return;
                      }
                      ui.setScope({ projectId: active ? null : project.id });
                      closeDrawer();
                    },
                    oncontextmenu: (ev) => {
                      ev.preventDefault();
                      openProjectMenu(app, project.id, { x: ev.clientX, y: ev.clientY });
                    },
                  },
                  projectDot(project),
                  h('span', { class: 'shell-project-name truncate' }, project.name || 'Sem nome'),
                  open > 0 ? h('span', { class: 'shell-project-count tabular' }, String(open)) : null,
                ),
                iconButton({ icon: 'more-horizontal', title: `Opções de ${project.name || 'projeto'}`, size: 'sm', class: 'shell-project-menu', onclick: (ev) => openProjectMenu(app, project.id, ev.currentTarget) }),
              );
            }),
          ),
    );
  }

  function renderSyncIndicator() {
    const s = syncSummary(app);
    return h(
      'button',
      {
        type: 'button',
        class: cx('shell-sync', `tone-${s.tone}`),
        'data-sync-indicator': s.state,
        title: `${s.label}. Clique para ver os detalhes.`,
        'aria-label': `Sincronização: ${s.label}`,
        onclick: (ev) => openSync(ev.currentTarget),
      },
      icon(s.icon, { size: 14, class: cx('shell-sync-icon', s.busy && 'is-spinning') }),
      h('span', { class: 'shell-sync-label truncate' }, s.label),
    );
  }

  function renderSidebar(active) {
    const account = accountSummary(app);
    const config = viewById('config');
    return h(
      'aside',
      { class: 'shell-sidebar', 'aria-label': 'Barra lateral', id: 'shell-sidebar' },
      h(
        'div',
        { class: 'shell-brand' },
        h('img', { class: 'shell-logo', src: 'assets/icon.svg', width: 22, height: 22, alt: '' }),
        h('span', { class: 'shell-brand-name truncate' }, 'Demand Manager', app.env && app.env.version ? h('span', { class: 'shell-brand-version', 'data-app-version': app.env.version }, ` ${app.env.version}`) : null),
        mobile
          ? iconButton({ icon: 'x', title: 'Fechar menu', size: 'sm', class: 'shell-brand-toggle', onclick: closeDrawer })
          : iconButton({ icon: collapsed ? 'chevron-right' : 'chevron-left', title: collapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral', size: 'sm', class: 'shell-brand-toggle', onclick: toggleCollapsed, attrs: { 'data-action': 'toggle-sidebar' } }),
      ),
      h('div', { class: 'shell-sidebar-scroll' }, renderNav(active), renderProjects()),
      h(
        'div',
        { class: 'shell-sidebar-foot' },
        renderSyncIndicator(),
        config ? navItem(config, active === config) : null,
        h(
          'button',
          { type: 'button', class: 'shell-account', 'data-account': account.signedIn ? 'signed-in' : 'local', title: account.detail, onclick: () => openAccountDialog(app) },
          account.signedIn ? avatar(account.label, { size: 22 }) : h('span', { class: 'shell-account-icon' }, icon(account.configured ? 'login' : 'user', { size: 14 })),
          h('span', { class: 'shell-account-text' }, h('span', { class: 'shell-account-label truncate' }, account.label), h('span', { class: 'shell-account-detail truncate' }, account.detail)),
        ),
      ),
    );
  }

  function renderTopbar(view) {
    const project = ui.scope.projectId ? app.sel.project(ui.scope.projectId) : null;
    const theme = effectiveTheme();
    return h(
      'header',
      { class: 'shell-topbar' },
      mobile ? iconButton({ icon: 'menu', title: 'Abrir menu', class: 'shell-menu-btn', onclick: () => { drawerOpen = true; schedule(); }, attrs: { 'data-action': 'open-drawer', 'aria-expanded': drawerOpen, 'aria-controls': 'shell-sidebar' } }) : null,
      h('h1', { class: 'shell-title truncate', 'data-view-title': view.id }, view.title),
      project
        ? h(
            'span',
            { class: 'shell-scope', 'data-scope': project.id, title: `Mostrando só o projeto ${project.name}` },
            projectDot(project),
            h('span', { class: 'shell-scope-name truncate' }, project.name),
            h('button', { type: 'button', class: 'shell-scope-clear', title: 'Mostrar todos os projetos', 'aria-label': 'Mostrar todos os projetos', onclick: () => ui.setScope({ projectId: null }) }, icon('x', { size: 12 })),
          )
        : null,
      h('span', { class: 'shell-topbar-spacer' }),
      mobile
        ? iconButton({ icon: 'search', title: 'Buscar (Ctrl+K)', onclick: () => ui.openPalette(), attrs: { 'data-action': 'open-palette' } })
        : h(
            'button',
            { type: 'button', class: 'shell-search', 'data-action': 'open-palette', 'aria-label': 'Buscar tarefas, demandas ou comandos', onclick: () => ui.openPalette() },
            icon('search', { size: 14 }),
            h('span', { class: 'shell-search-text' }, 'Buscar…'),
            h('span', { class: 'kbd-group' }, h('kbd', { class: 'kbd' }, navigatorIsMac() ? '⌘' : 'Ctrl'), h('kbd', { class: 'kbd' }, 'K')),
          ),
      renderTimerChip(),
      alertsButton(app),
      mobile
        ? iconButton({ icon: 'plus', title: 'Nova…', variant: 'primary', onclick: (ev) => openNewMenu(ev.currentTarget), attrs: { 'data-action': 'new' } })
        : button({ label: 'Nova', icon: 'plus', iconRight: 'chevron-down', variant: 'primary', size: 'sm', class: 'shell-new', onclick: (ev) => openNewMenu(ev.currentTarget), attrs: { 'data-action': 'new' } }),
      mobile ? null : iconButton({ icon: theme === 'dark' ? 'moon' : 'sun', title: 'Tema', onclick: (ev) => openThemeMenu(ev.currentTarget), attrs: { 'data-action': 'theme' } }),
    );
  }

  function renderViewBody(view) {
    try {
      return view.render(app, viewCtx(view));
    } catch (err) {
      console.error(`[casca] erro ao desenhar a tela "${view.id}"`, err);
      return h(
        'div',
        { class: 'shell-view-error', 'data-view-error': view.id },
        alertBox({
          tone: 'danger',
          title: `Não foi possível mostrar “${view.title}”`,
          text: `${errorText(err)} — os seus dados não foram afetados.`,
          actions: [
            button({ label: 'Tentar de novo', size: 'sm', icon: 'refresh', onclick: () => schedule() }),
            view.id !== 'dashboard' ? button({ label: 'Ir para o Início', size: 'sm', onclick: () => ui.navigate(DEFAULT_PATH) }) : null,
          ],
        }),
      );
    }
  }

  function renderPanel() {
    const ref = currentPanel();
    if (!ref || !PANEL_TYPES.has(ref.type)) return null;
    const def = panels && panels[ref.type];
    const key = `${ref.type}:${ref.id}`;
    if (panelState.key !== key) panelState = { key, state: {} };
    const ctx = {
      state: panelState.state,
      setState(patch) {
        const change = typeof patch === 'function' ? patch(panelState.state) : patch;
        if (!change || typeof change !== 'object' || panelState.key !== key) return;
        panelState = { key, state: { ...panelState.state, ...change } };
        schedule({ panel: true });
      },
      close: () => ui.closePanel(),
    };
    let body;
    let title = ref.type === 'task' ? 'Tarefa' : 'Demanda';
    if (!def || typeof def.render !== 'function') {
      body = alertBox({ tone: 'danger', title: 'Painel indisponível', text: 'O módulo do painel lateral não foi carregado.' });
    } else {
      try {
        if (typeof def.title === 'function') {
          const t = def.title(app, ref.id);
          if (typeof t === 'string' && t.trim()) title = t;
        }
        body = def.render(app, ref.id, ctx);
      } catch (err) {
        console.error('[casca] erro ao desenhar o painel', err);
        body = h(
          'div',
          { class: 'shell-panel-error', 'data-panel-error': 'true' },
          alertBox({ tone: 'danger', title: 'Não foi possível mostrar o painel', text: errorText(err), actions: button({ label: 'Fechar', size: 'sm', onclick: () => ui.closePanel() }) }),
        );
      }
    }
    return h(
      'aside',
      { class: 'shell-panel', key: 'panel', 'data-panel': key, role: 'complementary', 'aria-label': title },
      mobile
        ? h(
            'div',
            { class: 'shell-panel-bar' },
            button({ label: 'Voltar', icon: 'arrow-left', variant: 'ghost', size: 'sm', class: 'shell-panel-back', onclick: () => ui.closePanel(), attrs: { 'data-action': 'close-panel' } }),
            h('span', { class: 'shell-panel-title truncate' }, title),
          )
        : null,
      h('div', { class: 'shell-panel-body', key: `body:${key}` }, body || null),
    );
  }

  function renderTabbar(active) {
    const tabs = TAB_BAR_VIEWS.map((id) => viewById(id)).filter(Boolean);
    const inTabs = tabs.includes(active);
    return h(
      'nav',
      { class: 'shell-tabbar', 'aria-label': 'Navegação rápida' },
      tabs.map((view) =>
        h(
          'a',
          {
            key: view.id,
            href: `#${view.path}`,
            class: cx('shell-tab', view === active && 'is-active'),
            'data-tab': view.id,
            'aria-current': view === active ? 'page' : null,
            onclick: (ev) => {
              ev.preventDefault();
              ui.navigate(view.path);
            },
          },
          icon(view.icon, { size: 20 }),
          h('span', { class: 'shell-tab-label' }, TAB_LABELS[view.id] || view.title),
        ),
      ),
      h(
        'button',
        { type: 'button', class: cx('shell-tab', !inTabs && 'is-active'), 'data-tab': 'more', 'aria-label': 'Mais opções', 'aria-expanded': drawerOpen, onclick: () => { drawerOpen = true; schedule(); } },
        icon('more-horizontal', { size: 20 }),
        h('span', { class: 'shell-tab-label' }, 'Mais…'),
      ),
    );
  }

  function render() {
    const view = activeView();
    const panel = currentPanel();
    const hasPanel = !!(panel && PANEL_TYPES.has(panel.type));
    // Escopo apontando para projeto que sumiu (excluído/arquivado em outro aparelho): volta a "todos".
    if (ui.scope.projectId && !validScopeId(ui.scope.projectId)) {
      ui.scope = Object.freeze({ projectId: null });
      prefs.set('shell.scope', { projectId: null });
    }
    return h(
      'div',
      {
        class: cx('shell', mobile ? 'is-mobile' : 'is-desktop', !mobile && collapsed && 'is-collapsed', hasPanel && 'has-panel', mobile && drawerOpen && 'drawer-open'),
        'data-shell': 'true',
        'data-route': view.id,
      },
      renderSidebar(view),
      mobile ? h('div', { class: 'shell-backdrop', 'aria-hidden': 'true', onclick: closeDrawer }) : null,
      h(
        'div',
        { class: 'shell-main' },
        renderTopbar(view),
        // Hospedeiro da tela: o morph da casca não entra nos filhos (são do mount da tela).
        h('main', { class: 'shell-content', id: 'shell-content', tabindex: -1, 'aria-label': view.title, 'data-morph': 'skip', ref: (el) => { viewHost = el; } }),
      ),
      // Hospedeiro do painel (display: contents): o <aside> é desenhado pelo mount do painel.
      h('div', { class: 'shell-panel-host', key: 'panel-host', 'data-morph': 'skip', ref: (el) => { panelHost = el; } }),
      mobile ? renderTabbar(view) : null,
    );
  }

  /** Região da tela (mount próprio dentro de <main>). */
  function renderViewRegion() {
    const view = activeView();
    return h('div', { class: cx('shell-view', `shell-view-${view.id}`), key: `view:${view.id}`, 'data-view': view.id }, renderViewBody(view));
  }

  /** Região do painel (mount próprio dentro de .shell-panel-host). */
  function renderPanelRegion() {
    const panel = currentPanel();
    return panel && PANEL_TYPES.has(panel.type) ? renderPanel() : null;
  }

  // ----- agendador por região ---------------------------------------------------------------------
  const shellMount = mount(root, render);
  let viewHost = null;
  let panelHost = null;
  let viewMount = null;
  let viewMountHost = null;
  let panelMount = null;
  let panelMountHost = null;
  let viewRendering = false;
  let viewReadPanel = false;
  let destroyed = false;
  const renders = { shell: 0, view: 0, panel: 0 };
  /** Duração (ms) do último desenho de cada região (testes de volume/diagnóstico). */
  const renderMs = { shell: 0, view: 0, panel: 0 };
  const clockMs = () => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now());
  const dirty = { shell: false, view: false, panel: false };
  const ALL = { shell: true, view: true, panel: true };
  let frame = 0;
  let fallback = 0;
  let flushing = false;

  /**
   * Pede um novo desenho no próximo quadro (vários pedidos = um desenho). Sem argumento: tudo.
   * @param {{ shell?: boolean, view?: boolean, panel?: boolean }} [parts]
   */
  function schedule(parts = ALL) {
    if (destroyed) return;
    if (parts.shell) dirty.shell = true;
    if (parts.view) dirty.view = true;
    if (parts.panel) dirty.panel = true;
    if (flushing || frame !== 0) return; // durante o desenho: o fim do flush agenda outro quadro
    frame = win.requestAnimationFrame(flush);
    fallback = win.setTimeout(flush, 100); // quadros suspensos (aba oculta)
  }

  /** Mudança só no painel (abrir/fechar/trocar): a tela redesenha apenas se leu o painel. */
  function schedulePanelChange() {
    schedule({ shell: true, panel: true, view: viewReadPanel });
  }

  function flush() {
    if (frame !== 0) win.cancelAnimationFrame(frame);
    if (fallback !== 0) win.clearTimeout(fallback);
    frame = 0;
    fallback = 0;
    if (destroyed) return;
    const todo = { ...dirty };
    dirty.shell = dirty.view = dirty.panel = false;
    flushing = true;
    try {
      if (todo.shell) {
        renders.shell += 1;
        const t0 = clockMs();
        shellMount.update();
        renderMs.shell = clockMs() - t0;
      }
      if (viewHost !== viewMountHost) {
        if (viewMount) viewMount.destroy();
        viewMount = viewHost ? mount(viewHost, renderViewRegion) : null;
        viewMountHost = viewHost;
        todo.view = true;
      }
      if (panelHost !== panelMountHost) {
        if (panelMount) panelMount.destroy();
        panelMount = panelHost ? mount(panelHost, renderPanelRegion) : null;
        panelMountHost = panelHost;
        todo.panel = true;
      }
      if (todo.view && viewMount) {
        renders.view += 1;
        viewRendering = true;
        viewReadPanel = false;
        const t0 = clockMs();
        try {
          viewReadClock = probeClock(() => viewMount.update());
        } finally {
          viewRendering = false;
          renderMs.view = clockMs() - t0;
        }
      }
      if (todo.panel && panelMount) {
        renders.panel += 1;
        const t0 = clockMs();
        panelReadClock = probeClock(() => panelMount.update());
        renderMs.panel = clockMs() - t0;
      }
    } finally {
      flushing = false;
    }
    if (dirty.shell || dirty.view || dirty.panel) schedule({});
    afterRender();
  }

  // ----- leitura do relógio durante o desenho ------------------------------------------------------
  // O tique de 1 min só redesenha tela/painel quando o tempo os afeta. Além de cronômetro e virada do dia,
  // conta quem LEU a hora (app.clock.now/nowIso/nowMs) no último desenho: textos "há N min", a linha do
  // "agora" no calendário, a saudação por hora... `today()`/`peek()` (dia, chaves de cache) não contam.
  let clockProbe = null;
  let viewReadClock = false;
  let panelReadClock = false;
  const clockObj = app.clock;
  const clockOrig = clockObj && typeof clockObj.now === 'function' && !Object.isFrozen(clockObj) ? { now: clockObj.now } : null;
  if (clockOrig) {
    clockObj.now = () => {
      if (clockProbe) clockProbe.read = true;
      return clockOrig.now();
    };
  }

  /** Executa `fn` registrando se ele leu a hora; devolve true se leu. */
  function probeClock(fn) {
    const probe = { read: false };
    const prev = clockProbe;
    clockProbe = probe;
    try {
      fn();
    } finally {
      clockProbe = prev;
    }
    return probe.read;
  }

  function hasRunningTimer() {
    const list = safeCall(() => app.sel.activeTimers(), []) || [];
    return list.some((entry) => entry && timerState(entry) === TIMER.RUNNING);
  }

  function dayKey() {
    const d = app.clock.now();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function afterRender() {
    const path = router.current().path;
    if (path !== lastPath) {
      lastPath = path;
      const content = root.querySelector('.shell-content');
      if (content) content.scrollTop = 0;
    }
    if (syncPopover && syncPopover.isOpen()) syncPopover.update();
  }

  function enterView(next, prev) {
    if (prev && prev !== next && prev.onLeave) safeCall(() => prev.onLeave(app));
    if (next && next.onEnter && prev !== next) safeCall(() => next.onEnter(app, viewCtx(next)));
  }

  // ----- app.ui -----------------------------------------------------------------------------------
  const ui = {
    scope: Object.freeze({ projectId: null }),

    /**
     * Vai para uma tela. Aceita '/kanban', 'kanban', '#/kanban' ou '/demandas?q=abc'. Caminho desconhecido → Início.
     * O painel aberto fecha, a menos que `params.panel` seja informado.
     * @param {string} path
     * @param {Record<string, any>} [params]
     * @returns {boolean} true quando a rota mudou
     */
    navigate(path, params) {
      let target = typeof path === 'string' ? path.trim() : '';
      if (target.startsWith('#')) target = target.slice(1);
      let extra = {};
      if (target.includes('?')) {
        const parsed = parseHash(`#${target.startsWith('/') ? target : `/${target}`}`);
        target = parsed.path;
        extra = parsed.params;
      }
      if (target && target[0] !== '/') target = `/${target}`;
      if (!target || !viewByPath(target)) target = DEFAULT_PATH;
      closeDrawer();
      const merged = { ...extra, ...(params && typeof params === 'object' ? params : {}) };
      return afterPendingBack(() => router.navigate(target, { params: merged }));
    },

    /** @returns {{ path: string, params: Record<string, string> }} rota atual (cópia) */
    route() {
      const r = router.current();
      return { path: r.path, params: { ...r.params } };
    },

    /**
     * Abre o painel lateral de uma tarefa ou demanda (fica na URL: panel=task:<id>).
     *
     *   app.ui.openPanel('task', id, { tab: 'time' })      // direto na aba Tempo
     *
     * @param {'task'|'demand'} type
     * @param {string} id
     * @param {{ replace?: boolean, tab?: string, state?: object }} [opts] replace: troca a entrada do histórico em
     *        vez de criar outra; tab: aba inicial do painel ('details' | 'time' | 'tasks' | 'history'); state:
     *        outros campos do estado inicial do painel
     * @returns {boolean} true quando a rota mudou (ou quando só a aba do painel já aberto mudou)
     */
    openPanel(type, id, opts = {}) {
      if (!PANEL_TYPES.has(type) || typeof id !== 'string' || !id) return false;
      if (pendingBack) return afterPendingBack(() => ui.openPanel(type, id, opts));
      const options = opts && typeof opts === 'object' ? opts : {};
      const initial = {
        ...(options.state && typeof options.state === 'object' ? options.state : {}),
        ...(typeof options.tab === 'string' && options.tab ? { tab: options.tab } : {}),
      };
      const key = `${type}:${id}`;
      if (Object.keys(initial).length) {
        // Estado inicial do painel: vale para o painel que vai abrir (ou o já aberto, que só troca de aba).
        panelState = { key, state: panelState.key === key ? { ...panelState.state, ...initial } : initial };
      }
      const before = currentPanel();
      const replace = typeof options.replace === 'boolean' ? options.replace : !!before;
      const changed = router.setParams({ panel: key }, { replace });
      if (!changed && Object.keys(initial).length) {
        schedule({ panel: true });
        closeDrawer();
        return true;
      }
      if (changed && !before && !replace) pushedPanelRoute = { path: router.current().path, panel: `${type}:${id}` };
      else if (changed && pushedPanelRoute) pushedPanelRoute = { ...pushedPanelRoute, panel: `${type}:${id}` };
      closeDrawer();
      return changed;
    },

    /** Fecha o painel lateral (volta no histórico quando foi a casca que o abriu; senão troca a URL). */
    closePanel() {
      const r = router.current();
      if (!r.params.panel) return false;
      const pushed = pushedPanelRoute;
      pushedPanelRoute = null;
      if (pushed && pushed.path === r.path && pushed.panel === r.params.panel && win.history.length > 1) {
        const before = win.location.href;
        settlePendingBack();
        win.history.back();
        // Se o histórico não voltou (entrada externa), garante o fechamento trocando a URL.
        pendingBack = {
          queue: [],
          timer: win.setTimeout(() => {
            if (win.location.href === before && router.current().params.panel) router.setParams({ panel: null }, { replace: true });
            settlePendingBack();
          }, 400),
        };
        return true;
      }
      return router.setParams({ panel: null }, { replace: true });
    },

    /** @returns {{ type: 'task'|'demand', id: string }|null} painel aberto */
    panel() {
      if (viewRendering) viewReadPanel = true; // a tela depende do painel: redesenha quando ele muda
      const p = currentPanel();
      return p ? { type: p.type, id: p.id } : null;
    },

    /**
     * Estado guardado de uma tela (o mesmo que ela recebe em ctx.state).
     * @param {string} viewId
     * @returns {object}
     */
    viewState(viewId) {
      return viewState(viewId);
    },

    /**
     * Altera o estado de uma tela — inclusive de OUTRA tela, antes de navegar para ela (ex.: o Início abre a
     * lista de Demandas já com um filtro). Mesmo caminho do ctx.setState: guarda por dispositivo e redesenha.
     *
     *   app.ui.setViewState('demandas', { mode: 'tasks' });
     *   app.ui.navigate('/demandas');
     *
     * @param {string} viewId
     * @param {object|((prev: object) => object)} patch
     */
    setViewState(viewId, patch) {
      if (typeof viewId !== 'string' || !viewId) return;
      setViewState(viewId, patch);
    },

    /** Contadores de desenho por região (testes/diagnóstico). */
    __renders: renders,

    /** Duração em ms do último desenho de cada região ({ shell, view, panel }; testes/diagnóstico). */
    __renderMs: renderMs,

    /** Pede um novo desenho (no próximo quadro). */
    rerender() {
      schedule();
    },

    /** Aviso rápido (kit/overlays.js toast). */
    toast(message, opts) {
      return toast(message, opts);
    },

    /**
     * Altera o filtro global de projeto. `{ projectId: null }` mostra todos.
     * @param {{ projectId?: string|null }} patch
     */
    setScope(patch) {
      const next = { ...ui.scope, ...(patch && typeof patch === 'object' ? patch : {}) };
      const projectId = validScopeId(next.projectId);
      if (projectId === ui.scope.projectId) return;
      ui.scope = Object.freeze({ projectId });
      prefs.set('shell.scope', { projectId });
      schedule();
    },

    /** @returns {{ type: 'task'|'demand', id: string }|null} entidade alvo dos atalhos (foco → painel com foco → mouse → painel) */
    current,

    /**
     * Abre a criação rápida. Sem `defaults`, usa o contexto (demanda do painel aberto, projeto filtrado).
     * @param {'task'|'demand'|'project'} type
     * @param {object} [defaults]
     * @returns {Promise<object|null>}
     */
    quickCreate(type = 'task', defaults) {
      const values = defaults && typeof defaults === 'object' ? defaults : createDefaults(type);
      return Promise.resolve()
        .then(() => openQuickCreate(app, type, values))
        .catch((err) => {
          console.error('[casca] falha na criação rápida', err);
          toast(errorText(err), { tone: 'danger' });
          return null;
        });
    },

    /** @returns {boolean} largura de celular (< 768 px) */
    isMobile: () => mobile,

    /** @returns {'light'|'dark'|'system'} tema escolhido */
    theme: () => storedTheme(),

    /**
     * Troca o tema (guardado neste dispositivo).
     * @param {'light'|'dark'|'system'} theme
     */
    setTheme(theme) {
      const value = THEMES.has(theme) ? theme : 'system';
      prefs.set('theme', value);
      applyTheme();
      schedule();
    },

    // ----- extras -----
    /** Lista de atalhos registrados (para a ajuda). */
    shortcuts: null,
    /** Abre a ajuda de atalhos. */
    showHelp: () => openShortcutHelp(shortcuts.list()),
    /** Abre a paleta de comandos. */
    openPalette: (query = '') => openPalette(app, { query }),
    /** Abre o "Resumo do dia". */
    showDigest: () => openDigestModal(app),
    /** 1º acesso do dia: abre o resumo se ligado, não vazio e ainda não mostrado hoje neste dispositivo. */
    checkDailyDigest: () => checkDailyDigest(app),
    /** Abre as "Novidades da versão". */
    showWhatsNew: () => openWhatsNew(app),
    /** Abertura: mostra as novidades uma vez por versão (se há dados e nenhum diálogo aberto). */
    checkWhatsNew: () => checkWhatsNew(app),
    /** Abre o diálogo de novo projeto. */
    createProject: () => openProjectDialog(app),
    /** Abre os detalhes da sincronização ancorados em `anchor`. */
    openSync,
    /** Abre/fecha a gaveta (celular). */
    setDrawer(open) {
      drawerOpen = !!open && mobile;
      schedule();
    },
    /** Desmonta a casca (testes). */
    destroy() {
      for (const fn of cleanups.splice(0)) safeCall(fn);
      destroyed = true;
      if (pendingBack) win.clearTimeout(pendingBack.timer);
      pendingBack = null;
      if (frame !== 0) win.cancelAnimationFrame(frame);
      if (fallback !== 0) win.clearTimeout(fallback);
      if (viewMount) viewMount.destroy();
      if (panelMount) panelMount.destroy();
      shellMount.destroy();
    },
  };
  ui.scope = Object.freeze({ projectId: validScopeId(scope0) });
  app.ui = ui;

  // ----- atalhos de teclado -------------------------------------------------------------------------
  const shortcuts = createShortcuts({ target: win, isBlocked: () => isOverlayOpen() });
  ui.shortcuts = { list: () => shortcuts.list(), handle: (ev) => shortcuts.handle(ev) };
  cleanups.push(() => shortcuts.destroy());

  const onEntity = (fn) => () => {
    const ref = current();
    if (!ref) return;
    const anchor = anchorFor(ref);
    fn(ref, anchor);
  };
  const callAction = (name, ...extra) =>
    onEntity((ref, anchor) => {
      const action = entityActions && entityActions[name];
      if (typeof action !== 'function') return;
      const args = extra.length ? [app, ref.type, ref.id, ...extra, anchor] : [app, ref.type, ref.id, anchor];
      Promise.resolve()
        .then(() => action(...args))
        .catch((err) => toast(errorText(err), { tone: 'danger' }));
    });
  const hasEntity = () => !!current();

  shortcuts.register({ keys: 'mod+k', label: 'Paleta de comandos e busca', group: 'Geral', allowInInput: true, run: () => ui.openPalette() });
  shortcuts.register({ keys: '/', label: 'Buscar', group: 'Geral', run: () => ui.openPalette() });
  shortcuts.register({ keys: '?', label: 'Ajuda de atalhos', group: 'Geral', run: () => ui.showHelp() });
  shortcuts.register({
    keys: 'escape',
    label: 'Fechar o painel',
    group: 'Geral',
    when: () => !!currentPanel() || drawerOpen,
    run: () => {
      if (drawerOpen) closeDrawer();
      else ui.closePanel();
    },
  });
  shortcuts.register({ keys: 'n', label: 'Nova tarefa', group: 'Criar', run: () => app.ui.quickCreate('task') });
  shortcuts.register({ keys: 'shift+n', label: 'Nova demanda', group: 'Criar', run: () => app.ui.quickCreate('demand') });
  for (const [id, keys] of Object.entries(NAV_SHORTCUTS)) {
    const target = viewById(id);
    if (target) shortcuts.register({ keys, label: `Ir para ${target.title}`, group: 'Navegação', run: () => ui.navigate(target.path) });
  }
  shortcuts.register({ keys: ['enter', 'e'], label: 'Abrir no painel', group: 'Item selecionado', when: hasEntity, run: onEntity((ref) => ui.openPanel(ref.type, ref.id)) });
  shortcuts.register({ keys: 'c', label: 'Concluir / reabrir', group: 'Item selecionado', when: hasEntity, run: callAction('complete') });
  for (const n of [1, 2, 3, 4]) {
    shortcuts.register({ keys: String(n), label: `Prioridade P${n}`, group: 'Item selecionado', when: hasEntity, run: callAction('setPriority', `P${n}`) });
  }
  shortcuts.register({ keys: 's', label: 'Alterar status', group: 'Item selecionado', when: hasEntity, run: callAction('pickStatus') });
  shortcuts.register({ keys: 'd', label: 'Alterar prazo', group: 'Item selecionado', when: hasEntity, run: callAction('pickDueDate') });
  shortcuts.register({ keys: 'o', label: 'Adicionar observação', group: 'Item selecionado', when: hasEntity, run: callAction('addNote') });
  shortcuts.register({ keys: 't', label: 'Iniciar / pausar cronômetro', group: 'Item selecionado', when: () => { const ref = current(); return !!ref && ref.type === 'task'; }, run: callAction('toggleTimer') });
  shortcuts.register({ keys: ['delete', 'mod+backspace'], label: 'Excluir', group: 'Item selecionado', when: hasEntity, run: callAction('remove') });

  // ----- eventos do DOM -----------------------------------------------------------------------------
  const listen = (target, type, fn, options) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };

  listen(root, 'pointerover', (ev) => {
    hovered = entityFromEvent(ev);
  });
  listen(root, 'pointerleave', () => {
    hovered = null;
  });
  listen(doc, 'focusin', (ev) => {
    focused = entityFromEvent(ev);
  });
  listen(doc, 'focusout', (ev) => {
    if (!ev.relatedTarget) focused = null;
  });
  listen(root, 'contextmenu', (ev) => {
    const ref = entityFromEvent(ev);
    if (!ref || !entityExists(ref)) return;
    ev.preventDefault();
    try {
      openEntityMenu(app, ref.type, ref.id, { x: ev.clientX, y: ev.clientY });
    } catch (err) {
      toast(errorText(err), { tone: 'danger' });
    }
  });
  listen(win, 'online', () => schedule());
  listen(win, 'offline', () => schedule());
  if (media) {
    listen(media, 'change', () => {
      mobile = media.matches;
      if (!mobile) drawerOpen = false;
      schedule();
    });
  }
  if (darkMedia) listen(darkMedia, 'change', () => schedule());

  // ----- assinaturas ---------------------------------------------------------------------------------
  cleanups.push(app.store.subscribe(() => schedule()));
  if (app.sync && typeof app.sync.subscribe === 'function') cleanups.push(app.sync.subscribe(() => schedule({ shell: true, view: activeView().sync === true })));
  if (app.remote && app.remote.auth && typeof app.remote.auth.onChange === 'function') {
    const bootUser = (safeSession(app) || { user: { id: null } }).user.id;
    const reload = () => (app.env && app.env.reload ? app.env.reload() : win.location.reload());
    // A mudança veio de OUTRA aba? (evento 'storage' na chave da sessão). Registrado ANTES do onChange: o cliente
    // do Supabase também escuta 'storage' e avisa os ouvintes; os ouvintes do mesmo alvo rodam na ordem de registro.
    let fromOtherTab = false;
    listen(win, 'storage', (ev) => {
      if (ev && (ev.key === null || (typeof ev.key === 'string' && ev.key.includes('dm.session.')))) fromOtherTab = true;
    });
    cleanups.push(
      app.remote.auth.onChange((session) => {
        const otherTab = fromOtherTab;
        fromOtherTab = false;
        const userId = session && session.user ? session.user.id : null;
        if (userId === bootUser) return;
        if (otherTab) {
          toast(userId ? 'Você entrou numa conta em outra aba.' : 'Você saiu da conta em outra aba.', {
            id: 'auth-changed',
            duration: 0,
            tone: 'warn',
            action: { label: 'Recarregar', onclick: reload },
          });
          return;
        }
        // Nesta aba: entrar/sair pelo diálogo recarrega a página sozinho. Sessão que some sem "Sair" (renovação
        // recusada pelo servidor, sessão encerrada) — pede para entrar de novo; nada se perde.
        // "Sair" esquece a última conta antes de apagar a sessão: aí não há o que avisar (a página recarrega).
        const signedOutOnPurpose = !!(app.env && 'lastAccount' in app.env && !app.env.lastAccount);
        if (!userId && !signedOutOnPurpose) {
          toast('Sua sessão expirou. Entre novamente para continuar sincronizando — as alterações ficam guardadas neste dispositivo.', {
            id: 'auth-changed',
            duration: 0,
            tone: 'warn',
            action: { label: 'Entrar', onclick: () => openAccountDialog(app) },
          });
        }
      }),
    );
  }

  // Falha ao gravar no IndexedDB: as alterações deixam de ser guardadas — aviso permanente, com saída.
  const showPersistError = () =>
    toast('As alterações não estão sendo salvas neste navegador. Exporte um backup em Configurações e recarregue a página.', {
      id: 'persist-error',
      duration: 0,
      tone: 'danger',
      action: { label: 'Recarregar', onclick: () => reloadPage(app) },
    });
  if (app.store && 'onPersistError' in app.store) {
    const prevHandler = app.store.onPersistError;
    app.store.onPersistError = (err) => {
      if (typeof prevHandler === 'function') prevHandler(err);
      showPersistError();
    };
    cleanups.push(() => {
      app.store.onPersistError = prevHandler || null;
    });
    if (app.store.persistError) showPersistError();
  }

  // Outra aba abriu o banco local numa versão nova (app atualizado): esta aba perdeu a conexão e não grava
  // mais. Não é falha do disco (o store não dispara onPersistError) — basta recarregar.
  const showVersionChange = (info) =>
    toast(info && info.newVersion == null
      ? 'Os dados locais foram apagados em outra aba. Recarregue para continuar.'
      : 'Uma versão nova do app foi aberta em outra aba. Esta aba não salva mais as alterações — recarregue.', {
      id: 'version-change',
      duration: 0,
      tone: 'warn',
      action: { label: 'Recarregar', onclick: () => reloadPage(app) },
    });
  if (app.store && 'onVersionChange' in app.store) {
    const prevVersionHandler = app.store.onVersionChange;
    app.store.onVersionChange = (info) => {
      if (typeof prevVersionHandler === 'function') prevVersionHandler(info);
      showVersionChange(info);
    };
    cleanups.push(() => {
      app.store.onVersionChange = prevVersionHandler || null;
    });
    if (app.store.versionChanged) showVersionChange({ newVersion: -1 });
  }

  let lastDay = dayKey();
  function minuteTick() {
    // A tela e o painel só redesenham se o tempo os afeta: cronômetro rodando, virada do dia ou hora lida no
    // último desenho (textos relativos "há N min", linha do agora…).
    const day = dayKey();
    const timeMatters = hasRunningTimer() || day !== lastDay;
    lastDay = day;
    schedule({ shell: true, view: timeMatters || viewReadClock, panel: timeMatters || panelReadClock });
    checkDailyDigest(app); // app aberto de um dia para o outro
  }
  ui.__minuteTick = minuteTick; // testes
  const minuteTimer = win.setInterval(minuteTick, 60000);
  if (clockOrig) {
    cleanups.push(() => {
      clockObj.now = clockOrig.now;
    });
  }
  // "Resumo do dia": logo depois do primeiro desenho e quando o app volta a ficar visível (celular).
  // Novidades da versão primeiro: se abrirem, o resumo encontra o diálogo aberto e espera a próxima verificação.
  const digestTimer = win.setTimeout(() => {
    checkWhatsNew(app);
    checkDailyDigest(app);
  }, 700);
  const onVisible = () => {
    if (doc.visibilityState === 'visible') checkDailyDigest(app);
  };
  doc.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => win.clearTimeout(digestTimer), () => doc.removeEventListener('visibilitychange', onVisible));
  const secondTimer = win.setInterval(tickTimers, 1000);
  cleanups.push(() => win.clearInterval(minuteTimer), () => win.clearInterval(secondTimer), () => router.stop());

  // ----- rota ---------------------------------------------------------------------------------------
  router.subscribe((next, prev) => {
    // o "voltar" do closePanel chegou: roda as navegações que esperavam por ele (no próximo tique, fora do aviso)
    if (pendingBack && !next.params.panel) win.setTimeout(settlePendingBack, 0);
    if (!viewByPath(next.path)) {
      router.navigate(DEFAULT_PATH, { params: next.params, replace: true });
      return;
    }
    const nextView = viewByPath(next.path);
    const prevView = prev ? viewByPath(prev.path) : null;
    if (!next.params.panel) pushedPanelRoute = null;
    if (prevView !== nextView) {
      closeAllOverlays();
      drawerOpen = false;
      enterView(nextView, prevView);
    }
    if (prev && prevView === nextView && onlyPanelChanged(prev.params, next.params)) schedulePanelChange();
    else schedule();
  });
  router.start();
  if (!viewByPath(router.current().path)) router.navigate(DEFAULT_PATH, { params: router.current().params, replace: true });

  // ----- primeiro desenho -----------------------------------------------------------------------------
  applyTheme();
  root.replaceChildren();
  schedule();
  flush();
  lastPath = router.current().path;
  enterView(activeView(), null);
  return ui;
}

/** Entre duas rotas da mesma tela, só o parâmetro `panel` mudou? */
function onlyPanelChanged(a, b) {
  const pa = a || {};
  const pb = b || {};
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  let panel = false;
  for (const k of keys) {
    if (pa[k] === pb[k]) continue;
    if (k !== 'panel') return false;
    panel = true;
  }
  return panel;
}

function navigatorIsMac() {
  try {
    const nav = globalThis.navigator;
    const platform = (nav && nav.userAgentData && nav.userAgentData.platform) || (nav && nav.platform) || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}
