// Tela "Configurações": conta e sincronização (Supabase), preferências, dados (backup e lixeira), status e
// informações sobre o aplicativo.
//
// O formulário do Supabase guarda o que foi digitado só em memória (nunca nas preferências): a chave só é
// gravada quando o usuário clica em "Salvar e recarregar" (localStorage 'dm.config', com o prefixo de ?db=).

import { formatDateTime, formatRelativeTime } from '../../core/dates.js';
import { cx, h } from '../../core/dom.js';
import { SCHEMA_VERSION } from '../../data/schema.js';
import { createSupabaseRemote } from '../../data/remote-supabase.js';
import { CATEGORIES } from '../../domain/statuses.js';
import { accountButton, currentSession, openAccountDialog } from '../auth.js';
import { button, field, numberInput, segmented, switchInput, textInput } from '../kit/controls.js';
import { alertBox, emptyState, statusBadge } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { confirmDialog, openModal, toast } from '../kit/overlays.js';
import { syncDetails } from '../shell.js';
import { rekeyBackup } from '../../boot.js';
import { deleteTemplate, listTemplates, openTemplateDialog, renameTemplate } from '../templates.js';

const TRASH_LIMIT = 30;

/** Seções da página (âncoras do índice no topo). */
const SECTIONS = Object.freeze([
  { id: 'conta', label: 'Conta e sincronização', icon: 'cloud' },
  { id: 'preferencias', label: 'Preferências', icon: 'settings' },
  { id: 'dados', label: 'Dados', icon: 'download' },
  { id: 'modelos', label: 'Modelos', icon: 'copy' },
  { id: 'status', label: 'Status', icon: 'circle-dot' },
  { id: 'sobre', label: 'Sobre', icon: 'info' },
]);

/** Estado transitório da tela, por app (formulário do Supabase, teste de conexão, lixeira expandida). */
const transient = new WeakMap();

function stateOf(app) {
  let st = transient.get(app);
  if (!st) {
    const config = app.env && app.env.config ? app.env.config : null;
    st = {
      url: config ? config.supabaseUrl : '',
      key: config ? config.supabaseKey : '',
      test: null,
      testing: false,
      importing: false,
      trashAll: false,
    };
    transient.set(app, st);
  }
  return st;
}

const rerender = (app) => {
  if (app.ui && typeof app.ui.rerender === 'function') app.ui.rerender();
};

function errorText(err) {
  const text = err && typeof err.message === 'string' && err.message ? err.message : String(err || 'Erro desconhecido.');
  return text.replace(/^importData:\s*/, '');
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

/**
 * Testa a conexão com um projeto Supabase (URL + chave pública) e explica o resultado em pt-BR.
 * @param {object} app
 * @param {string} url
 * @param {string} key
 * @returns {Promise<{ ok: boolean, tone: 'success'|'warning'|'danger', title: string, text: string }>}
 */
export async function testSupabaseConnection(app, url, key) {
  const cleanUrl = String(url || '').trim();
  const cleanKey = String(key || '').trim();
  if (!cleanUrl || !cleanKey) return { ok: false, tone: 'danger', title: 'Informe a URL e a chave pública.', text: 'As duas ficam no painel do Supabase, em Project Settings → API.' };
  let parsed = null;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return { ok: false, tone: 'danger', title: 'A URL não parece válida.', text: 'Use o endereço do projeto, como https://abcdefghijkl.supabase.co.' };
  }
  const remote = app.env && typeof app.env.createRemote === 'function' ? app.env.createRemote(cleanUrl, cleanKey) : createSupabaseRemote({ url: cleanUrl, key: cleanKey, sessionStore: { get: () => null, set() {} } });
  const ping = await remote.ping();
  if (!ping.ok) {
    const err = ping.error || {};
    const byKind = {
      network: 'Confira a URL e a internet. Se a URL estiver certa, o projeto pode estar pausado no Supabase.',
      config: 'Confira se a chave é a pública ("anon" ou "publishable") do mesmo projeto da URL.',
      auth: 'Confira se a chave é a pública ("anon" ou "publishable") do mesmo projeto da URL.',
    };
    // Respondeu, mas não como o Supabase (404, página HTML, corpo que não é JSON): a URL é de outro servidor.
    // O corpo da resposta nunca vai para a mensagem — pode ser uma página HTML inteira.
    const notSupabase = err.kind !== 'config' && (err.status === 404 || typeof err.details === 'string' || err.code === 'unexpected_response');
    if (notSupabase) {
      return { ok: false, tone: 'danger', title: 'Esta URL não é de um projeto Supabase.', text: 'Use o endereço do projeto, como https://abcdefghijkl.supabase.co (no painel do Supabase, em Project Settings → API).' };
    }
    if (err.kind === 'network') {
      // A dica genérica de rede da sincronização ("as alterações serão enviadas…") não serve para um teste de URL.
      const title = err.code === 'timeout' && err.message ? err.message : 'Não foi possível alcançar esta URL.';
      return { ok: false, tone: 'danger', title, text: byKind.network };
    }
    return { ok: false, tone: 'danger', title: err.message || 'Não foi possível conectar.', text: err.hint || byKind[err.kind] || 'Confira a URL e a chave e tente de novo.' };
  }
  const latency = Number.isFinite(ping.latencyMs) ? ` (${ping.latencyMs} ms)` : '';
  // A consulta da versão do banco exige login: usa o cliente do app quando ele aponta para o mesmo projeto.
  const sameProject = app.remote && app.remote.configured && typeof app.remote.url === 'string' && app.remote.url.replace(/\/+$/, '') === cleanUrl.replace(/\/+$/, '');
  const versionSource = sameProject && currentSession(app) ? app.remote : remote;
  let version = null;
  try {
    version = await versionSource.schemaVersion();
  } catch (err) {
    if (err && err.kind === 'auth') {
      return { ok: true, tone: 'success', title: `Conexão funcionando${latency}.`, text: 'A chave foi aceita. A versão do banco do servidor é conferida quando você entra na conta.' };
    }
    return { ok: false, tone: 'danger', title: `A conexão funcionou, mas a consulta ao banco falhou: ${errorText(err)}`, text: err && err.hint ? err.hint : 'Tente de novo em instantes.' };
  }
  if (version === null) {
    return { ok: false, tone: 'warning', title: `Conexão funcionando${latency}, mas o banco ainda não foi preparado.`, text: 'Abra o SQL Editor do Supabase, execute o arquivo supabase/schema.sql inteiro e teste de novo.' };
  }
  if (version < SCHEMA_VERSION) {
    return { ok: false, tone: 'warning', title: `O banco do servidor está desatualizado (versão ${version}; este app precisa da ${SCHEMA_VERSION}).`, text: 'Execute de novo o arquivo supabase/schema.sql inteiro no SQL Editor do Supabase (não apaga dados).' };
  }
  if (version > SCHEMA_VERSION) {
    return { ok: true, tone: 'warning', title: `Conexão funcionando${latency}. O banco do servidor é mais novo (versão ${version}) que este app.`, text: 'Atualize o aplicativo neste dispositivo para evitar incompatibilidades.' };
  }
  return { ok: true, tone: 'success', title: `Conexão funcionando${latency}.`, text: `Banco do servidor na versão ${version}. Salve para ligar a sincronização.` };
}

async function runTest(app) {
  const st = stateOf(app);
  if (st.testing) return;
  st.testing = true;
  st.test = null;
  rerender(app);
  try {
    st.test = await testSupabaseConnection(app, st.url, st.key);
  } catch (err) {
    st.test = { ok: false, tone: 'danger', title: 'Não foi possível testar a conexão.', text: errorText(err) };
  } finally {
    st.testing = false;
    rerender(app);
  }
}

function saveSupabase(app) {
  const st = stateOf(app);
  const url = st.url.trim().replace(/\/+$/, '');
  const key = st.key.trim();
  if (!url || !key) {
    toast('Informe a URL e a chave pública.', { tone: 'danger' });
    return;
  }
  if (!app.env || typeof app.env.saveConfig !== 'function' || !app.env.saveConfig({ supabaseUrl: url, supabaseKey: key })) {
    toast('Não foi possível gravar a configuração.', { tone: 'danger' });
    return;
  }
  toast('Configuração salva. Recarregando…', { tone: 'success' });
  setTimeout(() => app.env.reload(), 300);
}

async function removeSupabase(app) {
  const ok = await confirmDialog({
    title: 'Remover a configuração do Supabase?',
    message: 'Este navegador deixa de sincronizar e volta a usar os dados do modo local. Nada é apagado do servidor nem deste navegador.',
    confirmLabel: 'Remover',
    danger: true,
  });
  if (!ok || !app.env) return;
  app.env.saveConfig(null);
  toast('Configuração removida. Recarregando…');
  setTimeout(() => app.env.reload(), 300);
}

async function redownload(app) {
  if (!app.sync) return;
  const ok = await confirmDialog({
    title: 'Baixar tudo de novo?',
    message: 'Todos os registros da conta serão recebidos outra vez do servidor e mesclados com os deste dispositivo. Nada local é perdido.',
    confirmLabel: 'Baixar tudo',
  });
  if (!ok) return;
  try {
    await app.sync.resetCursors();
    const result = await app.sync.syncNow({ reason: 'manual' });
    if (result && result.ok) toast(`Pronto: ${plural(result.pulled || 0, 'registro atualizado', 'registros atualizados')}.`, { tone: 'success' });
    else toast(result && result.error ? result.error.message : 'A sincronização não terminou. Veja os detalhes acima.', { tone: 'warn' });
  } catch (err) {
    toast(errorText(err), { tone: 'danger' });
  }
}

function setSetting(app, key, value) {
  try {
    app.cmd.setSetting(key, value);
  } catch (err) {
    toast(errorText(err), { tone: 'danger' });
    rerender(app);
  }
}

/**
 * Baixa um texto como arquivo (sem servidor: Blob + link temporário).
 * @param {string} filename
 * @param {string} text
 * @param {string} [type]
 */
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Exporta o banco local inteiro como backup JSON (download).
 * @param {object} app
 * @returns {string} nome do arquivo
 */
export function exportBackup(app) {
  // O backup registra de qual conta veio: importado em OUTRA conta, ele vira uma cópia com ids novos.
  const accountId = currentAccountId(app);
  const session = currentSession(app);
  const data = { ...app.store.exportData(), account: accountId ? { id: accountId, email: session && session.user ? session.user.email || null : null } : null };
  const filename = `demand-manager-backup-${app.clock.today()}.json`;
  downloadText(filename, JSON.stringify(data, null, 2));
  const rows = Object.values(data.tables || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  toast(`Backup exportado (${plural(rows, 'registro', 'registros')}).`, { tone: 'success' });
  return filename;
}

/** Conta dona do banco aberto (com sessão, ou a última conta quando a sessão se perdeu); null no modo local. */
function currentAccountId(app) {
  const session = currentSession(app);
  if (session && session.user && session.user.id) return session.user.id;
  const last = app && app.env ? app.env.lastAccount : null;
  return last && typeof last.id === 'string' && last.id ? last.id : null;
}

/**
 * O backup veio de OUTRA conta? Os registros dele pertencem àquela conta no servidor: importados como estão,
 * nunca sincronizariam (o servidor recusa — RLS). Nesse caso a importação usa ids novos (rekeyBackup).
 */
export function backupFromOtherAccount(app, data) {
  const target = currentAccountId(app);
  const source = data && data.account && typeof data.account.id === 'string' ? data.account.id : null;
  return !!(target && source && source !== target);
}

function backupCounts(data) {
  const t = data && data.tables && typeof data.tables === 'object' ? data.tables : {};
  const len = (name) => (Array.isArray(t[name]) ? t[name].filter((row) => row && !row.deleted_at).length : 0);
  return { projects: len('projects'), demands: len('demands'), tasks: len('tasks') };
}

export async function importBackupFile(app, file) {
  const st = stateOf(app);
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('O arquivo escolhido não é um JSON válido.', { tone: 'danger' });
    return;
  }
  if (!data || typeof data !== 'object' || !data.tables) {
    toast('O arquivo não é um backup do Demand Manager.', { tone: 'danger' });
    return;
  }
  const counts = backupCounts(data);
  const foreign = backupFromOtherAccount(app, data);
  let mode = 'merge';
  let dialog = null;
  const run = async (close) => {
    if (mode === 'replace') {
      const sure = await confirmDialog({
        title: 'Substituir todos os dados?',
        message: 'Tudo o que existe neste dispositivo será trocado pelo conteúdo do backup. Exporte um backup atual antes, se tiver dúvida.',
        confirmLabel: 'Substituir',
        danger: true,
      });
      if (!sure) return;
    }
    close('import');
    st.importing = true;
    rerender(app);
    try {
      const result = await app.store.importData(foreign ? rekeyBackup(data) : data, { mode });
      toast(`Backup importado: ${plural(result.changed || 0, 'registro alterado', 'registros alterados')} de ${result.total || 0}.`, { tone: 'success' });
    } catch (err) {
      toast(`Não foi possível importar: ${errorText(err)}`, { tone: 'danger' });
    } finally {
      st.importing = false;
      rerender(app);
    }
  };
  dialog = openModal({
    title: 'Importar backup',
    size: 'sm',
    class: 'v-config-import',
    render: () =>
      h(
        'div',
        { class: 'col gap-3' },
        h('p', { class: 'muted' }, `Arquivo “${file.name}”: ${plural(counts.projects, 'projeto', 'projetos')}, ${plural(counts.demands, 'demanda', 'demandas')} e ${plural(counts.tasks, 'tarefa', 'tarefas')}${data.exportedAt ? `, exportado em ${formatDateTime(data.exportedAt)}` : ''}.`),
        segmented({
          value: mode,
          ariaLabel: 'Como importar',
          options: [
            { value: 'merge', label: 'Mesclar' },
            { value: 'replace', label: 'Substituir tudo' },
          ],
          onchange: (value) => {
            mode = value;
            dialog.update();
          },
        }),
        h(
          'p',
          { class: 'text-sm muted' },
          mode === 'merge'
            ? 'Mesclar: junta o backup aos dados atuais, campo a campo; vale a alteração mais recente de cada campo.'
            : app.sync && app.store.hasServerRows && app.store.hasServerRows()
              ? 'Substituir: restaura o backup. Os valores do backup prevalecem, itens que não estão nele vão para a lixeira e a restauração é enviada aos outros dispositivos.'
              : 'Substituir: apaga os dados deste dispositivo e fica só com o conteúdo do backup.',
        ),
        foreign
          ? alertBox({
              tone: 'warning',
              text: `Este backup foi exportado de outra conta${data.account && data.account.email ? ` (${data.account.email})` : ''}. Ele entra como uma cópia independente, com identificadores novos, para poder sincronizar com esta conta.`,
            })
          : null,
      ),
    actions: () => [
      { label: 'Cancelar', onclick: (close) => close(null) },
      { label: 'Importar', variant: mode === 'replace' ? 'danger' : 'primary', onclick: (close) => run(close) },
    ],
  });
}

function pickBackupFile(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) importBackupFile(app, file);
  });
  input.click();
}

/** Rótulos e ícones de cada tipo de item da lixeira. */
const TRASH_TYPES = Object.freeze({
  project: { label: 'Projeto', icon: 'folder', restored: 'Projeto restaurado', deleted: 'Projeto excluído' },
  demand: { label: 'Demanda', icon: 'layers', restored: 'Demanda restaurada', deleted: 'Demanda excluída' },
  task: { label: 'Tarefa', icon: 'circle', restored: 'Tarefa restaurada', deleted: 'Tarefa excluída' },
});
const trashType = (type) => TRASH_TYPES[type] || TRASH_TYPES.task;

function restore(app, item) {
  try {
    if (item.type === 'project') app.cmd.restoreProject(item.entity.id);
    else if (item.type === 'demand') app.cmd.restoreDemand(item.entity.id);
    else app.cmd.restoreTask(item.entity.id);
    toast(trashType(item.type).restored, {
      tone: 'success',
      action: app.ui && item.type !== 'project' ? { label: 'Abrir', onclick: () => app.ui.openPanel(item.type, item.entity.id) } : undefined,
    });
  } catch (err) {
    toast(errorText(err), { tone: 'danger' });
  }
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function section(id, title, description, ...children) {
  return h(
    'section',
    { class: 'v-config-section', id: `config-${id}`, key: id, 'data-section': id, 'aria-labelledby': `config-${id}-title` },
    h('header', { class: 'v-config-section-head' }, h('h2', { class: 'v-config-section-title', id: `config-${id}-title` }, title), description ? h('p', { class: 'v-config-section-desc' }, description) : null),
    h('div', { class: 'v-config-card' }, children),
  );
}

function settingRow(label, hint, control, { key, stack = false } = {}) {
  return h(
    'div',
    { class: cx('v-config-row', stack && 'is-stacked'), key: key || label },
    h('div', { class: 'v-config-row-text' }, h('div', { class: 'v-config-row-label' }, label), hint ? h('div', { class: 'v-config-row-hint' }, hint) : null),
    h('div', { class: 'v-config-row-control' }, control),
  );
}

function renderToc() {
  return h(
    'nav',
    { class: 'v-config-toc', 'aria-label': 'Seções das configurações' },
    SECTIONS.map((s) =>
      h(
        'button',
        {
          type: 'button',
          key: s.id,
          class: 'v-config-toc-item',
          onclick: () => {
            const target = document.getElementById(`config-${s.id}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        icon(s.icon, { size: 14 }),
        h('span', null, s.label),
      ),
    ),
  );
}

function renderSupabaseForm(app) {
  const st = stateOf(app);
  const env = app.env || {};
  const config = env.config || null;
  const saved = config && config.source === 'local';
  const changed = !config || st.url.trim().replace(/\/+$/, '') !== config.supabaseUrl.replace(/\/+$/, '') || st.key.trim() !== config.supabaseKey;
  const sourceText = !config
    ? 'Sem configuração: os dados ficam só neste navegador.'
    : config.source === 'local'
      ? 'Valores gravados neste navegador.'
      : config.source === 'file'
        ? 'Valores vindos do arquivo config.js. Salvar aqui grava uma cópia neste navegador, que passa a ter prioridade.'
        : 'Configuração fornecida pelo ambiente de testes.';
  return h(
    'div',
    { class: 'v-config-form', 'data-config-form': 'supabase' },
    h(
      'div',
      { class: 'v-config-grid' },
      field(
        { label: 'URL do projeto', hint: 'Project Settings → API → Project URL' },
        textInput({
          type: 'url',
          value: st.url,
          placeholder: 'https://abcdefghijkl.supabase.co',
          attrs: { name: 'supabase-url', 'data-field': 'supabase-url', autocomplete: 'off' },
          oninput: (text) => {
            st.url = text;
            st.test = null;
            rerender(app);
          },
        }),
      ),
      field(
        { label: 'Chave pública (anon / publishable)', hint: 'Nunca use a chave service_role aqui.' },
        textInput({
          value: st.key,
          placeholder: 'eyJhbGciOi… ou sb_publishable_…',
          class: 'v-config-key',
          attrs: { name: 'supabase-key', 'data-field': 'supabase-key', autocomplete: 'off', spellcheck: false },
          oninput: (text) => {
            st.key = text;
            st.test = null;
            rerender(app);
          },
        }),
      ),
    ),
    h('p', { class: 'v-config-note' }, sourceText),
    st.test ? alertBox({ tone: st.test.tone, title: st.test.title, text: st.test.text, class: 'v-config-test' }) : null,
    h(
      'div',
      { class: 'v-config-actions' },
      button({ label: st.testing ? 'Testando…' : 'Testar conexão', icon: 'zap', size: 'sm', disabled: st.testing, onclick: () => runTest(app), attrs: { 'data-action': 'test-connection' } }),
      button({ label: 'Salvar e recarregar', icon: 'check', size: 'sm', variant: 'primary', disabled: !changed || !st.url.trim() || !st.key.trim(), onclick: () => saveSupabase(app), attrs: { 'data-action': 'save-config' } }),
      saved ? button({ label: 'Remover configuração', size: 'sm', variant: 'ghost', class: 'v-config-danger-text', onclick: () => removeSupabase(app) }) : null,
    ),
  );
}

function renderAccount(app) {
  const session = currentSession(app);
  const configured = !!(app.remote && app.remote.configured);
  if (!configured) return null;
  return settingRow(
    session ? 'Conta conectada' : 'Conta',
    session ? session.user.email || 'Conta conectada' : 'Entre com e-mail e senha para sincronizar entre dispositivos.',
    h('div', { class: 'row gap-2' }, session ? null : button({ label: 'Criar conta', size: 'sm', onclick: () => openAccountDialog(app, { mode: 'signup' }) }), accountButton(app)),
    { key: 'account' },
  );
}

function renderSyncBlock(app) {
  return h(
    'div',
    { class: 'v-config-sync' },
    syncDetails(app, {}),
    app.sync
      ? h('div', { class: 'v-config-actions' }, button({ label: 'Baixar tudo de novo', icon: 'download', size: 'sm', variant: 'ghost', onclick: () => redownload(app), attrs: { 'data-action': 'redownload' } }))
      : null,
  );
}

function renderAccountSection(app) {
  const env = app.env || {};
  if (env.demo) {
    return section(
      'conta',
      'Conta e sincronização',
      null,
      alertBox({ tone: 'info', title: 'Modo demonstração', text: 'Esta cópia usa dados de exemplo e nunca sincroniza. Para configurar a sincronização, abra o aplicativo sem “?demo=1”.' }),
    );
  }
  return section('conta', 'Conta e sincronização', 'Use o Supabase (gratuito) para ter os mesmos dados no computador e no celular.', renderSupabaseForm(app), renderAccount(app), h('div', { class: 'v-config-divider' }), renderSyncBlock(app));
}

function renderPreferences(app) {
  const theme = app.ui && typeof app.ui.theme === 'function' ? app.ui.theme() : 'system';
  const s = (key) => app.settings.get(key);
  return section(
    'preferencias',
    'Preferências',
    'O tema vale só para este dispositivo; as demais preferências sincronizam com a sua conta.',
    settingRow(
      'Tema',
      'Claro, escuro ou igual ao do sistema.',
      segmented({
        value: theme,
        ariaLabel: 'Tema',
        size: 'sm',
        options: [
          { value: 'light', label: 'Claro', icon: 'sun' },
          { value: 'dark', label: 'Escuro', icon: 'moon' },
          { value: 'system', label: 'Sistema', icon: 'circle-half' },
        ],
        onchange: (value) => app.ui && app.ui.setTheme(value),
      }),
      { key: 'theme' },
    ),
    settingRow(
      'Responsável padrão',
      'Preenchido nas demandas e tarefas novas.',
      textInput({ value: s('owner.default') || '', placeholder: 'Ex.: Ana', size: 'sm', attrs: { 'data-field': 'owner-default' }, onchange: (text) => setSetting(app, 'owner.default', text.trim()) }),
      { key: 'owner' },
    ),
    settingRow(
      'Horas de trabalho por dia',
      'Usado para estimar prazos de cadeias de dependências.',
      numberInput({ value: s('capacity.hoursPerDay'), min: 0.5, max: 24, step: 0.5, suffix: 'h', size: 'sm', ariaLabel: 'Horas de trabalho por dia', attrs: { 'data-field': 'hours-day' }, onchange: (n) => n !== null && setSetting(app, 'capacity.hoursPerDay', n) }),
      { key: 'hpd' },
    ),
    settingRow(
      'Horas de trabalho por semana',
      'Capacidade usada no planejamento da semana.',
      numberInput({ value: s('capacity.hoursPerWeek'), min: 1, max: 168, step: 1, suffix: 'h', size: 'sm', ariaLabel: 'Horas de trabalho por semana', attrs: { 'data-field': 'hours-week' }, onchange: (n) => n !== null && setSetting(app, 'capacity.hoursPerWeek', n) }),
      { key: 'hpw' },
    ),
    settingRow(
      'Dias para “próxima do vencimento”',
      'Itens com prazo dentro deste número de dias ganham o aviso.',
      numberInput({ value: s('deadline.soonDays'), min: 0, max: 60, step: 1, suffix: 'dias', size: 'sm', ariaLabel: 'Dias para “próxima do vencimento”', attrs: { 'data-field': 'soon-days' }, onchange: (n) => n !== null && setSetting(app, 'deadline.soonDays', Math.round(n)) }),
      { key: 'soon' },
    ),
    settingRow(
      'Iniciar a demanda automaticamente',
      'Quando uma tarefa entra em andamento, a demanda em backlog/planejada passa para “Em andamento” (com registro no histórico).',
      switchInput({ checked: s('workflow.autoStartDemand') !== false, ariaLabel: 'Iniciar a demanda automaticamente', onchange: (on) => setSetting(app, 'workflow.autoStartDemand', on) }),
      { key: 'auto' },
    ),
  );
}

function renderTrash(app) {
  const st = stateOf(app);
  const items = app.sel.trash();
  if (!items.length) return emptyState({ icon: 'trash', title: 'Lixeira vazia', text: 'Projetos, demandas e tarefas excluídos aparecem aqui e podem ser restauradas.', compact: true });
  const now = app.clock.now();
  const shown = st.trashAll ? items : items.slice(0, TRASH_LIMIT);
  return h(
    'div',
    { class: 'v-config-trash' },
    h(
      'ul',
      { class: 'v-config-trash-list' },
      shown.map((item) =>
        h(
          'li',
          { key: `${item.type}:${item.entity.id}`, class: 'v-config-trash-item', 'data-trash': `${item.type}:${item.entity.id}` },
          h('span', { class: 'v-config-trash-icon', title: trashType(item.type).label }, icon(trashType(item.type).icon, { size: 14 })),
          h(
            'span',
            { class: 'v-config-trash-main' },
            h(
              'span',
              { class: 'v-config-trash-name truncate' },
              item.type !== 'project' && app.sel.code(item.type, item.entity) ? h('span', { class: 'v-config-code tabular' }, app.sel.code(item.type, item.entity)) : null,
              item.entity.name || 'Sem nome',
            ),
            h('span', { class: 'v-config-trash-when' }, `${trashType(item.type).deleted} ${formatRelativeTime(item.deletedAt, now)}`),
          ),
          button({ label: 'Restaurar', icon: 'rotate-ccw', size: 'sm', onclick: () => restore(app, item), attrs: { 'data-action': 'restore' } }),
        ),
      ),
    ),
    items.length > shown.length
      ? button({
          label: `Mostrar todos (${items.length})`,
          size: 'sm',
          variant: 'ghost',
          onclick: () => {
            st.trashAll = true;
            rerender(app);
          },
        })
      : null,
  );
}

function renderData(app) {
  const st = stateOf(app);
  return section(
    'dados',
    'Dados',
    'Os dados ficam no banco local deste navegador (e na sua conta, quando a sincronização está ligada).',
    settingRow(
      'Exportar backup',
      'Baixa um arquivo JSON com tudo: projetos, demandas, tarefas, tempo, planejamento, observações e histórico.',
      button({ label: 'Exportar', icon: 'download', size: 'sm', onclick: () => exportBackup(app), attrs: { 'data-action': 'export' } }),
      { key: 'export' },
    ),
    settingRow(
      'Importar backup',
      'Mescla com os dados atuais ou substitui tudo (você escolhe antes de confirmar).',
      button({ label: st.importing ? 'Importando…' : 'Importar…', icon: 'upload', size: 'sm', disabled: st.importing, onclick: () => pickBackupFile(app), attrs: { 'data-action': 'import' } }),
      { key: 'import' },
    ),
    h('div', { class: 'v-config-divider' }),
    h('div', { class: 'v-config-subtitle' }, 'Lixeira'),
    renderTrash(app),
  );
}

function renderTemplates(app) {
  const list = listTemplates(app);
  return section(
    'modelos',
    'Modelos',
    'Modelos criam uma demanda já com tarefas, subtarefas, durações e dependências. Para guardar um novo, use “Salvar como modelo…” no menu de uma demanda.',
    h(
      'ul',
      { class: 'v-config-tpl-list' },
      list.map((t) =>
        h(
          'li',
          { key: t.id, class: 'v-config-tpl', 'data-template': t.id },
          h('span', { class: 'v-config-tpl-icon' }, icon(t.builtin ? 'lock' : 'copy', { size: 14 })),
          h(
            'span',
            { class: 'v-config-tpl-main' },
            h('span', { class: 'v-config-tpl-name truncate' }, t.name),
            h('span', { class: 'v-config-tpl-meta' }, `${plural(t.tasks.length, 'tarefa', 'tarefas')}${t.builtin ? ' · embutido (somente leitura)' : ''}`),
          ),
          h(
            'span',
            { class: 'v-config-tpl-actions' },
            button({ label: 'Usar', icon: 'plus', size: 'sm', variant: 'ghost', onclick: () => openTemplateDialog(app, { templateId: t.id }), attrs: { 'data-action': 'use-template' } }),
            t.builtin
              ? null
              : [
                  button({ label: 'Renomear', icon: 'pencil', size: 'sm', variant: 'ghost', onclick: () => renameTemplate(app, t), attrs: { 'data-action': 'rename-template' } }),
                  button({ label: 'Excluir', icon: 'trash', size: 'sm', variant: 'ghost', onclick: () => deleteTemplate(app, t), attrs: { 'data-action': 'delete-template' } }),
                ],
          ),
        ),
      ),
    ),
  );
}

function renderStatuses(app) {
  const list = app.sel.statuses();
  return section(
    'status',
    'Status',
    'Toda a lógica do aplicativo usa a categoria de cada status. A personalização (nomes, cores e novos status) virá numa próxima versão.',
    h(
      'ul',
      { class: 'v-config-status-list' },
      list.map((status) =>
        h(
          'li',
          { key: status.id, class: 'v-config-status' },
          statusBadge(status),
          h('span', { class: 'v-config-status-cat' }, (CATEGORIES[status.category] && CATEGORIES[status.category].label) || status.category || '—'),
          h('span', { class: 'v-config-status-desc' }, status.description || ''),
        ),
      ),
    ),
  );
}

function renderAbout(app) {
  const env = app.env || {};
  const rows = [
    ['Versão do aplicativo', env.version || '—'],
    ['Versão do banco de dados', String(SCHEMA_VERSION)],
    ['Banco local', env.dbName || (app.store && app.store.dbName) || '—'],
    ['Identificador deste dispositivo', app.deviceId || '—'],
  ];
  return section(
    'sobre',
    'Sobre',
    null,
    h('dl', { class: 'v-config-about' }, rows.map(([label, value]) => h('div', { class: 'v-config-about-row', key: label }, h('dt', null, label), h('dd', { class: 'mono' }, value)))),
    h(
      'p',
      { class: 'v-config-note' },
      'O script do servidor fica no arquivo supabase/schema.sql, dentro da pasta do aplicativo. Para preparar (ou atualizar) o Supabase, copie o conteúdo inteiro e execute-o no SQL Editor do projeto — ele pode ser executado de novo sem perder dados.',
    ),
    h('div', { class: 'v-config-actions' }, button({ label: 'Atalhos de teclado', icon: 'keyboard', size: 'sm', variant: 'ghost', onclick: () => app.ui && app.ui.showHelp && app.ui.showHelp() })),
  );
}

export default {
  id: 'config',
  path: '/config',
  title: 'Configurações',
  icon: 'settings',
  order: 110,
  section: 'system',
  /**
   * Desenha a tela de Configurações.
   * @param {object} app
   * @param {{ isMobile?: boolean }} ctx
   * @returns {HTMLElement}
   */
  render(app, ctx) {
    return h(
      'div',
      { class: cx('v-config', ctx && ctx.isMobile && 'is-mobile') },
      h('div', { class: 'v-config-inner' }, renderToc(), renderAccountSection(app), renderPreferences(app), renderData(app), renderTemplates(app), renderStatuses(app), renderAbout(app)),
    );
  },
};
