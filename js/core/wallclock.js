// Relógio de parede do app: a ÚNICA fonte de "agora" para serviços e banco local.
// Em produção devolve a hora real; em testes e na geração de dados de demonstração pode ser
// "viajado" para uma data fixa, de modo que o histórico seja criado com datas passadas.
//
//   const wall = createWallClock();
//   const store = await createStore({ dbName, now: wall.now });
//   const app = createApp({ store, wall });
//
//   wall.travelTo('2026-10-05T09:00:00');   // congela o relógio nesse instante (hora local)
//   wall.advance({ hours: 2 });             // anda 2 h a partir do instante congelado
//   wall.reset();                           // volta ao tempo real

import { toDateStr } from './dates.js';

export function createWallClock(realNow = () => new Date()) {
  /** Instante congelado (ms) ou null para tempo real. */
  let frozen = null;

  const clock = {
    /** Date atual (real ou congelado). Função solta: pode ser passada como callback. */
    now: () => (frozen === null ? realNow() : new Date(frozen)),
    /**
     * Igual a now(), mas sem contar como "leitura da hora" para a casca (que pode trocar `now` por uma versão
     * que registra quem leu, para o tique de 1 min redesenhar só quem mostra hora). Use em chaves de cache.
     */
    peek: () => (frozen === null ? realNow() : new Date(frozen)),
    /** Instante atual em ISO UTC. */
    nowIso: () => clock.now().toISOString(),
    /** Milissegundos desde 1970. */
    nowMs: () => clock.now().getTime(),
    /** Data local de hoje, 'YYYY-MM-DD'. */
    today: () => toDateStr(clock.peek()),
    /** Congela o relógio num instante (Date, ISO, ou 'YYYY-MM-DDTHH:MM' local). */
    travelTo(when) {
      const d = when instanceof Date ? when : new Date(when);
      if (Number.isNaN(d.getTime())) throw new Error(`Data inválida para travelTo: ${when}`);
      frozen = d.getTime();
      return clock;
    },
    /** Avança o relógio congelado (se estiver em tempo real, congela a partir de agora). */
    advance({ days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = {}) {
      const base = frozen === null ? realNow().getTime() : frozen;
      frozen = base + ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000 + ms;
      return clock;
    },
    /** Volta ao tempo real. */
    reset() {
      frozen = null;
      return clock;
    },
    /** true quando o relógio está congelado (testes/demonstração). */
    isFrozen: () => frozen !== null,
  };
  return clock;
}
