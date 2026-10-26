import { createDemoCalendar } from './demo-dates.js';

const isEnglish = document.documentElement.lang === 'en';
const demoLocale = isEnglish ? 'en-US' : 'es-MX';
const demoTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let demoCalendar = createDemoCalendar(new Date(), demoLocale, demoTimeZone);
const header = document.querySelector('.header');
function updateHeaderAppearance() {
  header?.classList.toggle('is-scrolled', window.scrollY > 12);
}
updateHeaderAppearance();
window.addEventListener('scroll', updateHeaderAppearance, { passive: true });
window.addEventListener('pageshow', updateHeaderAppearance);

const connectionUrl = document.querySelector('#connection-url');
const copyConnectionUrl = document.querySelector('#copy-connection-url');
const connectionStatus = document.querySelector('#copy-connection-status');
if (connectionUrl instanceof HTMLInputElement && copyConnectionUrl instanceof HTMLButtonElement) {
  copyConnectionUrl.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(connectionUrl.value);
      if (connectionStatus)
        connectionStatus.textContent = isEnglish ? 'Server URL copied.' : 'Dirección copiada.';
    } catch {
      connectionUrl.focus();
      connectionUrl.select();
      if (connectionStatus)
        connectionStatus.textContent = isEnglish
          ? 'Select and copy the server URL.'
          : 'Selecciona y copia la dirección del servidor.';
    }
  });
}

const demoAmounts = isEnglish
  ? {
      currency: 'USD',
      expenseMinor: 4500n,
      incomeMinor: 420000n,
      foodMinor: 42000n,
      foodBudgetMinor: 35000n,
      transportMinor: 18500n,
      groceriesMinor: 36000n,
      utilitiesMinor: 7999n,
      savings: { savedMinor: 120000n, targetMinor: 300000n },
      contributionMinor: 10000n,
      musicMinor: 1099n,
      rentMinor: 140000n,
      internetMinor: 5999n,
      statement: {
        foodMinor: 42000n,
        groceriesMinor: 56000n,
        transportMinor: 24500n,
        servicesMinor: 12999n,
      },
    }
  : {
      currency: 'MXN',
      expenseMinor: 45000n,
      incomeMinor: 1800000n,
      foodMinor: 235000n,
      foodBudgetMinor: 200000n,
      transportMinor: 185000n,
      groceriesMinor: 180000n,
      utilitiesMinor: 49900n,
      savings: { savedMinor: 800000n, targetMinor: 2000000n },
      contributionMinor: 50000n,
      musicMinor: 19900n,
      rentMinor: 850000n,
      internetMinor: 49900n,
      statement: {
        foodMinor: 325000n,
        groceriesMinor: 280000n,
        transportMinor: 185000n,
        servicesMinor: 99900n,
      },
    };
const monthlyFoodMinor = demoAmounts.foodMinor;
const suggestedFoodBudgetMinor = demoAmounts.foodBudgetMinor;
const potentialFoodSavingsMinor = monthlyFoodMinor - suggestedFoodBudgetMinor;
const monthlyCategories = [
  {
    title: isEnglish ? 'Food & drinks' : 'Comida y bebidas',
    count: 6,
    amountMinor: monthlyFoodMinor,
    color: '#a7d6bc',
  },
  {
    title: isEnglish ? 'Transport' : 'Transporte',
    count: 4,
    amountMinor: demoAmounts.transportMinor,
    color: '#a5c9ee',
  },
  {
    title: isEnglish ? 'Groceries' : 'Supermercado',
    count: 3,
    amountMinor: demoAmounts.groceriesMinor,
    color: '#b8a5da',
  },
  {
    title: isEnglish ? 'Utilities' : 'Servicios',
    count: 1,
    amountMinor: demoAmounts.utilitiesMinor,
    color: '#deb985',
  },
];
const statementCategories = [
  {
    title: isEnglish ? 'Food & drinks' : 'Comida y bebidas',
    count: 8,
    amount: demoAmounts.statement.foodMinor,
  },
  {
    title: isEnglish ? 'Groceries' : 'Supermercado',
    count: 5,
    amount: demoAmounts.statement.groceriesMinor,
  },
  {
    title: isEnglish ? 'Transport' : 'Transporte',
    count: 4,
    amount: demoAmounts.statement.transportMinor,
  },
  {
    title: isEnglish ? 'Utilities' : 'Servicios',
    count: 3,
    amount: demoAmounts.statement.servicesMinor,
  },
];
const statementCount = statementCategories.reduce((count, item) => count + item.count, 0);
const monthlyTotal = monthlyCategories.reduce((total, item) => total + item.amountMinor, 0n);
const savingsGoal = demoAmounts.savings;
const savingsPercent = Number((savingsGoal.savedMinor * 100n) / savingsGoal.targetMinor);
const demoIncomeMinor = demoAmounts.incomeMinor;
const demoNetMinor = demoIncomeMinor - monthlyTotal;
const monthlyCount = monthlyCategories.reduce((count, item) => count + item.count, 0);
const integerFormat = new Intl.NumberFormat(isEnglish ? 'en-US' : 'es-MX');

/** @param {bigint} amountMinor */
function formatAmount(amountMinor) {
  return `$${integerFormat.format(amountMinor / 100n)}.${String(amountMinor % 100n).padStart(2, '0')}`;
}

/** @param {bigint} amountMinor */
function formatCurrencyAmount(amountMinor) {
  return `${formatAmount(amountMinor)} ${demoAmounts.currency}`;
}

/** @param {bigint} amountMinor */
function formatUserAmount(amountMinor) {
  return amountMinor % 100n === 0n
    ? `$${integerFormat.format(amountMinor / 100n)}`
    : formatAmount(amountMinor);
}

const savedExpenseAmount = document.getElementById('saved-expense-amount');
if (savedExpenseAmount) savedExpenseAmount.textContent = formatAmount(demoAmounts.expenseMinor);
const expenseAmount = document.getElementById('demo-expense-amount');
if (expenseAmount) expenseAmount.textContent = formatCurrencyAmount(demoAmounts.expenseMinor);

function createUpcomingRows() {
  const labels = {
    music: { title: isEnglish ? 'Music' : 'Música', amount: demoAmounts.musicMinor },
    rent: { title: isEnglish ? 'Rent' : 'Renta', amount: demoAmounts.rentMinor },
    internet: { title: 'Internet', amount: demoAmounts.internetMinor },
  };
  return demoCalendar.upcomingPayments.map((payment) => ({
    title: labels[payment.id].title,
    detail: `${payment.label} · ${isEnglish ? 'Monthly' : 'Mensual'}`,
    value: formatCurrencyAmount(labels[payment.id].amount),
  }));
}

const scenarios = isEnglish
  ? {
      record: {
        action: 'Recording the expense',
        prompt: `I spent ${formatUserAmount(demoAmounts.expenseMinor)} on gas today.`,
        reply: 'Done, your expense has been recorded.',
        followup: 'Want to see how much you’ve spent on transport this month?',
        suggestion: 'How much did I spend this month?',
      },
      income: {
        action: 'Recording the income',
        prompt: `I got paid ${formatUserAmount(demoIncomeMinor)} today. Log it as salary.`,
        reply: 'Done, your income has been recorded.',
        followup: 'Want a breakdown of your income this month?',
        suggestion: 'Show me my income this month.',
      },
      month: {
        action: 'Checking this month’s expenses',
        prompt: 'How much did I spend this month?',
        reply: 'Here’s your spending so far this month:',
        followup: 'Want to compare your spending with last month?',
        suggestion: 'Compare my spending with last month.',
      },
      recurring: {
        action: 'Checking recurring payments',
        prompt: 'What recurring payments do I have coming up?',
        reply: 'Here are your upcoming recorded recurring payments:',
        rows: createUpcomingRows(),
        followup: 'Want to see the details of a payment?',
        suggestion: 'Show me the details for rent.',
      },
      plan: {
        action: 'Checking your savings goal',
        prompt: 'How are my savings for the trip coming along?',
        reply: 'Here’s your progress toward the trip:',
        followup: 'Want to record a contribution?',
        suggestion: `Add ${formatUserAmount(demoAmounts.contributionMinor)} to my trip savings goal.`,
      },
      insights: {
        action: 'Reviewing your recorded spending',
        prompt: 'Where could I cut back on spending?',
        reply: 'Based on your recorded expenses, here’s one place to start:',
        followup: 'Want to set a food budget for next month?',
        suggestion: `Set next month’s food budget to ${formatUserAmount(suggestedFoodBudgetMinor)}.`,
      },
    }
  : {
      record: {
        action: 'Registrando el gasto',
        prompt: `Gasté ${formatUserAmount(demoAmounts.expenseMinor)} en gasolina hoy.`,
        reply: 'Listo, tu gasto quedó registrado.',
        followup: '¿Quieres ver cuánto llevas en transporte este mes?',
        suggestion: '¿Cuánto gasté este mes?',
      },
      income: {
        action: 'Registrando el ingreso',
        prompt: `Registra mi sueldo de hoy: ${formatUserAmount(demoIncomeMinor)}.`,
        reply: 'Listo, tu ingreso quedó registrado.',
        followup: '¿Quieres ver el detalle de tus ingresos del mes?',
        suggestion: 'Muéstrame mis ingresos de este mes.',
      },
      month: {
        action: 'Consultando los gastos del mes',
        prompt: '¿Cuánto gasté este mes?',
        reply: 'Así van tus gastos de este mes:',
        followup: '¿Quieres comparar tus gastos con el mes pasado?',
        suggestion: 'Compara mis gastos con el mes pasado.',
      },
      recurring: {
        action: 'Consultando los pagos recurrentes',
        prompt: '¿Qué pagos recurrentes tengo próximos?',
        reply: 'Estos son tus próximos pagos recurrentes registrados:',
        rows: createUpcomingRows(),
        followup: '¿Quieres ver el detalle de alguno?',
        suggestion: 'Muéstrame el detalle de la renta.',
      },
      plan: {
        action: 'Consultando la meta de ahorro',
        prompt: '¿Cómo va mi ahorro para el viaje?',
        reply: 'Así va tu meta para el viaje:',
        followup: '¿Quieres registrar una aportación?',
        suggestion: `Agrega ${formatUserAmount(demoAmounts.contributionMinor)} a mi meta del viaje.`,
      },
      insights: {
        action: 'Analizando tus gastos registrados',
        prompt: '¿En qué podría reducir mis gastos?',
        reply: 'Con base en tus gastos registrados, podrías empezar por aquí:',
        followup: '¿Quieres crear un presupuesto de comida para el próximo mes?',
        suggestion: `Pon un presupuesto de ${formatUserAmount(suggestedFoodBudgetMinor)} para comida el próximo mes.`,
      },
    };

const tabs = [...document.querySelectorAll('[data-scenario]')];
const expenseFormats = [...document.querySelectorAll('[data-expense-format]')];
/** @type {'text' | 'receipt' | 'pdf' | 'voice'} */
let currentExpenseFormat = 'text';
const expenseVariants = isEnglish
  ? {
      text: scenarios.record,
      receipt: {
        ...scenarios.record,
        prompt: 'Record the expense from this receipt.',
        action: 'Recording the receipt expense',
      },
      pdf: {
        prompt: 'Record the expenses from my bank statement.',
        action: 'Recording the statement expenses',
        reply: `${statementCount} expenses saved.`,
        followup: 'Want to see your updated monthly spending?',
        suggestion: 'How much did I spend this month?',
      },
      voice: {
        ...scenarios.record,
        prompt: `I spent ${formatUserAmount(demoAmounts.expenseMinor)} on gas this morning.`,
      },
    }
  : {
      text: scenarios.record,
      receipt: {
        ...scenarios.record,
        prompt: 'Registra el gasto de este recibo.',
        action: 'Registrando el gasto del recibo',
      },
      pdf: {
        prompt: 'Registra los gastos de mi estado de cuenta.',
        action: 'Registrando los gastos del estado de cuenta',
        reply: `${statementCount} gastos guardados.`,
        followup: '¿Quieres ver cómo quedan tus gastos del mes?',
        suggestion: '¿Cuánto gasté este mes?',
      },
      voice: {
        ...scenarios.record,
        prompt: `Gasté ${formatUserAmount(demoAmounts.expenseMinor)} en gasolina esta mañana.`,
      },
    };

function activeScenario() {
  return currentScenario === 'record'
    ? expenseVariants[currentExpenseFormat]
    : scenarios[currentScenario];
}

const panel = document.getElementById('demo-panel');
const goalView = document.getElementById('demo-goal');
const monthView = document.getElementById('demo-month');
const recurringView = document.getElementById('demo-recurring');
const expenseView = document.getElementById('demo-expense');
const incomeView = document.getElementById('demo-income');
const insightsView = document.getElementById('demo-insights');
const importView = document.getElementById('demo-import');
const composer = document.getElementById('demo-input');
const transcript = document.querySelector('.demo-transcript');
const promptElement = document.getElementById('demo-prompt');
const reply = document.getElementById('demo-reply');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const mobileViewport = matchMedia('(max-width: 680px)');
/** @type {keyof typeof scenarios} */
let currentScenario = 'record';
let controller = new AbortController();
let hasPlayed = false;

/** @param {number} duration @param {AbortSignal} signal @returns {Promise<boolean>} */
function wait(duration, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(finish, duration);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** @param {HTMLElement | null} element @param {string} text @param {number} duration @param {AbortSignal} signal */
async function typeText(element, text, duration, signal) {
  if (!element) return !signal.aborted;
  const characters = [...text];
  const started = performance.now();
  element.textContent = '';
  while (!signal.aborted) {
    const progress = Math.min((performance.now() - started) / duration, 1);
    element.textContent = characters.slice(0, Math.ceil(characters.length * progress)).join('');
    if (progress === 1) return true;
    if (!(await wait(24, signal))) return false;
  }
  return false;
}

function renderMonthlyChart() {
  const total = document.getElementById('demo-month-total');
  const count = document.getElementById('demo-month-count');
  const legend = document.getElementById('demo-chart-legend');
  const segments = document.getElementById('demo-donut-segments');
  if (total) total.textContent = formatCurrencyAmount(monthlyTotal);
  if (count) count.textContent = String(monthlyCount);
  let offset = 0;
  for (const item of monthlyCategories) {
    // Money stays in integer cents; floating point is used only for SVG geometry.
    const percentage = Number((item.amountMinor * 10000n) / monthlyTotal) / 100;
    const length = percentage - 1;
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [name, value] of Object.entries({
      cx: '90',
      cy: '90',
      r: '65',
      pathLength: '100',
      stroke: item.color,
      'stroke-dasharray': `${length} ${100 - length}`,
      'stroke-dashoffset': String(-offset),
      class: 'donut-segment',
    }))
      segment.setAttribute(name, value);
    segments?.append(segment);
    offset += percentage;

    const entry = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'chart-key';
    dot.style.backgroundColor = item.color;
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = item.title;
    const amount = document.createElement('strong');
    amount.textContent = formatAmount(item.amountMinor);
    entry.append(dot, title, amount);
    legend?.append(entry);
  }
}
renderMonthlyChart();

const statementRows = document.getElementById('demo-import-rows');
for (const entry of statementCategories) {
  const row = document.createElement('tr');
  for (const value of [entry.title, String(entry.count), formatAmount(entry.amount)]) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }
  statementRows?.append(row);
}
const statementTotal = document.getElementById('demo-import-total');
if (statementTotal)
  statementTotal.textContent = formatCurrencyAmount(
    statementCategories.reduce((sum, entry) => sum + entry.amount, 0n),
  );

function renderUpcomingPayments() {
  const upcomingList = document.getElementById('demo-upcoming-list');
  upcomingList?.replaceChildren();
  for (const item of scenarios.recurring.rows) {
    const card = document.createElement('li');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#repeat');
    icon.append(use);
    const details = document.createElement('div');
    details.className = 'upcoming-details';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const date = document.createElement('span');
    date.textContent = item.detail;
    details.append(title, date);
    const amount = document.createElement('strong');
    amount.className = 'upcoming-amount';
    amount.textContent = item.value;
    card.append(icon, details, amount);
    upcomingList?.append(card);
  }
}

for (const [id, amount] of [
  ['demo-income-amount', `+${formatCurrencyAmount(demoIncomeMinor)}`],
  ['demo-income-total', `+${formatAmount(demoIncomeMinor)}`],
  ['demo-income-expenses', `−${formatAmount(monthlyTotal)}`],
  ['demo-income-net', `+${formatAmount(demoNetMinor)}`],
]) {
  if (typeof id !== 'string' || typeof amount !== 'string') continue;
  const element = document.getElementById(id);
  if (element) element.textContent = amount;
}

for (const [id, value] of [
  ['demo-goal-saved', formatAmount(savingsGoal.savedMinor)],
  ['demo-goal-target', formatCurrencyAmount(savingsGoal.targetMinor)],
  ['demo-goal-percent', `${savingsPercent}% ${isEnglish ? 'complete' : 'completado'}`],
  [
    'demo-goal-remaining',
    isEnglish
      ? `${formatCurrencyAmount(savingsGoal.targetMinor - savingsGoal.savedMinor)} to go`
      : `Faltan ${formatCurrencyAmount(savingsGoal.targetMinor - savingsGoal.savedMinor)}`,
  ],
]) {
  if (typeof id !== 'string' || typeof value !== 'string') continue;
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}
const goalProgress = document.getElementById('demo-goal-progress');
goalProgress?.setAttribute('aria-valuenow', String(savingsPercent));
goalProgress?.setAttribute(
  'aria-valuetext',
  `${formatAmount(savingsGoal.savedMinor)} ${isEnglish ? 'of' : 'de'} ${formatCurrencyAmount(savingsGoal.targetMinor)}`,
);
const goalFill = document.querySelector('.goal-progress-fill');
if (goalFill instanceof HTMLElement) goalFill.style.width = `${savingsPercent}%`;

for (const [id, amount] of [
  ['demo-insights-current', monthlyFoodMinor],
  ['demo-insights-target', suggestedFoodBudgetMinor],
  ['demo-insights-savings', potentialFoodSavingsMinor],
]) {
  if (typeof id !== 'string' || typeof amount !== 'bigint') continue;
  const element = document.getElementById(id);
  if (element) element.textContent = formatCurrencyAmount(amount);
}

function renderScenario() {
  const scenario = activeScenario();
  const isExpense = currentScenario === 'record';
  const isStatement = isExpense && currentExpenseFormat === 'pdf';
  if (panel) {
    panel.dataset.view = currentScenario;
    panel.dataset.inputFormat = currentExpenseFormat;
  }
  const formats = document.getElementById('expense-formats');
  if (formats) formats.hidden = !isExpense;
  for (const button of expenseFormats)
    button.setAttribute(
      'aria-pressed',
      String(button.getAttribute('data-expense-format') === currentExpenseFormat),
    );
  const attachment = document.getElementById('demo-attachment');
  if (attachment) attachment.hidden = !isExpense || currentExpenseFormat === 'text';
  for (const format of ['receipt', 'pdf', 'voice']) {
    const element = document.getElementById(`demo-${format}-attachment`);
    if (element) element.hidden = !isExpense || currentExpenseFormat !== format;
  }
  if (goalView) goalView.hidden = currentScenario !== 'plan';
  if (monthView) monthView.hidden = currentScenario !== 'month';
  if (recurringView) recurringView.hidden = currentScenario !== 'recurring';
  if (expenseView) expenseView.hidden = !isExpense || isStatement;
  if (importView) importView.hidden = !isStatement;
  if (incomeView) incomeView.hidden = currentScenario !== 'income';
  if (insightsView) insightsView.hidden = currentScenario !== 'insights';
  const isVoice = isExpense && currentExpenseFormat === 'voice';
  if (promptElement) {
    promptElement.textContent = scenario.prompt;
    promptElement.hidden = isVoice;
  }
  const voiceTranscript = document.getElementById('demo-voice-transcript');
  if (voiceTranscript) voiceTranscript.textContent = expenseVariants.voice.prompt;
  if (reply) reply.textContent = scenario.reply;
  const followup = document.getElementById('demo-followup');
  if (followup) followup.textContent = scenario.followup;
  if (composer instanceof HTMLInputElement) composer.placeholder = scenario.suggestion;
}

/** @param {'asking' | 'working' | 'answering' | 'results' | 'complete'} phase */
function setPhase(phase) {
  if (panel) panel.dataset.phase = phase;
  panel?.setAttribute('aria-busy', String(phase !== 'complete'));
  const toolLabel = document.getElementById('demo-tool-label');
  if (toolLabel) {
    toolLabel.textContent =
      phase === 'working'
        ? activeScenario().action
        : isEnglish
          ? 'Used ContaMCP'
          : 'Se usó ContaMCP';
  }
}

function finishScenario() {
  hasPlayed = true;
  controller.abort();
  renderScenario();
  setPhase('complete');
}

function scrollTranscript() {
  if (transcript instanceof HTMLElement) {
    const featuredResult =
      currentScenario === 'month'
        ? monthView
        : currentScenario === 'income' || currentScenario === 'insights'
          ? reply
          : null;
    transcript.scrollTo({
      top: featuredResult
        ? featuredResult.getBoundingClientRect().top -
          transcript.getBoundingClientRect().top +
          transcript.scrollTop -
          5
        : transcript.scrollHeight,
      behavior: motionPreference.matches ? 'instant' : 'smooth',
    });
  }
}

/** @param {AbortSignal} signal @param {boolean} waitForEntrance */
async function animateScenario(signal, waitForEntrance) {
  const scenario = activeScenario();
  if (waitForEntrance) {
    const animations = document.querySelector('.demo-layout')?.getAnimations() ?? [];
    await Promise.allSettled(animations.map((animation) => animation.finished));
    if (signal.aborted) return;
  }
  if (!(await wait(300, signal))) return;
  setPhase('working');
  if (!(await wait(650, signal))) return;
  setPhase('answering');
  if (!(await typeText(reply, scenario.reply, Math.min(1100, scenario.reply.length * 16), signal)))
    return;
  setPhase('results');
  scrollTranscript();
  let resultDuration = 485;
  if (currentScenario === 'month') resultDuration = 1000;
  else if (currentScenario === 'plan') resultDuration = 800;
  else if (currentScenario === 'recurring')
    resultDuration = 420 + scenarios.recurring.rows.length * 65;
  if (!(await wait(resultDuration, signal))) return;
  setPhase('complete');
  scrollTranscript();
}

/** @param {Element} selectedTab @param {boolean} [waitForEntrance] */
function selectScenario(selectedTab, waitForEntrance = false) {
  const name = selectedTab.getAttribute('data-scenario');
  if (
    name !== 'record' &&
    name !== 'income' &&
    name !== 'month' &&
    name !== 'recurring' &&
    name !== 'plan' &&
    name !== 'insights'
  )
    return;
  controller.abort();
  controller = new AbortController();
  currentScenario = name;
  hasPlayed = true;
  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('tabindex', selected ? '0' : '-1');
  }
  panel?.setAttribute('aria-labelledby', selectedTab.id);
  renderScenario();
  if (motionPreference.matches || document.hidden) {
    setPhase('complete');
    return;
  }
  if (transcript instanceof HTMLElement) transcript.scrollTop = 0;
  if (reply) reply.textContent = '';
  setPhase('asking');
  void animateScenario(controller.signal, waitForEntrance);
}

function scrollDemoIntoView() {
  if (!mobileViewport.matches) return;
  const demoWindow = panel?.closest('.demo-window');
  if (!demoWindow) return;
  const bounds = demoWindow.getBoundingClientRect();
  const targetTop = Math.max(0, header?.getBoundingClientRect().bottom ?? 0) + 16;
  const viewportBottom = window.innerHeight - 16;
  const availableHeight = viewportBottom - targetTop;
  if (availableHeight <= 0) return;
  const visibleHeight = Math.min(bounds.bottom, viewportBottom) - Math.max(bounds.top, targetTop);
  // Keep the page still when most of the available demo area is already visible.
  if (bounds.top >= targetTop && visibleHeight >= Math.min(bounds.height, availableHeight) * 0.8)
    return;
  window.scrollTo({
    top: Math.max(0, window.scrollY + bounds.top - targetTop),
    behavior: motionPreference.matches ? 'instant' : 'smooth',
  });
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => {
    selectScenario(tab);
    scrollDemoIntoView();
  });
  tab.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    let nextIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (nextTab instanceof HTMLElement) {
      nextTab.focus();
      selectScenario(nextTab);
    }
  });
}

for (const button of expenseFormats) {
  button.addEventListener('click', () => {
    const format = button.getAttribute('data-expense-format');
    if (format !== 'text' && format !== 'receipt' && format !== 'pdf' && format !== 'voice') return;
    currentExpenseFormat = format;
    const expenseTab = tabs.find((tab) => tab.getAttribute('data-scenario') === 'record');
    if (expenseTab) {
      selectScenario(expenseTab);
      scrollDemoIntoView();
    }
  });
}

function renderDemoDates() {
  scenarios.income.suggestion = isEnglish
    ? `Show me my income for ${demoCalendar.monthName}.`
    : `Muéstrame mis ingresos de ${demoCalendar.monthName}.`;
  scenarios.month.reply = isEnglish
    ? `Here’s your spending for ${demoCalendar.monthName} so far:`
    : `Así van tus gastos de ${demoCalendar.monthName}, hasta hoy:`;
  scenarios.month.suggestion = isEnglish
    ? `Compare my spending with ${demoCalendar.previousMonth}.`
    : `Compara mis gastos con ${demoCalendar.previousMonth}.`;
  scenarios.recurring.rows = createUpcomingRows();
  renderUpcomingPayments();
  const dates = {
    today: demoCalendar.today,
    month: demoCalendar.month,
    range: demoCalendar.range,
    goalMonth: demoCalendar.goalMonth,
    statementFilename: demoCalendar.statementFilename,
  };
  for (const [name, label] of Object.entries(dates)) {
    for (const element of document.querySelectorAll(`[data-demo-date="${name}"]`))
      element.textContent = label;
  }
}

function refreshDemoDates() {
  const nextCalendar = createDemoCalendar(new Date(), demoLocale, demoTimeZone);
  if (nextCalendar.todayKey === demoCalendar.todayKey) return;
  demoCalendar = nextCalendar;
  renderDemoDates();
  if (hasPlayed) finishScenario();
  else renderScenario();
}
renderDemoDates();
renderScenario();
// Recheck on wake and while open so a tab left overnight does not keep yesterday's range.
window.setInterval(refreshDemoDates, 60_000);
window.addEventListener('pageshow', refreshDemoDates);

// The visitor's draft is independent of the scripted conversation.
composer?.addEventListener('focus', finishScenario);
function updateComposerAvailability() {
  if (!(composer instanceof HTMLInputElement)) return;
  composer.disabled = mobileViewport.matches;
  composer.setAttribute(
    'aria-label',
    isEnglish
      ? mobileViewport.matches
        ? 'Demo message field'
        : 'Type in the demo'
      : mobileViewport.matches
        ? 'Campo de mensaje de demostración'
        : 'Escribe en la demostración',
  );
  if (composer.disabled) composer.blur();
}
updateComposerAvailability();
mobileViewport.addEventListener('change', updateComposerAvailability);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshDemoDates();
  if (document.hidden && panel?.dataset.phase !== 'complete') finishScenario();
});
motionPreference.addEventListener('change', () => {
  if (motionPreference.matches) finishScenario();
});

if ('IntersectionObserver' in window) {
  const demoObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!hasPlayed && tabs[0]) selectScenario(tabs[0], true);
      demoObserver.disconnect();
    },
    { threshold: 0.5 },
  );
  const demoWindow = document.querySelector('.demo-window');
  if (demoWindow) demoObserver.observe(demoWindow);

  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('reveal-pending');
        revealObserver.unobserve(entry.target);
      }
    },
    { threshold: 0.08 },
  );
  if (!motionPreference.matches) {
    for (const section of document.querySelectorAll('[data-reveal]')) {
      section.classList.add('reveal-pending');
      revealObserver.observe(section);
    }
  }
}
