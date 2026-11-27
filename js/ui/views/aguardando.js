// Visualização "Aguardando" (#/aguardando): o que depende de outras pessoas, agrupado por pessoa.
//
//   • aba "Aguardando terceiros": itens abertos em "Aguardando terceiros" (pessoa = waiting_on);
//   • aba "Com outras pessoas": itens abertos cujo responsável não é o responsável padrão (Configurações);
//   • cada linha: código, nome, projeto (e demanda), "aguardando há N dias", "Cobrar em" (vermelho se vencida)
//     e a última cobrança; ações "Cobrei agora" (registra a cobrança e agenda a próxima), "Cobrar em…"
//     (calendário) e "Retomar" (volta ao status anterior à espera). Clicar na linha abre o painel lateral;
//   • selo da navegação = cobranças vencidas ou para hoje (respeita o filtro global de projeto).
//
// Dados: app.sel.waitingBoard() (memorizado por versão do banco e dia). Estado da tela: { tab }.

import { cx, h } from '../../core/dom.js';
import { formatDate, isoToDateStr } from '../../core/dates.js';
import { button, tabs } from '../kit/controls.js';
import { alertBox, avatar, badge, emptyState } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { entityActions, entityAttrs, entityTitle, followUpControl } from '../shared/entity.js';
import { projectDot } from '../projects.js';

const TABS = Object.freeze(['waiting', 'others']);
const INTERACTIVE = 'button, a, input, textarea, select, label, [data-stop]';

/** Projeto do escopo global (filtro da barra superior) ou null. */
function scopeOf(app) {
  return app.ui && app.ui.scope && app.ui.scope.projectId ? app.ui.scope.projectId : null;
}

/** Quadro filtrado pelo escopo global de projeto (grupos sem itens somem). */
function scopedBoard(app) {
  const board = app.sel.waitingBoard();
  const scope = scopeOf(app);
  if (!scope) return board;
  const filter = (groups) =>
    groups
      .map((g) => {
        const items = g.items.filter((item) => app.sel.projectIdOf(item.type, item.entity) === scope);
        return { ...g, items, count: items.length, dueCount: items.filter((i) => i.due).length };
      })
      .filter((g) => g.count > 0);
  const waiting = filter(board.waiting);
  const others = filter(board.others);
  const all = [...waiting, ...others];
  return {
    waiting,
    others,
    waitingCount: waiting.reduce((n, g) => n + g.count, 0),
    othersCount: others.reduce((n, g) => n + g.count, 0),
    dueCount: all.reduce((n, g) => n + g.dueCount, 0),
  };
}

let badgeApp = null; // por app: a versão do banco recomeça em outro app/banco
let badgeKey = '';
let badgeValue = 0;
/** Selo: cobranças vencidas ou para hoje — memorizado por versão do banco, dia e escopo (a casca chama a cada render). */
export function aguardandoBadge(app) {
  const key = `${app.store.version()}|${app.clock.today()}|${scopeOf(app) || ''}`;
  if (key !== badgeKey || app !== badgeApp) {
    badgeApp = app;
    badgeKey = key;
    badgeValue = scopedBoard(app).dueCount;
  }
  return badgeValue;
}

const daysText = (n) => (n <= 0 ? 'desde hoje' : n === 1 ? 'há 1 dia' : `há ${n} dias`);

function metaLine(app, item, tab) {
  const parts = [];
  const project = app.sel.projectOf(item.type, item.entity);
  if (project) parts.push(h('span', { class: 'v-agu-project' }, projectDot(project), h('span', null, project.name)));
  if (item.type === 'task') {
    const demand = app.sel.demandOf(item.entity);
    if (demand) parts.push(h('span', { class: 'v-agu-demand', title: demand.name }, icon('layers', { size: 12 }), h('span', null, demand.name)));
  }
  parts.push(
    h(
      'span',
      { class: 'v-agu-since', title: item.since ? `Desde ${formatDate(isoToDateStr(item.since), 'long')}` : null },
      icon('hourglass', { size: 12 }),
      h('span', null, `${tab === 'waiting' ? 'Aguardando' : 'Com a pessoa'} ${daysText(item.waitingDays)}`),
    ),
  );
  if (item.lastFollowUpAt) {
    parts.push(
      h(
        'span',
        { class: 'v-agu-last', title: item.lastFollowUpNote || null },
        icon('bell', { size: 12 }),
        h('span', null, `Última cobrança: ${formatDate(isoToDateStr(item.lastFollowUpAt), 'short', app.clock.today())}`),
      ),
    );
  } else {
    parts.push(h('span', { class: 'v-agu-last is-none' }, 'Nunca cobrado'));
  }
  return h('div', { class: 'v-agu-meta' }, parts);
}

function itemRow(app, item, tab) {
  const attrs = entityAttrs(app, item.type, item.entity);
  const id = item.entity.id;
  return h(
    'div',
    {
      ...attrs,
      key: item.key,
      class: cx('v-agu-row', attrs.class, item.followUp.state === 'overdue' && 'is-overdue', item.followUp.state === 'today' && 'is-today'),
      onclick: (ev) => {
        if (ev.target && typeof ev.target.closest === 'function' && ev.target.closest(INTERACTIVE)) return;
        entityActions.open(app, item.type, id);
      },
    },
    h(
      'div',
      { class: 'v-agu-main' },
      h('div', { class: 'v-agu-title' }, entityTitle(app, item.type, item.entity), item.type === 'demand' ? badge('Demanda', { tone: 'neutral', class: 'v-agu-kind' }) : null),
      metaLine(app, item, tab),
    ),
    h(
      'div',
      { class: 'v-agu-actions' },
      h('span', { class: 'v-agu-followup', title: 'Cobrar em' }, followUpControl(app, item.type, item.entity, { placeholder: 'Cobrar em…' })),
      button({ label: 'Cobrei agora', icon: 'bell', size: 'sm', class: 'v-agu-log', onclick: () => entityActions.logFollowUp(app, item.type, id) }),
      tab === 'waiting'
        ? button({ label: 'Retomar', icon: 'play', size: 'sm', variant: 'ghost', class: 'v-agu-resume', onclick: () => entityActions.resumeWaiting(app, item.type, id) })
        : null,
    ),
  );
}

function groupView(app, group, tab) {
  return h(
    'section',
    { class: 'v-agu-group', key: `g:${group.key || '-'}`, 'data-person': group.key || '' },
    h(
      'header',
      { class: 'v-agu-group-head' },
      group.key ? avatar(group.name, { size: 24 }) : h('span', { class: 'v-agu-noone' }, icon('user', { size: 14 })),
      h('h3', { class: 'v-agu-person' }, group.name),
      h('span', { class: 'v-agu-count tabular', title: `${group.count} ${group.count === 1 ? 'item' : 'itens'}` }, String(group.count)),
      group.dueCount ? badge(group.dueCount === 1 ? '1 para cobrar' : `${group.dueCount} para cobrar`, { tone: 'danger', icon: 'bell', class: 'v-agu-due' }) : null,
    ),
    h('div', { class: 'v-agu-list' }, group.items.map((item) => itemRow(app, item, tab))),
  );
}

function emptyView(app, tab) {
  const toList = button({ label: 'Ir para Demandas', icon: 'list', variant: 'primary', size: 'sm', onclick: () => app.ui.navigate('/demandas'), attrs: { 'data-action': 'go-demandas' } });
  return tab === 'waiting'
    ? emptyState({
        icon: 'hourglass',
        title: 'Nada aguardando terceiros',
        text: 'Mude o status de uma tarefa ou demanda para “Aguardando terceiros” e informe de quem você espera o retorno: ela aparece aqui, com a data de cobrança.',
        action: toList,
      })
    : emptyState({
        icon: 'user',
        title: 'Nada com outras pessoas',
        text: 'Tarefas e demandas abertas cujo responsável é outra pessoa aparecem aqui, agrupadas por responsável. Defina o responsável no painel do item.',
        action: toList,
      });
}

function render(app, ctx) {
  const tab = TABS.includes(ctx.state && ctx.state.tab) ? ctx.state.tab : 'waiting';
  const board = scopedBoard(app);
  const groups = tab === 'waiting' ? board.waiting : board.others;
  const noDefault = !String(app.settings.get('owner.default') || '').trim();
  return h(
    'div',
    { class: cx('v-aguardando', ctx.isMobile && 'is-mobile'), 'data-tab': tab },
    h(
      'div',
      { class: 'v-agu-inner' },
      h(
        'div',
        { class: 'v-agu-head' },
        h('p', { class: 'v-agu-lead' }, 'O que depende de outras pessoas. Cobre na data certa e registre cada cobrança.'),
        board.dueCount
          ? badge(board.dueCount === 1 ? '1 cobrança para hoje ou atrasada' : `${board.dueCount} cobranças para hoje ou atrasadas`, { tone: 'danger', icon: 'bell', class: 'v-agu-summary' })
          : null,
      ),
      tabs({
        ariaLabel: 'Tipo de espera',
        active: tab,
        class: 'v-agu-tabs',
        tabs: [
          { id: 'waiting', label: 'Aguardando terceiros', icon: 'hourglass', count: board.waitingCount },
          { id: 'others', label: 'Com outras pessoas', icon: 'user', count: board.othersCount },
        ],
        onchange: (id) => ctx.setState({ tab: id }),
      }),
      tab === 'others' && noDefault
        ? alertBox({
            tone: 'info',
            text: 'Defina o seu nome como responsável padrão em Configurações: assim só os itens de outras pessoas aparecem nesta aba.',
          })
        : null,
      groups.length ? h('div', { class: 'v-agu-groups' }, groups.map((g) => groupView(app, g, tab))) : emptyView(app, tab),
    ),
  );
}

export default {
  id: 'aguardando',
  path: '/aguardando',
  title: 'Aguardando',
  icon: 'hourglass',
  order: 25,
  section: 'main',
  badge(app) {
    return aguardandoBadge(app);
  },
  render,
};
