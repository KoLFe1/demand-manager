// Identificadores e relógio lógico. Sem dependências.

/** UUID v4. Usa crypto.randomUUID quando disponível (contexto seguro); senão getRandomValues. */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * Relógio híbrido: devolve milissegundos desde 1970 ESTRITAMENTE crescentes neste dispositivo,
 * mesmo que o relógio do sistema ande para trás ou duas escritas caiam no mesmo milissegundo.
 * É o carimbo usado em field_ts (resolução de conflitos campo a campo).
 */
export function createClock(nowFn = Date.now) {
  let last = 0;
  return {
    /** Próximo carimbo (sempre maior que o anterior). */
    now() {
      const t = Math.floor(nowFn());
      last = t > last ? t : last + 1;
      return last;
    },
    /**
     * Informa um carimbo visto de fora, para nunca gerar carimbos menores que ele.
     *
     * Por padrão ignora carimbos absurdamente no futuro (relógio errado em outro aparelho): no
     * máximo 5 min à frente do relógio local. Com `{ trusted: true }` aceita qualquer carimbo finito:
     * use para carimbos que vieram do SERVIDOR — ele já os limitou a "agora + 5 min" pelo relógio
     * dele —, de modo que um aparelho com o relógio ATRASADO continue carimbando as próximas
     * alterações acima de tudo o que já viu (senão elas perderiam, em silêncio, para dados antigos).
     * @param {number|string} ts carimbo em milissegundos
     * @param {{ trusted?: boolean }} [options]
     */
    observe(ts, { trusted = false } = {}) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= last) return;
      if (trusted || n <= nowFn() + 5 * 60 * 1000) last = Math.floor(n);
    },
    /** Último carimbo emitido/observado. */
    peek() {
      return last;
    },
  };
}

const DEVICE_KEY = 'dm.device';

/** Identificador estável deste navegador/dispositivo (guardado no localStorage). */
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'sem-armazenamento';
  }
}

/**
 * UUID determinístico derivado de (baseId, salt): mesma entrada → mesmo UUID, em qualquer aparelho.
 * Hash síncrono de 128 bits (cyrb128) com os bits de versão 8 e variante RFC 4122. Usado, por exemplo, na
 * próxima ocorrência de uma tarefa recorrente: dois aparelhos que concluem a mesma tarefa criam a MESMA linha
 * (o merge junta) e reabrir + concluir de novo não duplica.
 * @param {string} baseId
 * @param {string} salt
 * @returns {string}
 */
export function derivedUuid(baseId, salt) {
  const str = `${String(baseId)}|${String(salt)}`;
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const b = new Uint8Array(16);
  [h1, h2, h3, h4].forEach((h, i) => {
    const v = h >>> 0;
    b[i * 4] = v >>> 24;
    b[i * 4 + 1] = (v >>> 16) & 0xff;
    b[i * 4 + 2] = (v >>> 8) & 0xff;
    b[i * 4 + 3] = v & 0xff;
  });
  b[6] = (b[6] & 0x0f) | 0x80; // versão 8 (personalizada)
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
