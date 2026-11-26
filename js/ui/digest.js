// "Resumo do dia" (lembretes): modal com atrasadas, vencimentos de hoje e dos próximos dias úteis, cobranças e
// — às segundas — o resumo da semana anterior. Regras em js/domain/digest.js; dados em app.sel.dailyDigest().
//
//   openDigestModal(app)          // abre a qualquer momento (paleta "Resumo do dia", botão do Início)
//   checkDailyDigest(app)         // 1º acesso do dia NESTE dispositivo: abre o modal (e a notificação, se ligada)
//   requestDigestNotifications(app)  // pede a permissão de Notification (Configurações › Lembretes)
//
// Preferências do dispositivo (app.prefs): 'digest.enabled' (padrão true), 'digest.lastShown' ('YYYY-MM-DD' do
// último resumo mostrado) e 'digest.notify' (notificação do sistema; só enquanto o app está aberto — sem push).

import { h } from '../core/dom.js';
import { DIGEST_SECTIONS, digestHeadline, digestTitle, digestToText, weekPlanLines } from '../domain/digest.js';
import { copyToClipboard } from './kit/clipboard.js';
import { button, iconButton } from './kit/controls.js';
import { emptyState } from './kit/display.js';
import { icon } from './kit/icons.js';
import { isOverlayOpen, openModal } from './kit/overlays.js';
import { notify } from './shared/entity.js';
import { buildMailto } from './views/relatorio.js';

export const DIGEST_PREF_ENABLED = 'digest.enabled';
export const DIGEST_PREF_LAST = 'digest.lastShown';
export const DIGEST_PREF_NOTIFY = 'digest.notify';

/** O resumo automático do 1º acesso do dia está ligado neste dispositivo? */
export function digestEnabled(app) {
  return app.prefs.get(DIGEST_PREF_ENABLED, true) !== false;
}

/** A notificação do sistema está ligada (preferência) neste dispositivo? */
export function digestNotifyEnabled(app) {
  return app.prefs.get(DIGEST_PREF_NOTIFY, false) === true;
}

/** O navegador tem a API de notificações? */
export function notificationsSupported(win = globalThis) {
  try {
    return typeof win.Notification === 'function' && typeof win.Notification.requestPermission === 'function';
  } catch {
    return false;
  }
}

/** Estado da permissão: 'granted' | 'denied' | 'default' | 'unsupported'. */
export function notificationPermission(win = globalThis) {
  if (!notificationsSupported(win)) return 'unsupported';
  try {
    return win.Notification.permission || 'default';
  } catch {
    return 'unsupported';
  }
}

let openEntry = null;

function itemRow(app, item, close) {
  return h(
    'li',
    { key: item.key, class: 'digest-item' },
    h(
      'button',
      {
        type: 'button',
        class: 'digest-item-btn',
        'data-entity': item.key,
        title: 'Abrir',
        onclick: () => {
          close('open');
          if (app.ui) app.ui.openPanel(item.type, item.id);
        },
      },
      item.code ? h('span', { class: 'digest-code tabular' }, item.code) : null,
      h('span', { class: 'digest-name' }, item.name),
      item.type === 'task' && item.demandName ? h('span', { class: 'digest-demand' }, item.demandName) : null,
      item.detail ? h('span', { class: 'digest-detail' }, item.detail) : null,
    ),
  );
}

async function copyDigest(app, text, message = 'Resumo do dia copiado.') {
  const ok = await copyToClipboard(text, window);
  notify(app, ok ? message : 'Não foi possível copiar o texto.', { tone: ok ? 'success' : 'danger' });
  return ok;
}

function renderBody(app, digest, close) {
  const text = digestToText(digest);
  const mail = buildMailto(`Resumo do dia — ${digest.today.split('-').reverse().join('/')}`, text);
  const sections = DIGEST_SECTIONS.filter((s) => (digest[s.id] || []).length);
  return h(
    'div',
    { class: 'digest', 'data-digest': digest.today },
    h('p', { class: 'digest-headline' }, digestHeadline(digest)),
    sections.length || digest.weekPlan
      ? null
      : emptyState({ icon: 'check-circle', title: 'Nada urgente hoje', text: 'Sem atrasos, vencimentos próximos ou cobranças.', compact: true }),
    sections.map((s) =>
      h(
        'section',
        { key: s.id, class: `digest-section tone-${s.tone}`, 'data-section': s.id },
        h('h3', { class: 'digest-section-title' }, icon(s.icon, { size: 14 }), h('span', null, s.title), h('span', { class: 'digest-count tabular' }, String(digest[s.id].length))),
        h('ul', { class: 'digest-list' }, digest[s.id].map((item) => itemRow(app, item, close))),
      ),
    ),
    digest.weekPlan
      ? h(
          'section',
          { key: 'week', class: 'digest-section', 'data-section': 'weekPlan' },
          h('h3', { class: 'digest-section-title' }, icon('calendar-week', { size: 14 }), h('span', null, 'Planejamento da semana')),
          h('ul', { class: 'digest-week' }, weekPlanLines(digest.weekPlan).map((line, i) => h('li', { key: `w${i}` }, line))),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-sm digest-week-link',
              onclick: () => {
                close('week');
                if (app.ui) app.ui.navigate('/semana');
              },
            },
            'Abrir Minha Semana',
          ),
        )
      : null,
    h(
      'div',
      { class: 'digest-actions' },
      button({ label: 'Copiar', icon: 'copy', size: 'sm', attrs: { 'data-action': 'digest-copy' }, onclick: () => copyDigest(app, text) }),
      h(
        'a',
        {
          class: 'btn btn-default btn-sm',
          href: mail.href,
          'data-action': 'digest-mail',
          title: mail.truncated ? 'O texto é longo: o e-mail leva um resumo e o texto completo fica copiado' : 'Abrir no programa de e-mail',
          onclick: () => {
            if (mail.truncated) copyDigest(app, text, 'Texto completo copiado — cole no e-mail se ele vier cortado.');
          },
        },
        icon('mail', { size: 14 }),
        h('span', { class: 'btn-label' }, 'Enviar por e-mail'),
      ),
      h('span', { class: 'digest-spacer' }),
      button({ label: 'Fechar', variant: 'primary', size: 'sm', attrs: { 'data-action': 'digest-close', 'data-autofocus': true }, onclick: () => close('close') }),
    ),
  );
}

/**
 * Abre o modal "Resumo do dia" (um só por vez).
 * @param {object} app
 * @returns {object|null} entrada do modal
 */
export function openDigestModal(app) {
  if (openEntry) return openEntry;
  const digest = app.sel.dailyDigest();
  openEntry = openModal({
    title: digestTitle(digest.today).replace(' — ', ' · '),
    size: 'md',
    class: 'digest-modal',
    render: (close) => renderBody(app, digest, close),
    onclose: () => {
      openEntry = null;
    },
  });
  return openEntry;
}

/** Mostra a notificação do sistema com a manchete do resumo (se suportado e permitido). */
export async function showDigestNotification(app, digest, win = globalThis) {
  if (notificationPermission(win) !== 'granted') return false;
  const title = 'Resumo do dia';
  const options = { body: digestHeadline(digest), tag: `dm-digest-${digest.today}`, icon: 'assets/icon.svg' };
  try {
    // Android/Chrome só aceita notificação pelo service worker; no computador, new Notification basta.
    const sw = win.navigator && win.navigator.serviceWorker;
    const reg = sw && typeof sw.getRegistration === 'function' ? await sw.getRegistration() : null;
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, options);
      return true;
    }
    const n = new win.Notification(title, options);
    n.onclick = () => {
      try {
        win.focus();
        openDigestModal(app);
      } catch {
        /* nada */
      }
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * 1º acesso do dia neste dispositivo: abre o resumo (pref. 'digest.enabled') e/ou mostra a notificação
 * (pref. 'digest.notify'). Não mostra quando o resumo está vazio nem quando já há outro diálogo aberto (tenta
 * de novo na próxima vez). Marca 'digest.lastShown' = hoje só quando mostrou.
 * @param {object} app
 * @returns {boolean} true quando mostrou
 */
export function checkDailyDigest(app) {
  try {
    const modal = digestEnabled(app);
    const notifyOn = digestNotifyEnabled(app);
    if (!modal && !notifyOn) return false;
    const today = app.clock.today();
    if (app.prefs.get(DIGEST_PREF_LAST, null) === today) return false;
    const digest = app.sel.dailyDigest();
    if (digest.isEmpty) return false;
    if (modal && (openEntry || isOverlayOpen())) return false;
    app.prefs.set(DIGEST_PREF_LAST, today);
    if (modal) openDigestModal(app);
    if (notifyOn) showDigestNotification(app, digest);
    return true;
  } catch (err) {
    console.error('[digest] falha ao mostrar o resumo do dia', err);
    return false;
  }
}

/**
 * Liga/desliga a notificação do sistema. Ligar pede a permissão (precisa de clique do usuário).
 * @returns {Promise<boolean>} estado final da preferência
 */
export async function requestDigestNotifications(app, on = true, win = globalThis) {
  if (!on) {
    app.prefs.set(DIGEST_PREF_NOTIFY, false);
    return false;
  }
  if (!notificationsSupported(win)) {
    app.prefs.set(DIGEST_PREF_NOTIFY, false);
    notify(app, 'Este navegador não oferece notificações.', { tone: 'warn' });
    return false;
  }
  let permission = notificationPermission(win);
  if (permission === 'default') {
    try {
      permission = await win.Notification.requestPermission();
    } catch {
      permission = 'denied';
    }
  }
  const granted = permission === 'granted';
  app.prefs.set(DIGEST_PREF_NOTIFY, granted);
  notify(
    app,
    granted ? 'Pronto: o resumo do dia também vira notificação quando você abrir o app.' : 'Permissão de notificação negada. Libere nas configurações do site no navegador.',
    { tone: granted ? 'success' : 'warn' },
  );
  return granted;
}

/** Botão de ícone que abre o resumo (cabeçalho do Início). */
export function digestButton(app) {
  return iconButton({ icon: 'bell', title: 'Resumo do dia', size: 'sm', attrs: { 'data-action': 'open-digest' }, onclick: () => openDigestModal(app) });
}

