// "Novidades da versão": modal mostrado UMA vez por dispositivo depois de uma atualização, com botões que levam a
// cada novidade. Também abre por Configurações › Sobre ("Ver novidades") e pela paleta.
//
//   openWhatsNew(app)        // abre a qualquer momento
//   checkWhatsNew(app)       // na abertura do app: mostra se 'whatsnew.seen' ≠ versão do app E há dados;
//                            // instalação nova e vazia só marca como visto (nada a apresentar)
//
// Preferência do dispositivo (app.prefs): 'whatsnew.seen' = versão cujas novidades já foram vistas.
// Ordem com o "Resumo do dia": a casca chama checkWhatsNew antes de checkDailyDigest; com as novidades abertas o
// resumo encontra um diálogo aberto e espera a próxima verificação (minuto seguinte ou volta ao app).

import { h } from '../core/dom.js';
import { formatKeys } from '../core/shortcuts.js';
import { openDigestModal } from './digest.js';
import { button } from './kit/controls.js';
import { icon } from './kit/icons.js';
import { isOverlayOpen, openModal } from './kit/overlays.js';
import { openTemplateDialog } from './templates.js';

export const WHATSNEW_PREF = 'whatsnew.seen';

/** Versão do app (APP_VERSION, repassada por boot.js em app.env.version). */
function appVersion(app) {
  return (app && app.env && app.env.version) || null;
}

/** Leva à seção `id` das Configurações (depois que a tela desenhar). */
function goToConfigSection(app, id) {
  app.ui.navigate('/config');
  let tries = 0;
  const tick = () => {
    const el = typeof document !== 'undefined' ? document.getElementById(`config-${id}`) : null;
    if (el) el.scrollIntoView({ block: 'start' });
    else if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}

/**
 * Novidades da v001, na ordem do modal. `go(app)` roda depois de fechar o modal.
 * @type {ReadonlyArray<{ id: string, icon: string, title: string, text: string, action: string, keys?: string, go: Function }>}
 */
export const WHATSNEW_ITEMS = Object.freeze([
  { id: 'aguardando', icon: 'hourglass', title: 'Aguardando', text: 'O que depende de outras pessoas, por pessoa, com data de cobrança e registro de cada “Cobrei”.', action: 'Abrir Aguardando', keys: 'g a', go: (app) => app.ui.navigate('/aguardando') },
  { id: 'cronograma', icon: 'rows', title: 'Cronograma', text: 'Linha do tempo (Gantt) de demandas e tarefas, com dependências.', action: 'Abrir Cronograma', keys: 'g o', go: (app) => app.ui.navigate('/cronograma') },
  { id: 'relatorio', icon: 'file-text', title: 'Relatório de status', text: 'Concluídas, em andamento, bloqueios e próximos passos do período — imprimir/PDF, copiar ou enviar por e-mail.', action: 'Abrir Relatório', keys: 'g r', go: (app) => app.ui.navigate('/relatorio') },
  { id: 'modelos', icon: 'copy', title: 'Modelos de demanda', text: 'Nova → “Demanda a partir de modelo…” cria a demanda já com tarefas, durações e dependências.', action: 'Usar um modelo', go: (app) => openTemplateDialog(app) },
  { id: 'links', icon: 'link', title: 'Links e arquivos', text: 'No painel de uma demanda ou tarefa: cole caminhos de rede, pastas ou endereços web.', action: 'Abrir Demandas', go: (app) => app.ui.navigate('/demandas') },
  { id: 'recorrencia', icon: 'refresh', title: 'Tarefas recorrentes', text: 'No painel da tarefa, “Repetir”: ao concluir, a próxima ocorrência é criada sozinha.', action: 'Abrir Demandas', go: (app) => app.ui.navigate('/demandas') },
  { id: 'ics', icon: 'calendar', title: 'Exportar para o Outlook/Google (.ics)', text: 'No Calendário, “Exportar .ics” gera um arquivo com prazos para importar no seu calendário.', action: 'Abrir Calendário', keys: 'g c', go: (app) => app.ui.navigate('/calendario') },
  { id: 'digest', icon: 'bell', title: 'Resumo do dia', text: 'No primeiro acesso do dia: atrasadas, vencimentos e cobranças (às segundas, a semana anterior).', action: 'Ver o resumo de hoje', go: (app) => openDigestModal(app) },
  { id: 'captura', icon: 'share', title: 'Captura rápida', text: 'Instale o app e use “Compartilhar”, o Atalho do iPhone ou o favorito do navegador para anotar uma tarefa em segundos.', action: 'Ver como configurar', go: (app) => goToConfigSection(app, 'captura') },
]);

let openEntry = null;

function itemRow(app, item, index, close) {
  return h(
    'li',
    { key: item.id, class: 'wn-item', 'data-feature': item.id },
    h('span', { class: 'wn-icon' }, icon(item.icon, { size: 16 })),
    h(
      'div',
      { class: 'wn-main' },
      h('div', { class: 'wn-title' }, item.title, item.keys ? h('kbd', { class: 'kbd wn-keys', title: 'Atalho de teclado' }, formatKeys(item.keys)) : null),
      h('p', { class: 'wn-text' }, item.text),
    ),
    button({
      label: item.action,
      size: 'sm',
      variant: 'ghost',
      class: 'wn-go',
      attrs: { 'data-action': `whatsnew-${item.id}`, 'data-autofocus': index === 0 ? true : null },
      onclick: () => {
        close('go');
        try {
          item.go(app);
        } catch (err) {
          console.error('[novidades] falha ao abrir', item.id, err);
        }
      },
    }),
  );
}

/**
 * Abre o modal de novidades (um só por vez) e marca a versão como vista.
 * @param {object} app
 * @returns {object|null} entrada do modal
 */
export function openWhatsNew(app) {
  if (openEntry) return openEntry;
  const version = appVersion(app);
  if (version) app.prefs.set(WHATSNEW_PREF, version);
  openEntry = openModal({
    title: `Novidades da ${version || 'nova versão'}`,
    size: 'md',
    class: 'whatsnew-modal',
    render: (close) =>
      h(
        'div',
        { class: 'wn', 'data-whatsnew': version || '' },
        h('p', { class: 'wn-lead' }, 'O Demand Manager foi atualizado. Veja o que há de novo — cada botão leva direto ao recurso.'),
        h('ul', { class: 'wn-list' }, WHATSNEW_ITEMS.map((item, i) => itemRow(app, item, i, close))),
        h('p', { class: 'wn-foot' }, 'Esta lista fica em Configurações › Sobre › “Ver novidades”.'),
      ),
    actions: [{ label: 'Entendi', variant: 'primary', value: 'close' }],
    onclose: () => {
      openEntry = null;
    },
  });
  return openEntry;
}

/** O app tem algum dado (projeto, demanda ou tarefa)? */
function hasData(app) {
  try {
    return app.sel.projects().length > 0 || app.sel.demands().length > 0 || app.sel.tasks().length > 0;
  } catch {
    return false;
  }
}

/**
 * Abertura do app: mostra as novidades uma vez por dispositivo e versão.
 * Instalação nova (sem dados): só marca como visto. Com outro diálogo aberto: tenta de novo na próxima vez.
 * @param {object} app
 * @returns {boolean} true quando abriu o modal
 */
export function checkWhatsNew(app) {
  try {
    const version = appVersion(app);
    if (!version || app.prefs.get(WHATSNEW_PREF, null) === version) return false;
    if (!hasData(app)) {
      app.prefs.set(WHATSNEW_PREF, version);
      return false;
    }
    if (openEntry || isOverlayOpen()) return false;
    openWhatsNew(app);
    return true;
  } catch (err) {
    console.error('[novidades] falha ao verificar', err);
    return false;
  }
}
