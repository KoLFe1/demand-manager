// Registro dos painéis laterais de edição.
// A casca (js/ui/shell.js) chama panels[tipo].render(app, id, ctx) e coloca o resultado no painel lateral.
//   ctx = { state, setState(patch), close() }
// panels[tipo].title(app, id) devolve o título (texto) do painel.

import demandPanel from './demand-panel.js';
import taskPanel from './task-panel.js';

/**
 * Painéis por tipo de entidade.
 * @type {{ task: { title(app: object, id: string): string, render(app: object, id: string, ctx: object): HTMLElement },
 *          demand: { title(app: object, id: string): string, render(app: object, id: string, ctx: object): HTMLElement } }}
 */
export const panels = Object.freeze({
  task: taskPanel,
  demand: demandPanel,
});
