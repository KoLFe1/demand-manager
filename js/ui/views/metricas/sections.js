// Tela "Métricas" — as quatro seções (Produtividade, Prazos, Capacidade, Bloqueios).
// Cada função recebe o resultado de computeMetrics (via app.sel.metrics) e devolve a seção pronta.

import { formatDateTime, formatWeekRange } from '../../../core/dates.js';
import { cx, h } from '../../../core/dom.js';
import { formatNumber } from '../../../core/format.js';
import { estimateVsActual, formatDuration } from '../../../domain/timetracking.js';
import { barChart, groupedBarChart, hbarList, lineChart, sparkline } from '../../kit/charts.js';
import { emptyState } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { taskRow } from '../../shared/entity.js';
import { chartCard, metricCard, section } from './cards.js';
import { MONTHLY_MIN_DAYS, elapsedText, formatRatio, formatValue, monthLabel, valueText, weekLabel } from './model.js';

const TASK_NOUNS = Object.freeze({ one: 'tarefa', many: 'tarefas' });
const DEMAND_NOUNS = Object.freeze({ one: 'demanda', many: 'demandas' });
const DEP_NOUNS = Object.freeze({ one: 'dependência', many: 'dependências' });

// ---------------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------------

export function productivitySection(m, period, delta) {
  const p = m.productivity;
  const perWeek = period.days >= 14 && p.tasksCompleted > 0 ? `≈ ${formatNumber((p.tasksCompleted / period.days) * 7, 1)} por semana` : null;
  const weeks = p.throughputWeekly;
  const weeklyChart = barChart({
    data: weeks.map((w) => ({
      label: weekLabel(w.weekStart),
      value: w.tasks,
      title: `Semana de ${formatWeekRange(w.weekStart)}: ${valueText(w.tasks, 'count', TASK_NOUNS)} e ${valueText(w.demands, 'count', DEMAND_NOUNS)}`,
    })),
    height: 250,
    ariaLabel: 'Tarefas concluídas por semana',
  });
  const months = p.throughputMonthly;
  const crossesYear = months.length > 0 && months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
  const showMonthly = period.days >= MONTHLY_MIN_DAYS && months.length > 1;
  const weeklyDemands = weeks.reduce((n, w) => n + w.demands, 0);

  return section({
    id: 'productivity',
    title: 'Produtividade',
    iconName: 'zap',
    description: 'O que foi entregue no período e quanto tempo levou.',
    children: [
      metricCard({ key: 'tasksCompleted', value: formatValue(p.tasksCompleted, 'count', TASK_NOUNS), delta: delta('productivity.tasksCompleted', 'count', TASK_NOUNS), secondary: perWeek }),
      metricCard({ key: 'demandsCompleted', value: formatValue(p.demandsCompleted, 'count', DEMAND_NOUNS), delta: delta('productivity.demandsCompleted', 'count', DEMAND_NOUNS) }),
      chartCard({
        key: 'throughputWeekly',
        title: 'Throughput semanal',
        caption: `Tarefas concluídas por semana · ${valueText(p.tasksCompleted, 'count', TASK_NOUNS)} e ${valueText(weeklyDemands, 'count', DEMAND_NOUNS)} no período`,
        span: 'span-2 row-3',
        chart: weeklyChart,
      }),
      metricCard({
        key: 'leadTimeAvgDays',
        value: formatValue(p.leadTimeAvgDays, 'days'),
        delta: delta('productivity.leadTimeAvgDays', 'days'),
        secondary: p.leadTimeMedianDays === null ? null : `mediana ${valueText(p.leadTimeMedianDays, 'days')}`,
      }),
      metricCard({
        key: 'cycleTimeAvgDays',
        label: 'Cycle time médio',
        value: formatValue(p.cycleTimeAvgDays, 'days'),
        delta: delta('productivity.cycleTimeAvgDays', 'days'),
        secondary: p.cycleTimeMedianDays === null ? null : `mediana ${valueText(p.cycleTimeMedianDays, 'days')}`,
      }),
      metricCard({
        key: 'reworkRate',
        value: formatValue(p.reworkRate, 'ratio'),
        delta: delta('productivity.reworkRate', 'ratio'),
        secondary: p.reworkRate === null ? null : `${formatNumber(p.reworkCount)} de ${valueText(p.tasksCompleted, 'count', TASK_NOUNS)}`,
      }),
      metricCard({
        key: 'avgTimePerTaskSeconds',
        value: formatValue(p.avgTimePerTaskSeconds, 'seconds'),
        delta: delta('productivity.avgTimePerTaskSeconds', 'seconds'),
        secondary: 'nas concluídas com apontamento',
      }),
      showMonthly
        ? chartCard({
            key: 'throughputMonthly',
            title: 'Throughput mensal',
            caption: 'Tarefas concluídas por mês (meses incompletos contam só os dias do período)',
            span: 'span-full',
            chart: barChart({
              data: months.map((mo) => ({
                label: monthLabel(mo.month, crossesYear),
                value: mo.tasks,
                title: `${monthLabel(mo.month, true)}: ${valueText(mo.tasks, 'count', TASK_NOUNS)} e ${valueText(mo.demands, 'count', DEMAND_NOUNS)}`,
              })),
              height: 160,
              ariaLabel: 'Tarefas concluídas por mês',
            }),
          })
        : null,
    ],
  });
}

export function deadlinesSection(m, delta, asOfText) {
  const d = m.deadlines;
  const weeks = d.plannedVsDone;
  const adherence = weeks.map((w) => w.adherence).filter((v) => v !== null);
  const plannedWeeks = adherence.length;
  return section({
    id: 'deadlines',
    title: 'Prazos',
    iconName: 'calendar',
    description: 'Pontualidade das entregas e cumprimento do planejamento semanal.',
    children: [
      metricCard({
        key: 'onTimeRate',
        label: 'Concluídas no prazo',
        value: formatValue(d.onTimeRate, 'ratio'),
        delta: delta('deadlines.onTimeRate', 'ratio'),
        secondary: d.completedWithDue ? `${formatNumber(d.completedOnTime)} de ${formatNumber(d.completedWithDue)} com prazo` : null,
        tone: d.onTimeRate === null ? null : d.onTimeRate >= 0.8 ? 'success' : d.onTimeRate < 0.5 ? 'danger' : null,
      }),
      metricCard({
        key: 'overdueOpen',
        label: 'Tarefas atrasadas',
        value: formatValue(d.overdueOpen, 'count', TASK_NOUNS),
        delta: delta('deadlines.overdueOpen', 'count', TASK_NOUNS),
        secondary: `em aberto ${asOfText}`,
        tone: d.overdueOpen > 0 ? 'danger' : null,
      }),
      metricCard({
        key: 'avgDelayDays',
        label: 'Atraso médio',
        value: formatValue(d.avgDelayDays, 'days'),
        delta: delta('deadlines.avgDelayDays', 'days'),
        secondary: d.avgOverdueDays === null ? (d.completedLate ? `${valueText(d.completedLate, 'count', TASK_NOUNS)} com atraso` : null) : `pendentes: ${valueText(d.avgOverdueDays, 'days')} em média`,
      }),
      metricCard({
        key: 'weeklyAdherence',
        label: 'Cumprimento do plano semanal',
        value: formatValue(d.weeklyAdherence, 'ratio'),
        delta: delta('deadlines.weeklyAdherence', 'ratio'),
        secondary: plannedWeeks ? `média de ${plannedWeeks} ${plannedWeeks === 1 ? 'semana' : 'semanas'} com plano` : null,
        chart: adherence.length > 1 ? sparkline(adherence, { width: 72, height: 26, title: `Cumprimento por semana: ${adherence.map((v) => formatRatio(v)).join(', ')}` }) : null,
      }),
      chartCard({
        key: 'plannedVsDone',
        title: 'Planejado × realizado',
        caption: 'Por semana: tarefas no plano (inclusive as adicionadas durante a semana) e tarefas do plano concluídas na própria semana',
        span: 'span-full',
        chart: groupedBarChart({
          categories: weeks.map((w) => weekLabel(w.weekStart)),
          series: [
            { name: 'Planejado', values: weeks.map((w) => w.planned + w.added) },
            { name: 'Concluído', values: weeks.map((w) => w.completed) },
          ],
          height: 190,
          ariaLabel: 'Planejado × realizado por semana',
        }),
      }),
    ],
  });
}

export function capacitySection(m, delta, asOfText) {
  const c = m.capacity;
  const eva = estimateVsActual(c.estimatedMinutesCompleted, c.actualSecondsCompleted);
  const evaValue = eva.ratio === null ? { text: '—', unit: '', empty: c.actualSecondsCompleted === 0 } : { text: formatRatio(eva.ratio), unit: 'do estimado' };
  const evaState = { under: 'abaixo da estimativa', on: 'dentro da estimativa (±10%)', over: 'acima da estimativa' }[eva.state] || null;
  const totalSeconds = c.hoursByProject.reduce((n, item) => n + item.seconds, 0);
  const openHours = c.estimatedMinutesOpen / 60;
  const doneHours = c.actualSecondsInRange / 3600;
  const hoursFmt = (v) => `${formatNumber(v, v < 100 ? 1 : 0)} h`;
  const series = c.wipSeries;

  return section({
    id: 'capacity',
    title: 'Capacidade',
    iconName: 'layers',
    description: `Trabalho em aberto ${asOfText} e horas estimadas × realizadas.`,
    children: [
      metricCard({ key: 'wip', value: formatValue(c.wip, 'count', TASK_NOUNS), delta: delta('capacity.wip', 'count', TASK_NOUNS), secondary: `${valueText(c.inFlight, 'count', { one: 'iniciada', many: 'iniciadas' })} no total` }),
      metricCard({ key: 'pending', value: formatValue(c.pending, 'count', TASK_NOUNS), delta: delta('capacity.pending', 'count', TASK_NOUNS), secondary: 'nem concluídas nem canceladas' }),
      metricCard({ key: 'avgOpenAgeDays', label: 'Idade média das abertas', value: formatValue(c.avgOpenAgeDays, 'days'), delta: delta('capacity.avgOpenAgeDays', 'days'), secondary: 'desde a criação' }),
      metricCard({
        key: 'estimatedMinutesCompleted',
        label: 'Estimado × realizado',
        help: 'Tempo apontado (em qualquer data) nas tarefas concluídas no período, dividido pela soma das estimativas delas. Dentro de ±10% conta como dentro da estimativa.',
        value: evaValue,
        secondary:
          eva.ratio === null
            ? c.actualSecondsCompleted
              ? `${formatDuration(c.actualSecondsCompleted)} apontadas, sem estimativa`
              : null
            : `${formatDuration(c.actualSecondsCompleted)} de ${formatDuration(c.estimatedMinutesCompleted * 60)} · ${evaState}`,
        tone: eva.state === 'over' ? 'warning' : null,
      }),
      chartCard({
        key: 'hoursCompare',
        title: 'Horas estimadas × realizadas',
        help: 'Estimadas: soma das estimativas das tarefas em aberto na data de referência. Realizadas: soma de todos os apontamentos de tempo feitos em dias do período.',
        chart: hbarList({
          items: [
            { label: 'Estimadas', hint: 'tarefas em aberto', value: openHours, color: '--chart-1', title: `Estimativa das tarefas em aberto: ${hoursFmt(openHours)}` },
            { label: 'Realizadas', hint: 'apontadas no período', value: doneHours, color: '--chart-2', title: `Tempo apontado no período: ${hoursFmt(doneHours)}` },
          ],
          format: hoursFmt,
          ariaLabel: 'Horas estimadas em aberto e horas realizadas no período',
        }),
      }),
      chartCard({
        key: 'hoursByProject',
        title: 'Distribuição de horas por projeto',
        chart: hbarList({
          items: c.hoursByProject.slice(0, 8).map((item) => ({
            label: item.name,
            value: item.seconds,
            hint: totalSeconds ? `${formatRatio(item.seconds / totalSeconds)} do tempo` : null,
          })),
          format: (s) => formatDuration(s),
          emptyText: 'Nenhum apontamento de tempo no período',
          ariaLabel: 'Tempo apontado por projeto',
        }),
        aside: totalSeconds ? h('span', { class: 'v-metricas-aside-values tabular' }, `${formatDuration(totalSeconds)} no total`) : null,
      }),
      chartCard({
        key: 'wipSeries',
        title: 'WIP ao longo do período',
        caption: series.length && m.range.days > 62 ? 'Situação no fim de cada semana' : 'Situação no fim de cada dia',
        span: 'span-full',
        chart: lineChart({
          series: [
            { name: 'Em andamento', points: series.map((p) => ({ x: weekLabel(p.date), y: p.wip })) },
            { name: 'Em aberto', points: series.map((p) => ({ x: weekLabel(p.date), y: p.open })) },
          ],
          height: 190,
          ariaLabel: 'Tarefas em andamento e em aberto ao longo do período',
        }),
      }),
    ],
  });
}

function impedimentList(app, imp) {
  if (!imp.items.length) {
    return emptyState({ icon: 'check-circle', title: 'Nada travado agora', text: 'Nenhuma tarefa bloqueada ou aguardando terceiros.', compact: true });
  }
  const byId = new Map(imp.items.map((item) => [item.task.id, item]));
  const since = (task) => {
    const item = byId.get(task.id);
    if (!item) return null;
    return h(
      'span',
      { class: cx('v-metricas-since', item.category === 'blocked' ? 'is-blocked' : 'is-waiting'), title: `${item.category === 'blocked' ? 'Bloqueada' : 'Aguardando terceiros'} desde ${formatDateTime(item.since)}` },
      icon(item.category === 'blocked' ? 'lock' : 'hourglass', { size: 12 }),
      h('span', { class: 'tabular' }, `há ${elapsedText(item.seconds)}`),
    );
  };
  return h(
    'div',
    { class: 'v-metricas-implist', role: 'list', 'aria-label': 'Tarefas impedidas há mais tempo' },
    imp.items.map((item) =>
      taskRow(app, item.task, {
        columns: ['title', since, 'status'],
        showDemand: true,
        class: 'v-metricas-improw',
        attrs: { role: 'listitem' },
      }),
    ),
    imp.total > imp.items.length ? h('div', { class: 'v-metricas-more' }, `e mais ${imp.total - imp.items.length}`) : null,
  );
}

export function blockingSection(app, m, delta, asOfText, imp) {
  const b = m.blocking;
  const inRange = b.blockedHoursInRange > 0 ? `${valueText(b.blockedHoursInRange, 'hours')} bloqueadas no período` : 'nenhuma hora bloqueada no período';
  return section({
    id: 'blocking',
    title: 'Bloqueios',
    iconName: 'lock',
    description: `Impedimentos ${asOfText}, dependências em aberto e esperas por terceiros.`,
    children: [
      metricCard({ key: 'blockedNow', label: 'Bloqueadas', value: formatValue(b.blockedNow, 'count', TASK_NOUNS), delta: delta('blocking.blockedNow', 'count', TASK_NOUNS), secondary: inRange, tone: b.blockedNow > 0 ? 'danger' : null }),
      metricCard({
        key: 'avgBlockedHours',
        label: 'Tempo médio bloqueado',
        value: formatValue(b.avgBlockedHours, 'hours'),
        delta: delta('blocking.avgBlockedHours', 'hours'),
        secondary: 'por bloqueio, inclusive os em curso',
      }),
      metricCard({
        key: 'pendingDependencies',
        value: formatValue(b.pendingDependencies, 'count', DEP_NOUNS),
        delta: delta('blocking.pendingDependencies', 'count', DEP_NOUNS),
        secondary: b.blockedByDependency ? `${valueText(b.blockedByDependency, 'count', { one: 'tarefa travada', many: 'tarefas travadas' })}` : null,
      }),
      metricCard({
        key: 'waitingNow',
        value: formatValue(b.waitingNow, 'count', TASK_NOUNS),
        delta: delta('blocking.waitingNow', 'count', TASK_NOUNS),
        secondary: b.avgWaitingHours === null ? null : `espera média de ${valueText(b.avgWaitingHours, 'hours')}`,
        tone: b.waitingNow > 0 ? 'warning' : null,
      }),
      chartCard({
        key: 'impediments',
        title: 'Impedidas há mais tempo',
        help: 'Tarefas bloqueadas ou aguardando terceiros AGORA, ordenadas pelo início do impedimento atual (reconstruído a partir do histórico de status).',
        caption: imp.total ? `Bloqueadas ou aguardando terceiros agora · ${valueText(imp.total, 'count', TASK_NOUNS)}` : null,
        span: 'span-full',
        chart: impedimentList(app, imp),
      }),
    ],
  });
}
