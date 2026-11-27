// Paleta de comandos (Ctrl/Cmd+K ou /): busca demandas e tarefas (sel.search) e oferece comandos de
// navegação, criação, sincronização e tema. Controle completo pelo teclado: ↑ ↓ Home End, Enter, Esc.
//
//   openPalette(app)                  // abre vazia (só comandos)
//   openPalette(app, { query: 'mod' })

import { cx, h } from '../core/dom.js';
import { normalizeText } from '../core/format.js';
import { formatKeys } from '../core/shortcuts.js';
import { emptyState } from './kit/display.js';
import { icon } from './kit/icons.js';
import { openModal } from './kit/overlays.js';
import { projectDot } from './projects.js';
import { openIcsDialog } from './ics-export.js';
import { openTemplateDialog } from './templates.js';
import { views } from './views/index.js';

const MAX_RESULTS = 12;
const MAX_COMMANDS = 8;

/** Atalho de navegação de cada tela ("G então D"…). */
export const NAV_SHORTCUTS = Object.freeze({
  dashboard: 'g d',
  semana: 'g s',
  demandas: 'g l',
  kanban: 'g k',
  aguardando: 'g a',
  calendario: 'g c',
  hierarquia: 'g h',
  backlog: 'g b',
  dependencias: 'g p',
  cronograma: 'g o',
  tempo: 'g t',
  metricas: 'g m',
  relatorio: 'g r',
});

/**
 * Pontuação de uma busca aproximada (subsequência), sem diferenciar acentos nem maiúsculas.
 * Correspondência no início do texto ou de uma palavra e letras seguidas valem mais; 0 = não casa.
 *   fuzzyScore('ir para kanban', 'kan') > fuzzyScore('ir para kanban', 'kbn') > 0
 * @param {string} text texto do comando
 * @param {string} query o que foi digitado
 * @returns {number}
 */
export function fuzzyScore(text, query) {
  const t = normalizeText(text);
  const q = normalizeText(query).replace(/\s+/g, ' ');
  if (!q) return 1;
  if (!t) return 0;
  const at = t.indexOf(q);
  if (at === 0) return 1000 - t.length;
  if (at > 0) return (t[at - 1] === ' ' ? 800 : 600) - t.length;
  // Todas as palavras digitadas aparecem (em qualquer ordem)?
  const words = q.split(' ').filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 500 - t.length;
  // Subsequência: cada letra digitada aparece, em ordem.
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q.replace(/ /g, '')) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    const wordStart = found === 0 || t[found - 1] === ' ';
    score += 1 + streak * 2 + (wordStart ? 3 : 0);
    ti = found + 1;
  }
  return Math.min(score, 400);
}

/** Comandos fixos da paleta. */
function commandList(app) {
  const ui = app.ui || {};
  const list = [];
  for (const view of views) {
    list.push({
      id: `nav:${view.id}`,
      group: 'Ir para',
      label: view.title,
      keywords: `ir para abrir tela ${view.id} ${view.path}`,
      icon: view.icon,
      keys: NAV_SHORTCUTS[view.id] || null,
      run: () => ui.navigate && ui.navigate(view.path),
    });
  }
  list.push(
    { id: 'new:task', group: 'Criar', label: 'Nova tarefa', keywords: 'criar adicionar tarefa', icon: 'plus', keys: 'n', run: () => ui.quickCreate && ui.quickCreate('task') },
    { id: 'new:demand', group: 'Criar', label: 'Nova demanda', keywords: 'criar adicionar demanda', icon: 'plus', keys: 'shift+n', run: () => ui.quickCreate && ui.quickCreate('demand') },
    { id: 'new:demand-template', group: 'Criar', label: 'Nova demanda a partir de modelo…', keywords: 'criar demanda modelo template recursos', icon: 'copy', keys: null, run: () => openTemplateDialog(app) },
    { id: 'new:project', group: 'Criar', label: 'Novo projeto', keywords: 'criar adicionar projeto', icon: 'folder', keys: null, run: () => ui.createProject && ui.createProject() },
  );
  if (app.sync) {
    list.push({ id: 'sync', group: 'Ações', label: 'Sincronizar agora', keywords: 'sincronizar enviar baixar supabase nuvem', icon: 'refresh', keys: null, run: () => app.sync.syncNow({ reason: 'manual' }) });
  }
  const theme = typeof ui.theme === 'function' ? ui.theme() : 'system';
  list.push(
    { id: 'theme:light', group: 'Tema', label: 'Tema claro', keywords: 'tema aparencia claro light', icon: 'sun', checked: theme === 'light', run: () => ui.setTheme && ui.setTheme('light') },
    { id: 'theme:dark', group: 'Tema', label: 'Tema escuro', keywords: 'tema aparencia escuro dark noturno', icon: 'moon', checked: theme === 'dark', run: () => ui.setTheme && ui.setTheme('dark') },
    { id: 'theme:system', group: 'Tema', label: 'Tema do sistema', keywords: 'tema aparencia sistema automatico', icon: 'circle-half', checked: theme === 'system', run: () => ui.setTheme && ui.setTheme('system') },
    { id: 'digest', group: 'Ações', label: 'Resumo do dia', keywords: 'resumo dia lembretes atrasadas vencimentos cobrancas hoje', icon: 'bell', keys: null, run: () => ui.showDigest && ui.showDigest() },
    { id: 'ics', group: 'Ações', label: 'Exportar calendário (.ics)…', keywords: 'exportar ics calendario outlook google agenda prazos', icon: 'download', keys: null, run: () => openIcsDialog(app) },
    { id: 'whatsnew', group: 'Ações', label: 'Novidades da versão', keywords: 'novidades versao atualizacao o que mudou recursos novos', icon: 'sparkles', keys: null, run: () => ui.showWhatsNew && ui.showWhatsNew() },
    { id: 'help', group: 'Ações', label: 'Atalhos de teclado', keywords: 'ajuda atalhos teclado', icon: 'keyboard', keys: '?', run: () => ui.showHelp && ui.showHelp() },
  );
  if (ui.scope && ui.scope.projectId) {
    list.push({ id: 'scope:clear', group: 'Ações', label: 'Mostrar todos os projetos', keywords: 'limpar filtro projeto escopo', icon: 'x', run: () => ui.setScope && ui.setScope({ projectId: null }) });
  }
  for (const project of app.sel.projects()) {
    list.push({
      id: `scope:${project.id}`,
      group: 'Filtrar por projeto',
      label: project.name || 'Projeto sem nome',
      keywords: `projeto filtrar ${project.code || ''}`,
      dot: project,
      run: () => ui.setScope && ui.setScope({ projectId: project.id }),
    });
  }
  return list;
}

/** Resultados (entidades + comandos) para o texto digitado. */
function computeItems(app, query) {
  const q = query.trim();
  const items = [];
  if (q) {
    let found = [];
    try {
      found = app.sel.search(q, { limit: MAX_RESULTS });
    } catch (err) {
      console.error('[paleta] falha na busca', err);
    }
    for (const { type, entity } of found) {
      if (!entity) continue;
      const project = app.sel.projectOf(type, entity);
      const demand = type === 'task' ? app.sel.demandOf(entity) : null;
      items.push({
        id: `${type}:${entity.id}`,
        group: 'Demandas e tarefas',
        label: entity.name || 'Sem nome',
        code: app.sel.code(type, entity),
        detail: [demand ? demand.name : null, project ? project.name : null].filter(Boolean).join(' · '),
        icon: type === 'demand' ? 'layers' : 'circle',
        closed: !app.sel.isOpen(entity),
        entity: { type, id: entity.id },
        run: () => app.ui && app.ui.openPanel(type, entity.id),
      });
    }
  }
  const scored = commandList(app)
    .map((cmd) => ({ cmd, score: q ? Math.max(fuzzyScore(cmd.label, q), fuzzyScore(`${cmd.label} ${cmd.keywords || ''}`, q) * 0.8) : 1 }))
    .filter((entry) => entry.score > 0);
  if (q) scored.sort((a, b) => b.score - a.score);
  const commands = scored.map((entry) => entry.cmd);
  // Sem texto: navegação + criação + ações; com texto: os melhores comandos depois das entidades.
  const limited = q ? commands.slice(0, MAX_COMMANDS) : commands.filter((c) => c.group !== 'Filtrar por projeto' && c.group !== 'Tema');
  return items.concat(limited.map((cmd) => ({ ...cmd, group: q ? 'Comandos' : cmd.group })));
}

/**
 * Abre a paleta de comandos.
 * @param {object} app
 * @param {{ query?: string }} [options]
 * @returns {{ close: Function, update: Function, el: HTMLElement }}
 */
export function openPalette(app, { query = '' } = {}) {
  const state = { query: String(query || ''), active: 0, items: [] };
  let dialog = null;
  const listId = 'palette-list';

  const refresh = () => {
    state.items = computeItems(app, state.query);
    if (state.active >= state.items.length) state.active = Math.max(0, state.items.length - 1);
  };

  const choose = (index, close) => {
    const item = state.items[index];
    if (!item) return;
    close('select');
    try {
      const out = item.run();
      if (out && typeof out.catch === 'function') out.catch((err) => console.error('[paleta] comando falhou', err));
    } catch (err) {
      console.error('[paleta] comando falhou', err);
    }
  };

  const move = (delta, absolute) => {
    const n = state.items.length;
    if (!n) return;
    state.active = absolute !== undefined ? absolute : (state.active + delta + n) % n;
    dialog.update();
    const el = dialog.el.querySelector(`[data-index="${state.active}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  };

  refresh();

  const renderItem = (item, index, close) =>
    h(
      'div',
      {
        key: item.id,
        id: `palette-opt-${index}`,
        class: cx('palette-item', index === state.active && 'is-active', item.closed && 'is-closed'),
        role: 'option',
        'aria-selected': index === state.active,
        'data-index': index,
        'data-id': item.id,
        onpointermove: () => {
          if (state.active !== index) {
            state.active = index;
            dialog.update();
          }
        },
        onclick: () => choose(index, close),
      },
      h('span', { class: 'palette-icon' }, item.dot ? projectDot(item.dot) : icon(item.icon || 'arrow-right', { size: 14 })),
      h(
        'span',
        { class: 'palette-main' },
        h('span', { class: 'palette-label truncate' }, item.code ? h('span', { class: 'palette-code tabular' }, item.code) : null, item.label),
        item.detail ? h('span', { class: 'palette-detail truncate' }, item.detail) : null,
      ),
      item.checked ? h('span', { class: 'palette-check' }, icon('check', { size: 14 })) : null,
      item.keys ? h('span', { class: 'palette-keys' }, formatKeys(item.keys)) : null,
    );

  const renderList = (close) => {
    if (state.items.length === 0) {
      return h('div', { class: 'palette-empty' }, emptyState({ icon: 'search', title: 'Nada encontrado', text: 'Tente outro nome, um código (T-12, D-3) ou uma etiqueta.', compact: true }));
    }
    const out = [];
    let lastGroup = null;
    state.items.forEach((item, index) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        out.push(h('div', { class: 'palette-group', key: `g:${item.group}`, role: 'presentation' }, item.group));
      }
      out.push(renderItem(item, index, close));
    });
    return h('div', { class: 'palette-list', id: listId, role: 'listbox', 'aria-label': 'Resultados' }, out);
  };

  dialog = openModal({
    title: 'Paleta de comandos',
    size: 'md',
    class: 'palette',
    render: (close) =>
      h(
        'div',
        { class: 'palette-body', 'data-palette': 'true' },
        h(
          'div',
          { class: 'palette-search' },
          icon('search', { size: 16, class: 'palette-search-icon' }),
          h('input', {
            class: 'palette-input',
            type: 'text',
            value: state.query,
            placeholder: 'Buscar tarefas, demandas ou comandos…',
            'aria-label': 'Buscar tarefas, demandas ou comandos',
            role: 'combobox',
            'aria-expanded': true,
            'aria-controls': listId,
            'aria-activedescendant': state.items.length ? `palette-opt-${state.active}` : null,
            autocomplete: 'off',
            spellcheck: false,
            'data-autofocus': true,
            oninput: (ev) => {
              state.query = ev.currentTarget.value;
              state.active = 0;
              refresh();
              dialog.update();
            },
            onkeydown: (ev) => {
              if (ev.isComposing) return;
              if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                move(1);
              } else if (ev.key === 'ArrowUp') {
                ev.preventDefault();
                move(-1);
              } else if (ev.key === 'Home' && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                move(0, 0);
              } else if (ev.key === 'End' && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                move(0, state.items.length - 1);
              } else if (ev.key === 'PageDown') {
                ev.preventDefault();
                move(0, Math.min(state.items.length - 1, state.active + 5));
              } else if (ev.key === 'PageUp') {
                ev.preventDefault();
                move(0, Math.max(0, state.active - 5));
              } else if (ev.key === 'Enter') {
                ev.preventDefault();
                choose(state.active, close);
              }
            },
          }),
        ),
        renderList(close),
        h(
          'div',
          { class: 'palette-foot', 'aria-hidden': 'true' },
          h('span', null, h('kbd', { class: 'kbd' }, '↑'), h('kbd', { class: 'kbd' }, '↓'), ' navegar'),
          h('span', null, h('kbd', { class: 'kbd' }, 'Enter'), ' abrir'),
          h('span', null, h('kbd', { class: 'kbd' }, 'Esc'), ' fechar'),
        ),
      ),
    actions: [],
  });
  return dialog;
}
