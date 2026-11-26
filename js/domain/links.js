// Links e arquivos de demandas/tarefas/projetos. Puro: sem DOM, sem banco e sem relógio.
//
// Um link guarda o `target` como o usuário colou (aparado, sem aspas em volta) e um `kind` derivado dele:
//   unc       \\servidor\pasta\...            → copiar caminho
//   drive     X:\pasta\...                     → copiar caminho
//   file      file:///X:/pasta/arquivo         → copiar caminho (navegadores bloqueiam file:// vindo de https)
//   leapfrog  qualquer caminho terminado em .aprj (mesmo UNC/unidade) → copiar caminho
//   web       http(s)://...  (www.… vira https://www.…)               → abrir em nova aba
//   mailto    mailto:... (um e-mail solto vira mailto:)                → abrir
//   office    ms-excel: / ms-word: / ms-powerpoint:                    → abrir (o Windows chama o Office)
//   other     o resto (texto livre, outros esquemas)                   → copiar
// Esquemas perigosos (javascript:, data:, vbscript:) e alvo vazio são recusados.

export const LINK_KIND = Object.freeze({
  UNC: 'unc',
  DRIVE: 'drive',
  FILE: 'file',
  WEB: 'web',
  MAILTO: 'mailto',
  OFFICE: 'office',
  LEAPFROG: 'leapfrog',
  OTHER: 'other',
});

/** Como a interface age sobre o link: abrir (âncora target=_blank) ou copiar o caminho. */
export const OPEN_MODE = Object.freeze({ OPEN: 'open', COPY: 'copy' });

/** Ícone (nome do kit) e rótulo pt-BR de cada tipo. */
export const KIND_META = Object.freeze({
  unc: Object.freeze({ icon: 'folder', label: 'Pasta de rede' }),
  drive: Object.freeze({ icon: 'folder', label: 'Caminho local' }),
  file: Object.freeze({ icon: 'file-text', label: 'Arquivo' }),
  web: Object.freeze({ icon: 'external', label: 'Página web' }),
  mailto: Object.freeze({ icon: 'message', label: 'E-mail' }),
  office: Object.freeze({ icon: 'file-text', label: 'Documento do Office' }),
  leapfrog: Object.freeze({ icon: 'layers', label: 'Projeto Leapfrog' }),
  other: Object.freeze({ icon: 'link', label: 'Link' }),
});

export const MAX_TARGET_LENGTH = 2000;
const MAX_LABEL_LENGTH = 80;
const OPEN_KINDS = new Set([LINK_KIND.WEB, LINK_KIND.MAILTO, LINK_KIND.OFFICE]);
const UNSAFE_SCHEME = /^(javascript|data|vbscript):/i;
const OFFICE_SCHEME = /^ms-(excel|word|powerpoint):/i;
const LOOSE_EMAIL = /^[^\s@/\\:]+@[^\s@/\\:]+\.[a-z]{2,}$/i;

/** Apara, tira aspas em volta (o "Copiar como caminho" do Windows põe aspas) e une quebras de linha. */
export function normalizeTarget(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/[\r\n]+/g, '').trim();
  for (;;) {
    const m = /^(["'<])([\s\S]*)([>"'])$/.exec(text);
    if (!m || (m[1] === '<' ? m[3] !== '>' : m[1] !== m[3])) break;
    text = m[2].trim();
  }
  return text;
}

/** Caminho (sem consulta/fragmento) termina em .aprj? */
function isAprj(text) {
  return /\.aprj$/i.test(text.replace(/[?#].*$/, '').replace(/[\\/]+$/, ''));
}

/** Tipo de um alvo já normalizado (sem validar esquemas perigosos). */
function kindOf(text) {
  if (/^https?:\/\/[^\s/]/i.test(text)) return LINK_KIND.WEB;
  if (/^mailto:/i.test(text)) return LINK_KIND.MAILTO;
  if (OFFICE_SCHEME.test(text)) return LINK_KIND.OFFICE;
  if (isAprj(text)) return LINK_KIND.LEAPFROG;
  if (/^\\\\[^\\/\s]/.test(text)) return LINK_KIND.UNC;
  if (/^[a-z]:([\\/]|$)/i.test(text)) return LINK_KIND.DRIVE;
  if (/^file:/i.test(text)) return LINK_KIND.FILE;
  return LINK_KIND.OTHER;
}

/** Modo de abertura de um tipo. */
export function openModeOf(kind) {
  return OPEN_KINDS.has(kind) ? OPEN_MODE.OPEN : OPEN_MODE.COPY;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function clip(text, max = MAX_LABEL_LENGTH) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Último trecho não vazio de um caminho (separadores \ ou /). */
function lastSegment(path) {
  const parts = path.replace(/[?#].*$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Caminho do Windows de um file:// (file:///C:/a/b → C:\a\b; file://srv/share/x → \\srv\share\x).
 * Devolve o próprio texto quando não dá para converter.
 */
export function fileUriToPath(uri) {
  const m = /^file:(\/\/)?(.*)$/i.exec(uri || '');
  if (!m) return uri;
  let rest = safeDecode(m[2].replace(/[?#].*$/, ''));
  if (m[1] === undefined) return rest.replace(/\//g, '\\');
  if (/^\/[a-z]:/i.test(rest)) return rest.slice(1).replace(/\//g, '\\');
  if (rest.startsWith('/')) {
    rest = rest.replace(/^\/+/, '');
    if (/^[a-z]:/i.test(rest)) return rest.replace(/\//g, '\\');
    return `\\\\${rest.replace(/\//g, '\\')}`;
  }
  if (/^localhost\//i.test(rest)) return rest.slice('localhost/'.length).replace(/\//g, '\\');
  return `\\\\${rest.replace(/\//g, '\\')}`;
}

/** Texto que "Copiar caminho" põe na área de transferência (file:// vira caminho do Windows). */
export function copyTextOf(target, kind) {
  const text = normalizeTarget(target);
  if (/^file:/i.test(text) && (kind === LINK_KIND.FILE || kind === LINK_KIND.LEAPFROG)) return fileUriToPath(text);
  return text;
}

/** Rótulo sugerido para um alvo: nome do arquivo/pasta, host do site ou endereço de e-mail. */
export function suggestLabel(target, kind = kindOf(normalizeTarget(target))) {
  const text = normalizeTarget(target);
  if (!text) return '';
  switch (kind) {
    case LINK_KIND.WEB: {
      const m = /^https?:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(text);
      return m ? m[1].replace(/^www\./i, '').toLowerCase() : clip(text);
    }
    case LINK_KIND.MAILTO:
      return clip(safeDecode(text.slice('mailto:'.length).split('?')[0]) || 'E-mail');
    case LINK_KIND.OFFICE: {
      const app = /^ms-(\w+):/i.exec(text)[1].toLowerCase();
      const inner = /(https?:\/\/[^|]+)$/i.exec(text);
      const name = inner ? safeDecode(lastSegment(inner[1].replace(/^https?:\/\/[^/]+/i, ''))) : '';
      return clip(name || { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint' }[app]);
    }
    case LINK_KIND.FILE:
      return clip(lastSegment(fileUriToPath(text)) || text);
    case LINK_KIND.UNC:
    case LINK_KIND.DRIVE:
    case LINK_KIND.LEAPFROG:
      return clip(safeDecode(lastSegment(/^file:/i.test(text) ? fileUriToPath(text) : text)) || text);
    default:
      return clip(text);
  }
}

/**
 * Classifica e valida um alvo colado pelo usuário.
 * @param {unknown} raw
 * @returns {{ ok: true, target: string, kind: string, openMode: string, label: string }
 *          | { ok: false, error: { code: string, message: string } }}
 */
export function classifyTarget(raw) {
  let text = normalizeTarget(raw);
  if (!text) return { ok: false, error: { code: 'empty', message: 'Cole um caminho, endereço ou link.' } };
  // Ignora espaços e caracteres de controle no esquema ("java\tscript:" também é recusado).
  if (UNSAFE_SCHEME.test(text.replace(/[\s\u0000-\u001f]/g, ''))) {
    return { ok: false, error: { code: 'unsafe', message: 'Este tipo de link não é permitido (javascript:, data:, vbscript:).' } };
  }
  if (text.length > MAX_TARGET_LENGTH) return { ok: false, error: { code: 'too_long', message: `Link longo demais (máximo de ${MAX_TARGET_LENGTH} caracteres).` } };
  if (/^www\.[^\s/]+\.[^\s/]+/i.test(text)) text = `https://${text}`;
  else if (LOOSE_EMAIL.test(text)) text = `mailto:${text}`;
  const kind = kindOf(text);
  return { ok: true, target: text, kind, openMode: openModeOf(kind), label: suggestLabel(text, kind) };
}

/**
 * Tudo que a interface precisa para mostrar um link salvo (o tipo é recalculado do alvo; o `kind` gravado
 * serve só de dica para quem lê o banco). `href` só existe no modo abrir.
 * @param {{ target: string, label?: string|null }} link
 * @returns {{ kind: string, openMode: string, label: string, href: string|null, copyText: string, icon: string, kindLabel: string, valid: boolean }}
 */
export function linkInfo(link) {
  const target = link && typeof link.target === 'string' ? link.target : '';
  const res = classifyTarget(target);
  const kind = res.ok ? res.kind : LINK_KIND.OTHER;
  const openMode = res.ok ? res.openMode : OPEN_MODE.COPY;
  const custom = link && typeof link.label === 'string' ? link.label.trim() : '';
  const meta = KIND_META[kind];
  return {
    kind,
    openMode,
    label: custom || (res.ok ? res.label : target) || 'Link',
    href: res.ok && openMode === OPEN_MODE.OPEN ? res.target : null,
    copyText: res.ok ? copyTextOf(res.target, kind) : target,
    icon: meta.icon,
    kindLabel: meta.label,
    valid: res.ok,
  };
}

/** Ordem de exibição: sort_order, depois created_at, depois id. */
export function compareLinks(a, b) {
  const sa = Number.isFinite(a.sort_order) ? a.sort_order : 0;
  const sb = Number.isFinite(b.sort_order) ? b.sort_order : 0;
  if (sa !== sb) return sa - sb;
  const ca = String(a.created_at || '');
  const cb = String(b.created_at || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}
