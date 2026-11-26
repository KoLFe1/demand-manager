// Merge campo a campo (last-writer-wins por campo) e utilidades de linhas imutáveis.
//
// Funções PURAS: não tocam em IndexedDB, não leem relógio e nunca alteram os objetos recebidos.
// Usadas pelo banco local (js/data/store.js) para juntar linhas vindas do servidor, de outra aba
// ou de um backup com as linhas locais.
//
// Formato de uma linha local:
//   { ...campos de desc.fields, field_ts: { campo: carimbo em ms } (só tabelas 'lww'), server_seq }

/** Campos de controle que nunca são decididos por carimbo. */
const CREATED = 'created_at';
const UPDATED = 'updated_at';

const EMPTY_STAMPS = Object.freeze({});

const isObject = (v) => v !== null && typeof v === 'object';

/**
 * Igualdade profunda de VALORES (linhas, arrays, JSON).
 * Regras: primitivos por `Object.is` (NaN é igual a NaN); arrays comparados em ordem; objetos pelas
 * chaves próprias, ignorando a ordem das chaves e as chaves cujo valor é `undefined`.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function rowsEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!rowsEqual(a[i], b[i])) return false;
    return true;
  }
  let count = 0;
  for (const k of Object.keys(a)) {
    const va = a[k];
    if (va === undefined) continue;
    count++;
    if (!rowsEqual(va, b[k])) return false;
  }
  for (const k of Object.keys(b)) if (b[k] !== undefined) count--;
  return count === 0;
}

/**
 * Congela um valor EM PROFUNDIDADE, no próprio objeto (arrays e objetos aninhados incluídos).
 * Use apenas em objetos que pertencem a quem chama (ex.: recém-lidos do IndexedDB).
 * @param {any} value
 * @returns {any} o mesmo valor, congelado
 */
export function freezeDeep(value) {
  if (!isObject(value) || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) for (const item of value) freezeDeep(item);
  else for (const k of Object.keys(value)) freezeDeep(value[k]);
  return Object.freeze(value);
}

/**
 * Devolve uma versão imutável de um valor SEM alterar o original: primitivos e valores já congelados
 * voltam como estão; arrays e objetos são copiados em profundidade e a cópia é congelada.
 * @param {any} value
 * @returns {any}
 */
export function frozenCopy(value) {
  if (!isObject(value) || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  const out = {};
  for (const k of Object.keys(value)) out[k] = frozenCopy(value[k]);
  return Object.freeze(out);
}

/** Carimbo numérico (ausente/inválido = 0). */
function stamp(map, field) {
  const n = map ? Number(map[field]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Ordem do servidor como número comparável (ausente = -1: "nunca veio do servidor"). */
function seqOf(row) {
  const n = row && row.server_seq != null ? Number(row.server_seq) : NaN;
  return Number.isFinite(n) ? n : -1;
}

/** Texto JSON de um valor, só para ORDENAR valores de forma estável (nunca lança). */
function sortKey(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? '' : s;
  } catch {
    return '';
  }
}

/**
 * Desempate entre abas: true quando o valor LOCAL deve ficar num empate exato de carimbo.
 * Vence o valor de maior JSON; valores iguais (ou de JSON igual) não precisam de desempate.
 */
function localWinsTie(localValue, remoteValue) {
  if (rowsEqual(localValue, remoteValue)) return false;
  return sortKey(localValue) > sortKey(remoteValue);
}

/** O mais recente de dois instantes ISO (aceita vazios). */
function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a === b) return a;
  // ISO canônico (toISOString) compara corretamente como texto; fora disso, compara pelo instante.
  if (a.length === 24 && b.length === 24) return a > b ? a : b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return a;
  if (Number.isNaN(ta)) return b;
  return ta >= tb ? a : b;
}

/**
 * Junta a linha local com uma linha vinda de fora (servidor, outra aba ou backup).
 *
 * @param {object} desc    descritor da tabela (js/data/schema.js)
 * @param {object|undefined} local   linha local atual (ou undefined se não existe)
 * @param {object} remote  linha JÁ convertida por `fromRemoteRow` (tipos canônicos, `field_ts`, `server_seq`)
 * @returns {{ row: object, changed: boolean, pending: boolean }}
 *   - `row`: linha resultante, congelada (arrays/JSON também). É um objeto NOVO quando algo mudou;
 *     quando nada mudou é a própria linha local.
 *   - `changed`: a linha resultante difere da local (comparação profunda de valores).
 *   - `pending`: pelo menos um campo manteve o valor LOCAL porque o carimbo local é mais novo que o
 *     recebido — a linha ainda precisa ser enviada ao servidor.
 *
 * Regras:
 *   - sem linha local → fica a recebida (`changed: true`, `pending: false`);
 *   - tabela 'append' (imutável): se já existe localmente, ignora a recebida;
 *   - tabela 'lww': para cada campo de dados compara `field_ts[campo]` (ausente = 0); carimbo recebido
 *     maior OU IGUAL → vale o valor recebido (empate → vence o servidor); senão fica o local;
 *   - `server_seq` e os campos marcados `{ server: true }` no schema (seq) são do servidor: vêm do lado
 *     que tem o `server_seq` mais alto (empate → recebido). Numa resposta do servidor isso é sempre a
 *     linha recebida; a comparação só protege contra linhas antigas vindas de outra aba ou fora de
 *     ordem. Um `seq` nulo nunca apaga um `seq` já conhecido;
 *   - `updated_at` = o mais recente dos dois; `created_at` = o recebido, quando existe.
 * Nunca altera `local` nem `remote`.
 *
 * Opções (as duas desligadas por padrão):
 *   - `confirm`: a linha recebida é a RESPOSTA DO SERVIDOR ao envio desta mesma linha. O servidor
 *     limita carimbos a "agora + 5 min"; um aparelho com o relógio adiantado ficaria para sempre com
 *     carimbos locais maiores que os gravados (linha eternamente pendente, e o valor antigo dele
 *     poderia mais tarde passar por cima de uma edição mais nova de outro aparelho). Com `confirm`,
 *     quando o carimbo recebido é MENOR que o local e os VALORES são iguais, adota-se o carimbo do
 *     servidor e o campo não fica pendente. Valores diferentes continuam seguindo a regra normal.
 *     Nunca use em linhas baixadas (pull): só na resposta do próprio envio.
 *   - `tieBreak`: desempate determinístico para linhas vindas de OUTRA ABA do mesmo navegador. Duas
 *     abas podem carimbar o mesmo campo no mesmo milissegundo; com "empate → vence o recebido" dos
 *     dois lados elas trocariam os valores e ficariam divergentes. Com `tieBreak`, num empate exato
 *     entre valores diferentes vence o valor cujo JSON é o maior — o mesmo nas duas abas. Linhas do
 *     servidor NÃO usam esta opção (empate → vence o servidor).
 *
 * @param {{ confirm?: boolean, tieBreak?: boolean }} [options]
 */
export function mergeRow(desc, local, remote, { confirm = false, tieBreak = false } = {}) {
  if (!isObject(remote)) throw new TypeError('mergeRow: linha recebida inválida.');
  if (local === undefined || local === null) {
    return { row: frozenCopy({ ...remote }), changed: true, pending: false };
  }
  if (desc.mode !== 'lww') return { row: local, changed: false, pending: false };

  const tsL = isObject(local.field_ts) ? local.field_ts : EMPTY_STAMPS;
  const tsR = isObject(remote.field_ts) ? remote.field_ts : EMPTY_STAMPS;
  const serverFromRemote = seqOf(remote) >= seqOf(local);
  const out = {};
  const stamps = {};
  let pending = false;

  for (const [field, def] of Object.entries(desc.fields)) {
    const hasRemote = remote[field] !== undefined;
    const localValue = local[field] === undefined ? null : local[field];
    if (field === desc.idField) {
      out[field] = localValue;
      continue;
    }
    if (field === CREATED) {
      out[field] = remote[field] || localValue;
      continue;
    }
    if (field === UPDATED) {
      out[field] = laterIso(localValue, remote[field]);
      continue;
    }
    const l = stamp(tsL, field);
    const r = stamp(tsR, field);
    if (def.server) {
      // Campo atribuído pelo servidor: não depende de carimbo e nunca deixa a linha pendente.
      const useRemote = serverFromRemote && hasRemote && remote[field] !== null;
      out[field] = useRemote ? remote[field] : localValue;
      const s = useRemote ? r : l;
      if (s > 0) stamps[field] = s;
      continue;
    }
    if (!hasRemote) {
      // Linha recebida sem a coluna (não canônica): nada a comparar, fica o valor local.
      out[field] = localValue;
      if (l > 0) stamps[field] = l;
      continue;
    }
    if (r > l || (r === l && !(tieBreak && localWinsTie(localValue, remote[field])))) {
      out[field] = frozenCopy(remote[field]);
      if (r > 0) stamps[field] = r;
    } else if (r === l) {
      // Empate entre abas decidido a favor do valor local: nada a enviar por causa deste campo.
      out[field] = frozenCopy(localValue);
      if (l > 0) stamps[field] = l;
    } else if (confirm && rowsEqual(localValue, remote[field])) {
      // Resposta do nosso próprio envio com o carimbo reduzido pelo servidor: vale o carimbo dele.
      out[field] = frozenCopy(localValue);
      if (r > 0) stamps[field] = r;
    } else {
      out[field] = frozenCopy(localValue);
      stamps[field] = l;
      pending = true;
    }
  }

  // Carimbos de colunas que este app não conhece (schema mais novo em outro aparelho): guarda o maior.
  for (const map of [tsL, tsR]) {
    for (const key of Object.keys(map)) {
      if (key in desc.fields) continue;
      const s = Math.max(stamp(tsL, key), stamp(tsR, key));
      if (s > 0) stamps[key] = s;
    }
  }

  out.field_ts = Object.freeze(stamps);
  const seqL = seqOf(local);
  const seqR = seqOf(remote);
  out.server_seq = serverFromRemote ? (seqR >= 0 ? seqR : seqL >= 0 ? seqL : null) : seqL;

  if (rowsEqual(out, local)) return { row: Object.isFrozen(local) ? local : Object.freeze(out), changed: false, pending };
  return { row: Object.freeze(out), changed: true, pending };
}

/**
 * Aplica uma alteração local a uma linha, carimbando os campos alterados.
 *
 * @param {object} desc    descritor da tabela
 * @param {object} row     linha atual (não é alterada)
 * @param {object} patch   campos a gravar (valores já validados por quem chama); chaves com valor
 *                         `undefined` são ignoradas
 * @param {number} ts      carimbo (ms) desta alteração — vem do relógio lógico (`createClock().now()`)
 * @param {string} nowIso  instante ISO UTC da alteração
 * @returns {object} NOVA linha congelada: patch aplicado; `field_ts[campo] = ts` para cada chave do
 *   patch (tabelas 'lww'); `updated_at = nowIso` (quando a tabela tem a coluna). Um `updated_at`
 *   explícito no patch é respeitado (retrodatar em dados de demonstração) e, por ser campo de
 *   controle, não recebe carimbo.
 */
export function applyPatch(desc, row, patch, ts, nowIso) {
  const out = { ...row };
  const lww = desc.mode === 'lww';
  const stamps = lww ? { ...(isObject(row.field_ts) ? row.field_ts : EMPTY_STAMPS) } : null;
  let explicitUpdated = false;
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = frozenCopy(value);
    if (key === UPDATED) {
      explicitUpdated = value !== null;
      continue;
    }
    if (stamps) stamps[key] = ts;
  }
  if (UPDATED in desc.fields && !explicitUpdated) out[UPDATED] = nowIso;
  if (stamps) out.field_ts = Object.freeze(stamps);
  return Object.freeze(out);
}
