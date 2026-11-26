// Conta: entrar (e-mail + senha), criar conta, "esqueci minha senha" e sair.
//
//   openAccountDialog(app)                    // escolhe a tela conforme haja sessão ou não
//   openAccountDialog(app, { mode: 'signup' })
//
// Depois de entrar ou sair a página é recarregada: o boot abre o banco certo ('dm-<usuário>' ou 'dm-local').
// A senha nunca é guardada: fica só no campo do formulário enquanto o diálogo está aberto.

import { cx, h } from '../core/dom.js';
import { button, field, segmented, textInput } from './kit/controls.js';
import { alertBox, avatar } from './kit/display.js';
import { confirmDialog, openModal, toast } from './kit/overlays.js';

const MIN_PASSWORD = 6;

/** Mensagem legível de uma falha (RemoteError já vem em pt-BR). */
function failureText(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return 'Não foi possível falar com o servidor. Tente de novo.';
}

/** Recarrega a página pelo ambiente do app (boot), ou direto pela janela. */
function reloadApp(app) {
  if (app && app.env && typeof app.env.reload === 'function') app.env.reload();
  else globalThis.location.reload();
}

/** "Sair" é explícito: o próximo início abre o modo local, não o banco desta conta. */
function forgetAccount(app) {
  try {
    if (app && app.env && typeof app.env.forgetAccount === 'function') app.env.forgetAccount();
  } catch {
    /* sem armazenamento */
  }
}

/** Conta cujo banco está aberto sem sessão (sessão perdida sem "Sair"), ou null. */
function lostAccount(app) {
  const last = app && app.env ? app.env.lastAccount : null;
  return last && typeof last.id === 'string' ? last : null;
}

/**
 * Sessão atual (ou null), sem lançar erro.
 * @param {object} app
 * @returns {{ user: { id: string, email: string|null } }|null}
 */
export function currentSession(app) {
  try {
    return app && app.remote && app.remote.configured ? app.remote.auth.session() : null;
  } catch {
    return null;
  }
}

/**
 * Texto curto da conta para a barra lateral: e-mail, "Entrar" ou "Modo local".
 * @param {object} app
 * @returns {{ label: string, detail: string, signedIn: boolean, configured: boolean }}
 */
export function accountSummary(app) {
  const configured = !!(app && app.remote && app.remote.configured);
  const session = currentSession(app);
  if (app && app.env && app.env.demo) return { label: 'Demonstração', detail: 'Dados de exemplo neste navegador', signedIn: false, configured };
  if (session) return { label: session.user.email || 'Conta conectada', detail: 'Sincronizando entre dispositivos', signedIn: true, configured };
  const lost = configured ? lostAccount(app) : null;
  if (lost) return { label: 'Entrar', detail: `Sessão encerrada — entre de novo${lost.email ? ` como ${lost.email}` : ''}`, signedIn: false, configured };
  if (configured) return { label: 'Entrar', detail: 'Para sincronizar entre dispositivos', signedIn: false, configured };
  return { label: 'Modo local', detail: 'Dados só neste navegador', signedIn: false, configured };
}

/**
 * Sai da conta (depois de confirmar) e recarrega a página.
 * @param {object} app
 * @returns {Promise<boolean>} true quando saiu
 */
export async function signOut(app) {
  const pending = app.store && typeof app.store.pendingCount === 'function' ? app.store.pendingCount() : 0;
  const ok = await confirmDialog({
    title: 'Sair da conta?',
    message:
      pending > 0
        ? `Há ${pending} ${pending === 1 ? 'alteração ainda não enviada' : 'alterações ainda não enviadas'} ao servidor. Elas continuam guardadas neste navegador e serão enviadas quando você entrar de novo.`
        : 'Os dados da conta continuam guardados neste navegador e voltam a sincronizar quando você entrar de novo.',
    confirmLabel: 'Sair',
  });
  if (!ok) return false;
  // Esquece a conta ANTES de apagar a sessão: a casca distingue "Sair" de sessão expirada por isso.
  forgetAccount(app);
  try {
    if (app.sync) app.sync.stop();
    await app.remote.auth.signOut();
  } catch (err) {
    toast(failureText(err), { tone: 'danger' });
  }
  reloadApp(app);
  return true;
}

/**
 * Abre o diálogo da conta.
 * - sem Supabase configurado: explica e leva a Configurações;
 * - com sessão: mostra o e-mail e o botão Sair;
 * - sem sessão: Entrar | Criar conta, com "Esqueci minha senha".
 * @param {object} app
 * @param {{ mode?: 'signin'|'signup'|'recover' }} [options]
 * @returns {{ close: Function, update: Function }|null} controle do diálogo
 */
export function openAccountDialog(app, { mode = 'signin' } = {}) {
  const remote = app && app.remote;
  const session = currentSession(app);

  if (app && app.env && app.env.demo) {
    return openModal({
      title: 'Modo demonstração',
      body: 'Esta é uma cópia de demonstração com dados de exemplo. Ela nunca sincroniza nem usa conta. Abra o aplicativo sem “?demo=1” para usar os seus dados.',
      actions: [{ label: 'Entendi', variant: 'primary' }],
    });
  }

  if (!remote || !remote.configured) {
    return openModal({
      title: 'Conta e sincronização',
      class: 'auth-dialog',
      body: h(
        'div',
        { class: 'col gap-3' },
        h('p', { class: 'muted' }, 'Hoje os seus dados ficam só neste navegador (modo local).'),
        h('p', { class: 'muted' }, 'Para usar o Demand Manager em vários dispositivos, informe a URL e a chave pública do seu projeto Supabase em Configurações → Conta e sincronização. Depois é só entrar com e-mail e senha.'),
      ),
      actions: [
        { label: 'Fechar' },
        {
          label: 'Abrir Configurações',
          variant: 'primary',
          onclick: (close) => {
            close('navigate');
            if (app.ui) app.ui.navigate('/config');
          },
        },
      ],
    });
  }

  if (session) {
    return openModal({
      title: 'Sua conta',
      class: 'auth-dialog',
      body: h(
        'div',
        { class: 'auth-account' },
        avatar(session.user.email || 'Conta', { size: 36 }),
        h('div', { class: 'col gap-1' }, h('div', { class: 'strong truncate', 'data-account-email': 'true' }, session.user.email || 'Conta conectada'), h('div', { class: 'muted text-sm' }, 'Os dados sincronizam entre os dispositivos em que você entrar com esta conta.')),
      ),
      actions: [
        { label: 'Fechar' },
        {
          label: 'Sair',
          icon: 'logout',
          onclick: (close) => {
            close('signout');
            signOut(app);
          },
        },
      ],
    });
  }

  // Sessão perdida sem "Sair": sugere entrar de novo na mesma conta (o banco aberto é o dela).
  const lost = lostAccount(app);
  const form = {
    mode: ['signin', 'signup', 'recover'].includes(mode) ? mode : 'signin',
    email: lost && lost.email ? lost.email : '',
    password: '',
    confirm: '',
    busy: false,
    error: '',
    info: lost ? 'Sua sessão foi encerrada. Entre de novo para enviar as alterações guardadas neste dispositivo.' : '',
  };
  let dialog = null;

  const titles = { signin: 'Entrar', signup: 'Criar conta', recover: 'Recuperar a senha' };

  async function submit(close) {
    if (form.busy) return;
    form.error = '';
    form.info = '';
    const email = form.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      form.error = 'Informe um e-mail válido.';
      dialog.update();
      return;
    }
    if (form.mode !== 'recover') {
      if (!form.password) {
        form.error = 'Informe a senha.';
        dialog.update();
        return;
      }
      if (form.mode === 'signup' && form.password.length < MIN_PASSWORD) {
        form.error = `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
        dialog.update();
        return;
      }
      if (form.mode === 'signup' && form.password !== form.confirm) {
        form.error = 'As senhas não conferem.';
        dialog.update();
        return;
      }
    }
    form.busy = true;
    dialog.update();
    try {
      if (form.mode === 'signin') {
        await remote.auth.signIn(email, form.password);
        form.password = '';
        close('signed-in');
        toast('Conectado. Abrindo os dados da conta…', { tone: 'success' });
        reloadApp(app);
        return;
      }
      if (form.mode === 'signup') {
        const outcome = await remote.auth.signUp(email, form.password);
        form.password = '';
        form.confirm = '';
        if (outcome && outcome.session) {
          close('signed-up');
          toast('Conta criada. Abrindo os dados da conta…', { tone: 'success' });
          reloadApp(app);
          return;
        }
        form.mode = 'signin';
        form.info = 'Conta criada. Confirme o e-mail pelo link que enviamos e depois entre com a sua senha.';
      } else {
        await remote.auth.recover(email);
        form.mode = 'signin';
        form.info = 'Se houver uma conta com este e-mail, enviamos um link para criar uma senha nova.';
      }
    } catch (err) {
      form.error = failureText(err);
      if (err && err.hint) form.error += ` ${err.hint}`;
    } finally {
      form.busy = false;
      dialog.update();
    }
  }

  const passwordField = (label, key, autocomplete, close) =>
    field(
      { label },
      textInput({
        type: 'password',
        value: form[key],
        disabled: form.busy,
        attrs: { autocomplete, name: key === 'confirm' ? 'password-confirm' : 'password', 'data-field': key },
        oninput: (text) => {
          form[key] = text;
        },
        onenter: () => submit(close),
      }),
    );

  dialog = openModal({
    title: 'Conta',
    size: 'sm',
    class: 'auth-dialog',
    render: (close) =>
      h(
        'form',
        {
          class: cx('auth-form', 'col', 'gap-3'),
          'data-auth-mode': form.mode,
          novalidate: true,
          onsubmit: (ev) => {
            ev.preventDefault();
            submit(close);
          },
        },
        form.mode === 'recover'
          ? h('p', { class: 'muted' }, 'Informe o e-mail da conta. Enviaremos um link para você criar uma senha nova.')
          : segmented({
              value: form.mode,
              ariaLabel: 'Entrar ou criar conta',
              class: 'auth-switch',
              options: [
                { value: 'signin', label: 'Entrar' },
                { value: 'signup', label: 'Criar conta' },
              ],
              onchange: (value) => {
                form.mode = value;
                form.error = '';
                form.info = '';
                dialog.update();
              },
            }),
        form.info ? alertBox({ tone: 'success', text: form.info }) : null,
        form.error ? alertBox({ tone: 'danger', text: form.error }) : null,
        field(
          { label: 'E-mail' },
          textInput({
            type: 'email',
            value: form.email,
            autofocus: true,
            disabled: form.busy,
            placeholder: 'voce@exemplo.com',
            attrs: { autocomplete: 'username', name: 'email', inputmode: 'email', 'data-field': 'email' },
            oninput: (text) => {
              form.email = text;
            },
            onenter: () => submit(close),
          }),
        ),
        form.mode === 'recover' ? null : passwordField('Senha', 'password', form.mode === 'signup' ? 'new-password' : 'current-password', close),
        form.mode === 'signup' ? passwordField('Repita a senha', 'confirm', 'new-password', close) : null,
        form.mode === 'signin'
          ? h(
              'button',
              {
                type: 'button',
                class: 'auth-link',
                onclick: () => {
                  form.mode = 'recover';
                  form.error = '';
                  form.info = '';
                  dialog.update();
                },
              },
              'Esqueci minha senha',
            )
          : form.mode === 'recover'
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'auth-link',
                  onclick: () => {
                    form.mode = 'signin';
                    form.error = '';
                    dialog.update();
                  },
                },
                'Voltar para entrar',
              )
            : null,
        // Enter dentro do formulário envia (botão invisível de envio).
        h('button', { type: 'submit', hidden: true, tabindex: -1 }),
      ),
    actions: () => [
      { label: 'Cancelar', onclick: (close) => close(null) },
      {
        label: form.busy ? 'Aguarde…' : titles[form.mode] === 'Recuperar a senha' ? 'Enviar link' : titles[form.mode],
        variant: 'primary',
        disabled: form.busy,
        onclick: (close) => submit(close),
      },
    ],
  });
  return dialog;
}

/**
 * "Nova senha": aberto pelo boot quando o usuário volta do link de recuperação de senha (já com a sessão que o
 * link trouxe). Grava a senha nova pelo cliente do Supabase (remote.auth.updatePassword → PUT /auth/v1/user).
 * @param {object} app
 * @returns {{ close: Function, update: Function }|null}
 */
export function openNewPasswordDialog(app) {
  const remote = app && app.remote;
  const session = currentSession(app);
  if (!remote || !session) return null;
  const form = { password: '', confirm: '', busy: false, error: '' };
  let dialog = null;

  async function submit(close) {
    if (form.busy) return;
    form.error = '';
    if (form.password.length < MIN_PASSWORD) form.error = `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
    else if (form.password !== form.confirm) form.error = 'As senhas não conferem.';
    else if (!remote.auth || typeof remote.auth.updatePassword !== 'function') {
      form.error = 'Esta versão do app ainda não consegue gravar a senha nova. Você já entrou na conta pelo link; troque a senha pelo painel do Supabase ou tente de novo depois de atualizar o app.';
    }
    if (form.error) {
      dialog.update();
      return;
    }
    form.busy = true;
    dialog.update();
    try {
      await remote.auth.updatePassword(form.password);
      form.password = '';
      form.confirm = '';
      close('updated');
      toast('Senha alterada. Use a senha nova para entrar nos outros dispositivos.', { tone: 'success' });
    } catch (err) {
      form.error = failureText(err) + (err && err.hint ? ` ${err.hint}` : '');
    } finally {
      form.busy = false;
      if (dialog) dialog.update();
    }
  }

  const passwordField = (label, key, close) =>
    field(
      { label },
      textInput({
        type: 'password',
        value: form[key],
        disabled: form.busy,
        autofocus: key === 'password',
        attrs: { autocomplete: 'new-password', name: key === 'confirm' ? 'password-confirm' : 'password', 'data-field': key === 'confirm' ? 'confirm' : 'new-password' },
        oninput: (text) => {
          form[key] = text;
        },
        onenter: () => submit(close),
      }),
    );

  dialog = openModal({
    title: 'Criar uma senha nova',
    size: 'sm',
    class: cx('auth-dialog', 'auth-new-password'),
    render: (close) =>
      h(
        'form',
        {
          class: cx('auth-form', 'col', 'gap-3'),
          'data-auth-mode': 'new-password',
          novalidate: true,
          onsubmit: (ev) => {
            ev.preventDefault();
            submit(close);
          },
        },
        h('p', { class: 'muted' }, `Você entrou pelo link de recuperação${session.user.email ? ` como ${session.user.email}` : ''}. Escolha a senha nova da conta.`),
        form.error ? alertBox({ tone: 'danger', text: form.error }) : null,
        passwordField('Senha nova', 'password', close),
        passwordField('Repita a senha nova', 'confirm', close),
        h('button', { type: 'submit', hidden: true, tabindex: -1 }),
      ),
    actions: () => [
      { label: 'Agora não', onclick: (close) => close(null) },
      { label: form.busy ? 'Aguarde…' : 'Salvar senha', variant: 'primary', disabled: form.busy, onclick: (close) => submit(close) },
    ],
  });
  return dialog;
}

/** Botão compacto "Entrar" / "Sair" (usado em Configurações). */
export function accountButton(app, { size = 'sm' } = {}) {
  const session = currentSession(app);
  return session
    ? button({ label: 'Sair', icon: 'logout', size, onclick: () => signOut(app) })
    : button({ label: 'Entrar', icon: 'login', size, variant: 'primary', onclick: () => openAccountDialog(app) });
}
