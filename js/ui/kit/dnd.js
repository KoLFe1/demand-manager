// Arrastar e soltar (HTML5 drag and drop) para as telas do Demand Manager.
//
// As funções devolvem PROPS para espalhar num h():
//
//   h('div', { class: 'card', key: t.id, ...dragSource({ type: 'task', id: t.id }) }, …)
//   h('div', { class: 'column', ...dropTarget({ accept: ['task'], ondrop: ({ id }) => app.cmd.setStatus('task', id, col.id) }) }, …)
//
//   // linha reordenável (é origem E destino): use sortableItem — nunca espalhe dragSource + dropTarget juntos
//   h('li', { key: t.id, ...sortableItem({ type: 'task', id: t.id, onmove: ({ id, place }) => app.cmd.moveTask(id, place) }) }, …)
//
// Estados visuais (classes postas no elemento durante o arrasto; o desenho está em css/kit.css):
//   .is-dragging      na origem enquanto é arrastada
//   .is-drop-target   no destino sob o ponteiro, junto com .drop-before | .drop-after | .drop-inside
//                     (.drop-before / .drop-after desenham a linha de inserção; .drop-h quando o eixo é horizontal)
//   html.is-dnd-active enquanto houver um arrasto em curso
//
// Convive com o morph: o arrasto é guardado neste módulo (não no DOM). Se um re-render apagar as classes,
// elas são repostas (a da origem por um MutationObserver; a do destino no próximo "dragover").
//
// Toque: o arrastar e soltar nativo depende do navegador (toque longo). Ofereça sempre um caminho
// alternativo (menu "Mover para…") — o arrasto é um atalho, nunca o único jeito.

/** Tipo MIME usado para carregar o item arrastado no DataTransfer (o estado de verdade fica neste módulo). */
export const DND_MIME = 'application/x-demand-manager';

/** Arrasto em curso: { type, id, data, el } ou null. */
let current = null;
/** Destino destacado no momento: { el, position } ou null. */
let hover = null;
let sourceObserver = null;
let globalsBound = false;

const POSITION_CLASSES = ['drop-before', 'drop-after', 'drop-inside'];

/**
 * O que está sendo arrastado agora (null fora de um arrasto). Útil para a tela se adaptar durante o arrasto.
 * @returns {{ type: string, id: string, data: any }|null}
 */
export function currentDrag() {
  return current === null ? null : { type: current.type, id: current.id, data: current.data };
}

/**
 * Há um arrasto em curso?
 * @returns {boolean}
 */
export function isDragging() {
  return current !== null;
}

function clearHover() {
  if (hover === null) return;
  hover.el.classList.remove('is-drop-target', 'drop-h', ...POSITION_CLASSES);
  hover = null;
}

function setHover(el, position, axis) {
  if (hover !== null && hover.el !== el) clearHover();
  const list = el.classList;
  if (!list.contains('is-drop-target')) list.add('is-drop-target');
  for (const name of POSITION_CLASSES) list.toggle(name, name === `drop-${position}`);
  list.toggle('drop-h', axis === 'horizontal');
  hover = { el, position };
}

function endDrag() {
  clearHover();
  if (sourceObserver !== null) {
    sourceObserver.disconnect();
    sourceObserver = null;
  }
  if (current !== null) {
    if (current.el) current.el.classList.remove('is-dragging');
    current = null;
  }
  document.documentElement.classList.remove('is-dnd-active');
}

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  // Rede de segurança: se a origem sumir num re-render, o "dragend" dela pode não chegar aos tratadores.
  // (em microtarefa: os tratadores do próprio elemento rodam antes e ainda enxergam o arrasto)
  document.addEventListener('dragend', () => queueMicrotask(endDrag));
  document.addEventListener('drop', () => queueMicrotask(endDrag));
  // Durante um arrasto nativo o navegador não envia eventos de ponteiro: se chegou um, o arrasto já acabou.
  document.addEventListener('pointermove', () => {
    if (current !== null) endDrag();
  }, true);
}

/**
 * Posição de soltura a partir do ponteiro.
 *
 *   dropPosition({ top: 100, bottom: 140, left: 0, right: 300 }, { x: 10, y: 105 })                    → 'before'
 *   dropPosition(rect, { x: 10, y: 135 })                                                               → 'after'
 *   dropPosition(rect, { x: 10, y: 120 }, { mode: 'all' })                                              → 'inside'
 *   dropPosition(rect, ponto, { axis: 'horizontal' })                                                   → usa x
 *
 * @param {{ top: number, bottom: number, left: number, right: number }} rect retângulo do destino (coordenadas da janela)
 * @param {{ x: number, y: number }} point posição do ponteiro (clientX, clientY)
 * @param {object} [options]
 * @param {'vertical'|'horizontal'} [options.axis='vertical'] direção da lista
 * @param {'sort'|'inside'|'all'} [options.mode='sort'] 'sort' = antes/depois (metade a metade); 'inside' = sempre
 *        dentro; 'all' = antes / dentro / depois (as bordas valem `edge` do tamanho)
 * @param {number} [options.edge=0.25] fração do tamanho que conta como borda no modo 'all' (0 a 0.5)
 * @returns {'before'|'after'|'inside'}
 */
export function dropPosition(rect, point, { axis = 'vertical', mode = 'sort', edge = 0.25 } = {}) {
  if (mode === 'inside' || !rect || !point) return 'inside';
  const horizontal = axis === 'horizontal';
  const start = Number(horizontal ? rect.left : rect.top);
  const end = Number(horizontal ? rect.right : rect.bottom);
  const at = Number(horizontal ? point.x : point.y);
  const size = end - start;
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(at)) return mode === 'all' ? 'inside' : 'after';
  const ratio = (at - start) / size;
  if (mode === 'all') {
    const border = Math.min(0.5, Math.max(0, Number.isFinite(edge) ? edge : 0.25));
    if (ratio < border) return 'before';
    if (ratio > 1 - border) return 'after';
    return 'inside';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

/**
 * Props de um elemento ARRASTÁVEL.
 *
 *   h('div', { class: 'card', key: task.id, ...dragSource({ type: 'task', id: task.id, data: { from: column.id } }) }, …)
 *
 * @param {object} options
 * @param {string} options.type tipo do item ('task', 'demand'…): os destinos escolhem o que aceitam por ele
 * @param {string} options.id identificador do item
 * @param {any} [options.data] dados livres entregues ao destino (ficam em memória; não precisam ser serializáveis)
 * @param {(info: { type: string, id: string, data: any, event: DragEvent }) => void} [options.ondragstart]
 * @param {(info: { type: string, id: string, data: any, dropped: boolean, event: DragEvent }) => void} [options.ondragend]
 *        `dropped`: true quando o item foi solto num destino que aceitou
 * @param {boolean} [options.disabled] não arrastável
 * @param {string} [options.handle] seletor CSS: só inicia o arrasto quando o ponteiro desceu dentro dele (ex.: '.grip')
 * @returns {object} props para espalhar no h()
 */
export function dragSource({ type, id, data, ondragstart, ondragend, disabled = false, handle } = {}) {
  const dragId = id == null ? '' : String(id);
  const dragType = type == null ? '' : String(type);
  if (disabled) return { 'data-drag-type': dragType, 'data-drag-id': dragId };
  const props = {
    draggable: true,
    'data-drag-type': dragType,
    'data-drag-id': dragId,
    ondragstart: (ev) => {
      const el = ev.currentTarget;
      // Arrasto iniciado num filho arrastável (ou num texto selecionado) não é deste elemento.
      if (ev.target !== el && ev.target instanceof Element && ev.target.closest('[draggable="true"]') !== el) return;
      if (handle && el.__dndPointerTarget instanceof Element && !el.__dndPointerTarget.closest(handle)) {
        ev.preventDefault();
        return;
      }
      ev.stopPropagation();
      bindGlobals();
      endDrag(); // arrasto anterior que não terminou direito
      current = { type: dragType, id: dragId, data, el, dropped: false };
      if (ev.dataTransfer) {
        try {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData(DND_MIME, JSON.stringify({ type: dragType, id: dragId }));
          ev.dataTransfer.setData('text/plain', dragId);
        } catch {
          /* alguns navegadores restringem o DataTransfer: o estado em memória basta */
        }
      }
      // As classes entram no próximo quadro: a "foto" do item arrastada pelo navegador sai sem o esmaecido.
      requestAnimationFrame(() => {
        if (current === null || current.el !== el) return;
        el.classList.add('is-dragging');
        document.documentElement.classList.add('is-dnd-active');
        if (typeof MutationObserver === 'function') {
          sourceObserver = new MutationObserver(() => {
            if (current !== null && current.el === el && !el.classList.contains('is-dragging')) el.classList.add('is-dragging');
          });
          sourceObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
        }
      });
      if (typeof ondragstart === 'function') ondragstart({ type: dragType, id: dragId, data, event: ev });
    },
    ondragend: (ev) => {
      if (current === null || current.id !== dragId || current.type !== dragType) return;
      const dropped = current.dropped === true;
      const payload = current.data;
      endDrag();
      if (typeof ondragend === 'function') ondragend({ type: dragType, id: dragId, data: payload, dropped, event: ev });
    },
  };
  if (handle) {
    props.onpointerdown = (ev) => {
      ev.currentTarget.__dndPointerTarget = ev.target;
    };
  }
  return props;
}

/**
 * Props de um elemento que RECEBE itens arrastados.
 *
 *   // coluna do Kanban: solta "dentro"
 *   h('div', { class: 'column', ...dropTarget({ accept: ['task'], ondrop: ({ id }) => app.cmd.setStatus('task', id, status.id) }) }, …)
 *
 *   // linha de árvore: antes / dentro (vira subtarefa) / depois
 *   dropTarget({ accept: ['task'], mode: 'all', canDrop: ({ id }) => id !== task.id,
 *                ondrop: ({ id, position }) => position === 'inside' ? tornarSubtarefa(id) : reordenar(id, position) })
 *
 * Destinos aninhados: o mais interno que ACEITAR o item fica com ele; se recusar, o de fora é consultado.
 *
 * @param {object} options
 * @param {string[]} [options.accept] tipos aceitos (sem a lista, aceita qualquer tipo)
 * @param {(drop: { type: string, id: string, data: any, position: 'before'|'after'|'inside', event: DragEvent, target: Element }) => void} [options.ondrop]
 * @param {(drop: { type: string, id: string, data: any, position: 'before'|'after'|'inside', event: DragEvent, target: Element }) => void} [options.onover]
 *        chamado quando o item entra no destino ou muda de posição sobre ele (não a cada movimento)
 * @param {(drop: { type: string, id: string, data: any, position: 'before'|'after'|'inside', target: Element }) => boolean} [options.canDrop]
 *        devolva false para recusar (o destino não é destacado)
 * @param {'sort'|'inside'|'all'} [options.mode='inside'] posições possíveis (ver dropPosition)
 * @param {'vertical'|'horizontal'} [options.axis='vertical']
 * @param {(drop: { target: Element }) => void} [options.onleave] o item saiu do destino sem soltar
 * @returns {object} props para espalhar no h()
 */
export function dropTarget({ accept, ondrop, onover, canDrop, mode = 'inside', axis = 'vertical', onleave } = {}) {
  const types = Array.isArray(accept) ? accept.map(String) : null;

  /** Devolve a posição se este destino aceita o arrasto em curso; senão null. */
  const evaluate = (ev) => {
    if (current === null) return null;
    if (types !== null && !types.includes(current.type)) return null;
    const el = ev.currentTarget;
    const position = dropPosition(el.getBoundingClientRect(), { x: ev.clientX, y: ev.clientY }, { axis, mode });
    if (typeof canDrop === 'function') {
      let ok = false;
      try {
        ok = canDrop({ type: current.type, id: current.id, data: current.data, position, target: el }) !== false;
      } catch (err) {
        console.error('[kit] erro em canDrop', err);
      }
      if (!ok) return null;
    }
    return position;
  };

  const over = (ev) => {
    const el = ev.currentTarget;
    const position = evaluate(ev);
    if (position === null) {
      if (hover !== null && hover.el === el) clearHover();
      return; // não aceita: o evento segue para um destino de fora (ou o navegador mostra "proibido")
    }
    ev.preventDefault(); // sem isso o navegador não permite soltar aqui
    ev.stopPropagation();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const changed = hover === null || hover.el !== el || hover.position !== position;
    setHover(el, position, axis);
    if (changed && typeof onover === 'function') onover({ type: current.type, id: current.id, data: current.data, position, event: ev, target: el });
  };

  return {
    'data-drop': mode,
    ondragenter: over,
    ondragover: over,
    ondragleave: (ev) => {
      const el = ev.currentTarget;
      const to = ev.relatedTarget;
      if (to instanceof Node && el.contains(to)) return; // só passou para um filho
      if (hover !== null && hover.el === el) {
        clearHover();
        if (typeof onleave === 'function') onleave({ target: el });
      }
    },
    ondrop: (ev) => {
      const el = ev.currentTarget;
      const position = evaluate(ev);
      if (position === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      const drop = { type: current.type, id: current.id, data: current.data, position, event: ev, target: el };
      current.dropped = true;
      clearHover();
      if (typeof ondrop === 'function') ondrop(drop);
    },
  };
}

// ---------------------------------------------------------------------------
// Listas reordenáveis
// ---------------------------------------------------------------------------

/**
 * Calcula a nova ordem de uma lista de ids ao mover `id` para antes/depois de `targetId`.
 *
 *   reorderIds(['a', 'b', 'c', 'd'], 'a', 'c', 'after')   → ['b', 'c', 'a', 'd']
 *   reorderIds(['a', 'b', 'c'], 'c', 'a', 'before')       → ['c', 'a', 'b']
 *   reorderIds(['a', 'b'], 'x', 'a', 'after')             → ['a', 'x', 'b']     (item vindo de outra lista)
 *   reorderIds(['a', 'b'], 'x', null)                     → ['a', 'b', 'x']     (sem alvo: vai para o fim)
 *
 * Não altera a lista recebida. Alvo inexistente (ou igual ao item) = fim da lista.
 *
 * @param {string[]} ids ordem atual
 * @param {string} id item movido
 * @param {string|null} targetId item de referência
 * @param {'before'|'after'} [position='after']
 * @returns {string[]} nova ordem
 */
export function reorderIds(ids, id, targetId, position = 'after') {
  const moved = String(id);
  const rest = (Array.isArray(ids) ? ids : []).map(String).filter((item) => item !== moved);
  const target = targetId == null ? null : String(targetId);
  const index = target === null || target === moved ? -1 : rest.indexOf(target);
  if (index < 0) rest.push(moved);
  else rest.splice(position === 'before' ? index : index + 1, 0, moved);
  return rest;
}

/**
 * Vizinhos do item na posição de destino — no formato que os comandos esperam (`{ beforeId }` / `{ afterId }`).
 *
 *   sortPlacement(['a', 'b', 'c', 'd'], 'a', 'c', 'after')
 *   → { order: ['b', 'c', 'a', 'd'], index: 2, beforeId: 'd', afterId: 'c', place: { afterId: 'c' }, changed: true }
 *
 * `beforeId` = o item que ficará LOGO DEPOIS do movido ("coloque antes deste"; null = fim da lista);
 * `afterId`  = o item que ficará LOGO ANTES do movido ("coloque depois deste"; null = começo da lista);
 * `place`    = referência pronta para `app.cmd.moveTask(id, place)` / `reorderDemand(id, place)` — `{}` quando a
 *              lista de destino está vazia; `changed` = a ordem realmente muda?
 *
 * @param {string[]} ids ordem atual da lista de destino
 * @param {string} id item movido
 * @param {string|null} targetId item de referência
 * @param {'before'|'after'} [position='after']
 * @returns {{ order: string[], index: number, beforeId: string|null, afterId: string|null,
 *             place: { beforeId?: string, afterId?: string }, changed: boolean }}
 */
export function sortPlacement(ids, id, targetId, position = 'after') {
  const before = (Array.isArray(ids) ? ids : []).map(String);
  const order = reorderIds(before, id, targetId, position);
  const index = order.indexOf(String(id));
  const afterId = index > 0 ? order[index - 1] : null;
  const beforeId = index < order.length - 1 ? order[index + 1] : null;
  const usesBefore = position === 'before' && beforeId !== null;
  const place = usesBefore ? { beforeId } : afterId !== null ? { afterId } : beforeId !== null ? { beforeId } : {};
  const changed = before.length !== order.length || before.some((item, i) => item !== order[i]);
  return { order, index, beforeId, afterId, place, changed };
}

/** Contêiner da lista a que `el` pertence: o ancestral marcado com sortableList() ou, na falta, o pai. */
function listOf(el) {
  return el.closest('[data-sort-list]') || el.parentElement;
}

/** Ids (na ordem do DOM) das linhas de tipo `type` que pertencem diretamente à lista `container`. */
function idsIn(container, type) {
  const ids = [];
  if (!container) return ids;
  for (const node of container.querySelectorAll('[data-drag-id]')) {
    if (node.getAttribute('data-drag-type') !== type) continue;
    if (listOf(node) !== container) continue; // linha de uma lista aninhada
    ids.push(node.getAttribute('data-drag-id'));
  }
  return ids;
}

/**
 * Props de uma LINHA REORDENÁVEL (origem e destino ao mesmo tempo).
 *
 *   tarefas.map((t) => h('div', { class: 'row', key: t.id,
 *     ...sortableItem({ type: 'task', id: t.id, onmove: ({ id, place }) => app.cmd.moveTask(id, place) }) }, …))
 *
 * `onmove` recebe onde o item foi solto em relação à linha de destino:
 *   `{ id, type, data, targetId, position: 'before'|'after', place, beforeId, afterId, order, event }`
 * — `place` (`{ beforeId }` ou `{ afterId }`) pode ir direto para `app.cmd.moveTask` / `reorderDemand`;
 * `order` é a lista de ids da lista de destino já na nova ordem. Soltar um item sobre ele mesmo, ou numa
 * posição que não muda nada, não chama `onmove`.
 *
 * As linhas de uma mesma lista são os irmãos com o mesmo `type` (ou os descendentes de um contêiner marcado
 * com sortableList()).
 *
 * @param {object} options
 * @param {string} options.type
 * @param {string} options.id
 * @param {any} [options.data]
 * @param {(move: object) => void} [options.onmove]
 * @param {string[]} [options.accept] tipos aceitos como vizinhos (padrão: só o próprio `type`)
 * @param {'vertical'|'horizontal'} [options.axis='vertical']
 * @param {(drop: object) => boolean} [options.canDrop]
 * @param {boolean} [options.disabled] a linha não pode ser arrastada (mas ainda serve de referência)
 * @param {string} [options.handle] seletor da "alça" de arrasto (ex.: '.grip')
 * @param {(info: object) => void} [options.ondragstart]
 * @param {(info: object) => void} [options.ondragend]
 * @returns {object} props para espalhar no h()
 */
export function sortableItem({ type, id, data, onmove, accept, axis = 'vertical', canDrop, disabled = false, handle, ondragstart, ondragend } = {}) {
  const itemId = id == null ? '' : String(id);
  const itemType = type == null ? '' : String(type);
  const source = dragSource({ type: itemType, id: itemId, data, disabled, handle, ondragstart, ondragend });
  const target = dropTarget({
    accept: Array.isArray(accept) ? accept : [itemType],
    mode: 'sort',
    axis,
    canDrop: (drop) => {
      if (drop.id === itemId && drop.type === itemType) return false; // soltar sobre si mesmo não faz nada
      return typeof canDrop === 'function' ? canDrop(drop) !== false : true;
    },
    ondrop: (drop) => {
      if (typeof onmove !== 'function') return;
      const ids = idsIn(listOf(drop.target), itemType);
      const placement = sortPlacement(ids.length > 0 ? ids : [itemId], drop.id, itemId, drop.position);
      if (!placement.changed) return;
      onmove({
        id: drop.id,
        type: drop.type,
        data: drop.data,
        targetId: itemId,
        position: drop.position,
        place: placement.place,
        beforeId: placement.beforeId,
        afterId: placement.afterId,
        order: placement.order,
        event: drop.event,
      });
    },
  });
  return { ...source, ...target, 'data-drop': 'sort' };
}

/**
 * Props do CONTÊINER de uma lista reordenável. Opcional: use quando as linhas não são filhas diretas do mesmo
 * elemento, ou para aceitar itens soltos na área vazia da lista (vão para o fim).
 *
 *   h('div', { class: 'list', ...sortableList({ type: 'task', onmove: ({ id, place }) => app.cmd.moveTask(id, { demand_id, ...place }) }) },
 *     tarefas.map((t) => h('div', { key: t.id, ...sortableItem({ type: 'task', id: t.id, onmove }) }, …)))
 *
 * `onmove` recebe `{ id, type, data, targetId: null, position: 'after', place, beforeId: null, afterId, order, event }`
 * (o item vai para o fim; `place` é `{ afterId: últimoId }` ou `{}` se a lista estava vazia).
 *
 * @param {object} options
 * @param {string} options.type tipo das linhas
 * @param {(move: object) => void} [options.onmove] item solto na área vazia da lista
 * @param {string[]} [options.accept] padrão: só `type`
 * @param {(drop: object) => boolean} [options.canDrop]
 * @returns {object} props para espalhar no h()
 */
export function sortableList({ type, onmove, accept, canDrop } = {}) {
  const itemType = type == null ? '' : String(type);
  const base = { 'data-sort-list': itemType };
  if (typeof onmove !== 'function') return base;
  const target = dropTarget({
    accept: Array.isArray(accept) ? accept : [itemType],
    mode: 'inside',
    canDrop,
    ondrop: (drop) => {
      const ids = idsIn(drop.target, itemType);
      const placement = sortPlacement(ids, drop.id, null, 'after');
      if (!placement.changed) return;
      onmove({
        id: drop.id,
        type: drop.type,
        data: drop.data,
        targetId: null,
        position: 'after',
        place: placement.place,
        beforeId: null,
        afterId: placement.afterId,
        order: placement.order,
        event: drop.event,
      });
    },
  });
  return { ...target, ...base };
}
