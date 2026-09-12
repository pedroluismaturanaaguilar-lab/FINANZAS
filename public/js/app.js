'use strict';
(function () {

  // =========================================================
  // 0. ESTADO EN MEMORIA (se sincroniza con el servidor)
  // =========================================================
  let STATE = null;

  async function checkAuth() {
    try {
      const res = await fetch('/api/session');
      const data = await res.json();
      if (!data.authenticated) { location.href = '/'; return false; }
      const el = document.getElementById('sessionUser');
      if (el) el.textContent = '👤 ' + data.user;
      return true;
    } catch (e) {
      location.href = '/';
      return false;
    }
  }

  async function loadState() {
    const res = await fetch('/api/state');
    if (res.status === 401) { location.href = '/'; throw new Error('no auth'); }
    STATE = await res.json();
  }

  async function saveCollection(name) {
    try {
      const res = await fetch('/api/collection/' + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(STATE[name]),
      });
      if (res.status === 401) { location.href = '/'; return; }
      if (!res.ok) toast('No se pudo guardar en el servidor', 'error');
    } catch (e) {
      toast('Sin conexión con el servidor: el cambio quedó solo en esta pantalla', 'error');
    }
  }

  const DB = {
    getWorkers: () => STATE.workers,
    setWorkers: (w) => { STATE.workers = w; saveCollection('workers'); },
    getAttendance: () => STATE.attendance,
    setAttendance: (a) => { STATE.attendance = a; saveCollection('attendance'); },
    getPayrolls: () => STATE.payrolls,
    setPayrolls: (p) => { STATE.payrolls = p; saveCollection('payrolls'); },
    getSettlements: () => STATE.settlements,
    setSettlements: (s) => { STATE.settlements = s; saveCollection('settlements'); },
    getHolidays: () => STATE.holidays,
    setHolidays: (h) => { STATE.holidays = h; saveCollection('holidays'); },
    getConfig: () => STATE.config,
    setConfig: (c) => { STATE.config = c; saveCollection('config'); },
    getWageHistory: () => STATE.wageHistory,
    setWageHistory: (w) => { STATE.wageHistory = w; saveCollection('wageHistory'); },
    getPendingOvertime: () => STATE.pendingOvertime,
    setPendingOvertime: (p) => { STATE.pendingOvertime = p; saveCollection('pendingOvertime'); },
    getNextId(list) { return list.length ? Math.max(...list.map(i => i.id || 0)) + 1 : 1; },
  };

  // =========================================================
  // 1. HELPERS DE FECHA / HORA / DINERO
  // =========================================================
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nowHHMM() {
    const n = new Date();
    return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
  }
  function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    if (isNaN(dt)) return '—';
    return dt.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function formatTime(t) { return t ? t.slice(0, 5) : '—'; }
  function formatMoney(v) {
    if (v === undefined || v === null || isNaN(v)) return '$0';
    return '$' + Math.round(v).toLocaleString('es-CO');
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function isSunday(dateStr) { return new Date(dateStr + 'T00:00:00').getDay() === 0; }
  function isHoliday(dateStr, holidays) { return (holidays || STATE.holidays).some(h => h.date === dateStr); }
  function parseTime(t) {
    if (!t) return null;
    const p = t.split(':');
    return { h: parseInt(p[0]) || 0, m: parseInt(p[1]) || 0 };
  }
  function timeToMinutes(t) { const p = parseTime(t); return p ? p.h * 60 + p.m : 0; }
  function daysBetweenInclusive(a, b) {
    const d1 = new Date(a + 'T00:00:00'), d2 = new Date(b + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000) + 1;
  }
  function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // =========================================================
  // 2. HISTORIAL SALARIAL: encontrar la tarifa vigente en una fecha
  // =========================================================
  function getRatesForDate(dateStr) {
    const history = STATE.wageHistory.slice().sort((a, b) => a.from.localeCompare(b.from));
    let match = history[0];
    for (const p of history) {
      if (p.from <= dateStr && (!p.to || dateStr <= p.to)) { match = p; break; }
      if (p.from <= dateStr) match = p;
    }
    return match;
  }

  function effectiveConfig(dateStr) {
    const period = getRatesForDate(dateStr);
    const admin = STATE.config;
    return {
      salary: period.salary, transport: period.transport,
      weeklyHours: period.weeklyHours, monthlyHours: period.monthlyHours,
      nightPremium: period.nightPremium, overtimeDay: period.overtimeDay,
      overtimeNight: period.overtimeNight, sundayPremium: period.sundayPremium,
      nightStart: period.nightStart || '19:00', nightEnd: period.nightEnd || '06:00',
      dailyHours: admin.dailyHours || 7, health: admin.health || 4, pension: admin.pension || 4,
      periodLabel: period.label,
    };
  }

  function isNightMinute(minOfDay, cfg) {
    const startM = timeToMinutes(cfg.nightStart), endM = timeToMinutes(cfg.nightEnd);
    if (startM > endM) return minOfDay >= startM || minOfDay < endM;
    return minOfDay >= startM && minOfDay < endM;
  }

  // =========================================================
  // 3. CÁLCULO DE UN DÍA TRABAJADO (usa la tarifa vigente en esa fecha)
  // =========================================================
  function computeDay(worker, date, entry, exit) {
    const cfg = effectiveConfig(date);
    const hourValue = cfg.salary / cfg.monthlyHours;
    const dailyHours = cfg.dailyHours;
    const nightPremium = cfg.nightPremium / 100, overtimeDayPct = cfg.overtimeDay / 100,
      overtimeNightPct = cfg.overtimeNight / 100, sundayPct = cfg.sundayPremium / 100;

    const isSun = isSunday(date);
    const isHol = isHoliday(date);
    const isRestDay = isSun || isHol;

    let entryM = timeToMinutes(entry), exitM = timeToMinutes(exit);
    if (exitM < entryM) exitM += 1440;
    const totalHours = (exitM - entryM) / 60;

    let dayMin = 0, nightMin = 0, current = entryM;
    while (current < exitM) {
      const minuteOfDay = current % 1440;
      const next = Math.min(exitM, current + 1);
      const diff = next - current;
      if (isNightMinute(minuteOfDay, cfg)) nightMin += diff; else dayMin += diff;
      current = next;
    }
    const dayHours = dayMin / 60, nightHours = nightMin / 60;

    let remaining = Math.min(totalHours, dailyHours);
    const takeDay = Math.min(remaining, dayHours);
    let regularDay = takeDay; remaining -= takeDay;
    const takeNight = Math.min(remaining, nightHours);
    let regularNight = takeNight; remaining -= takeNight;
    const extraDay = Math.max(0, dayHours - regularDay);
    const extraNight = Math.max(0, nightHours - regularNight);

    const valOrdDay = hourValue, valOrdNight = hourValue * (1 + nightPremium);
    const valExtraDay = hourValue * (1 + overtimeDayPct), valExtraNight = hourValue * (1 + overtimeNightPct);
    const valRestDay = hourValue * (1 + sundayPct);

    let payRegularDay = regularDay * valOrdDay, payRegularNight = regularNight * valOrdNight;
    let payExtraDay = extraDay * valExtraDay, payExtraNight = extraNight * valExtraNight, payRestDay = 0;
    if (isRestDay) {
      payRestDay = totalHours * valRestDay;
      payRegularDay = 0; payRegularNight = 0; payExtraDay = 0; payExtraNight = 0;
    }
    const totalPay = isRestDay ? payRestDay : (payRegularDay + payRegularNight + payExtraDay + payExtraNight);

    return {
      date, entry, exit,
      totalHours: round2(totalHours), dayHours: round2(dayHours), nightHours: round2(nightHours),
      regularDay: round2(regularDay), regularNight: round2(regularNight),
      extraDay: round2(extraDay), extraNight: round2(extraNight),
      isRestDay, isSunday: isSun, isHoliday: isHol,
      payRegularDay: round2(payRegularDay), payRegularNight: round2(payRegularNight),
      payExtraDay: round2(payExtraDay), payExtraNight: round2(payExtraNight),
      payRestDay: round2(payRestDay), totalPay: round2(totalPay),
      hourValue: round2(hourValue), periodLabel: cfg.periodLabel,
    };
  }

  // =========================================================
  // 4. UI HELPERS
  // =========================================================
  function toast(msg, type) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }
  function openModal(title, bodyHTML) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHTML;
    document.getElementById('modal').classList.add('open');
  }
  function closeModal() { document.getElementById('modal').classList.remove('open'); }
  function renderEmpty(container, icon, title, desc) {
    container.innerHTML = `<div class="empty-state"><span class="icon">${icon}</span><h4>${title}</h4><p>${desc}</p></div>`;
  }

  // =========================================================
  // 5. NAVEGACIÓN (con pila para el botón "Atrás")
  // =========================================================
  const SECTION_TITLES = {
    dashboard: 'Dashboard', workers: 'Trabajadores', attendance: 'Asistencia',
    payroll: 'Nómina', settlement: 'Liquidación', holidays: 'Festivos',
    wagehistory: 'Historial salarial', settings: 'Parámetros', manual: 'Manual de uso',
  };
  let sectionStack = ['dashboard'];

  function navigateTo(section, isBack) {
    if (!isBack) {
      if (sectionStack[sectionStack.length - 1] !== section) sectionStack.push(section);
    }
    document.querySelectorAll('.sidebar-nav button').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'section-' + section));
    document.getElementById('pageTitle').innerHTML = SECTION_TITLES[section] + ' <span class="subtitle">COS · Control Laboral</span>';

    if (section === 'dashboard') renderDashboard();
    else if (section === 'workers') renderWorkers();
    else if (section === 'attendance') { renderAttendance(); renderQuickAttendance(); }
    else if (section === 'payroll') renderPayroll();
    else if (section === 'settlement') renderSettlements();
    else if (section === 'holidays') renderHolidays();
    else if (section === 'wagehistory') renderWageHistory();
    else if (section === 'settings') renderSettings();
    else if (section === 'manual') renderManual();

    document.getElementById('sidebar').classList.remove('open');
  }

  document.getElementById('backBtn').addEventListener('click', function () {
    if (sectionStack.length > 1) {
      sectionStack.pop();
      navigateTo(sectionStack[sectionStack.length - 1], true);
    } else {
      navigateTo('dashboard', true);
    }
  });

  // =========================================================
  // 6. DASHBOARD
  // =========================================================
  function renderDashboard() {
    const workers = DB.getWorkers(), attendance = DB.getAttendance(), payrolls = DB.getPayrolls();
    document.getElementById('statWorkers').textContent = workers.length;
    document.getElementById('statActive').textContent = workers.filter(w => w.active !== false).length;
    const todayStr = today();
    const todayAtt = attendance.filter(a => a.date === todayStr);
    document.getElementById('statToday').textContent = todayAtt.length;
    const lastPay = payrolls.length ? payrolls[payrolls.length - 1] : null;
    document.getElementById('statPayroll').textContent = lastPay ? formatMoney(lastPay.totalNet) : '$0';

    renderCalendar();
    renderAccumulated();

    const actContainer = document.getElementById('dashboardActivity');
    const recent = attendance.slice(-5).reverse();
    if (!recent.length && !workers.length) {
      actContainer.innerHTML = `<div class="empty-state"><p>Registra asistencias para ver actividad.</p></div>`;
    } else {
      let html = `<div style="font-size:14px;line-height:1.8;">`;
      if (workers.length) html += `<strong>${workers.length}</strong> trabajadores. `;
      if (todayAtt.length) html += `Hoy <strong>${todayAtt.length}</strong> registros. `;
      if (lastPay) html += `Última nómina: <strong>${formatMoney(lastPay.totalNet)}</strong> (${formatDate(lastPay.startDate)} - ${formatDate(lastPay.endDate)})`;
      html += `</div>`;
      if (recent.length) {
        html += `<div style="margin-top:8px;font-size:13px;color:var(--text-light);">Últimas: `;
        recent.slice(0, 3).forEach(a => {
          const w = workers.find(w => w.id === a.workerId);
          html += `<span style="background:var(--bg-page);padding:2px 10px;border-radius:12px;margin:2px 4px;display:inline-block;">${w ? w.name : '—'} ${formatDate(a.date)}</span>`;
        });
        html += `</div>`;
      }
      actContainer.innerHTML = html;
    }
  }

  let calendarDate = new Date();
  function renderCalendar() {
    const year = calendarDate.getFullYear(), month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const holidays = DB.getHolidays(), todayStr = today();
    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    document.getElementById('calMonthYear').textContent = monthNames[month] + ' ' + year;

    let html = `<div class="calendar-grid">`;
    ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].forEach(d => html += `<div class="day-name">${d}</div>`);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = String(year) + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const isSun = isSunday(dateStr);
      const holidayMatch = holidays.find(h => h.date === dateStr);
      const isHol = !!holidayMatch;
      let classes = 'day-cell';
      if (isSun) classes += ' weekend';
      if (isHol) classes += ' holiday';
      if (dateStr === todayStr) classes += ' today';
      const gridStyle = d === 1 ? ` style="grid-column-start:${firstDay + 1};"` : '';
      const title = isHol ? ` title="${(holidayMatch.name || 'Festivo').replace(/"/g, '&quot;')}"` : (isSun ? ' title="Domingo"' : '');
      html += `<div class="${classes}"${gridStyle}${title}>${d}</div>`;
    }
    html += `</div>`;
    document.getElementById('calendarContainer').innerHTML = html;
  }
  document.getElementById('calPrev').addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); });
  document.getElementById('calNext').addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); });

  function renderAccumulated() {
    const container = document.getElementById('accumulatedSummary');
    const active = DB.getWorkers().filter(w => w.active !== false);
    if (!active.length) return renderEmpty(container, '📊', 'Sin trabajadores activos', 'Agrega trabajadores y registra asistencias.');

    const attendance = DB.getAttendance();
    const pendingList = DB.getPendingOvertime();
    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Trabajador</th><th>Tipo</th><th>Días con salida</th>
      <th>Normal + dominical/festivo</th><th>Extra de este período (próxima quincena)</th>
      <th>Extra pendiente (se paga ahora)</th><th>Acciones</th>
    </tr></thead><tbody>`;

    active.forEach(w => {
      const lastPay = w.lastPayDate || '2025-01-01';
      const atts = attendance.filter(a => a.workerId === w.id && !a.isAbsence && a.exit && a.date >= lastPay && a.date <= today());
      let regularAmount = 0, sundayAmount = 0, extraAmount = 0, extraHours = 0;
      atts.forEach(a => {
        regularAmount += (a.payRegularDay || 0) + (a.payRegularNight || 0);
        sundayAmount += a.payRestDay || 0;
        extraAmount += (a.payExtraDay || 0) + (a.payExtraNight || 0);
        extraHours += (a.extraDay || 0) + (a.extraNight || 0);
      });
      const duePending = pendingList.filter(p => p.workerId === w.id && !p.paid);
      const pendingAmount = duePending.reduce((s, p) => s + p.amount, 0);
      const pendingHours = duePending.reduce((s, p) => s + p.hours, 0);

      html += `<tr>
        <td><strong>${w.name}</strong></td>
        <td>${w.type === 'reemplazo' ? '🔄 Reemplazo' : '👤 Normal'}</td>
        <td>${atts.length}</td>
        <td>${formatMoney(regularAmount + sundayAmount)}</td>
        <td>${extraHours.toFixed(2)}h · ${formatMoney(extraAmount)}</td>
        <td>${pendingHours > 0 ? `<strong>${pendingHours.toFixed(2)}h · ${formatMoney(pendingAmount)}</strong>` : '—'}</td>
        <td>
          <button class="btn btn-success btn-sm" onclick="payWorker(${w.id})">💵 Pagar</button>
          <button class="btn btn-outline btn-sm" onclick="viewWorkerDetail(${w.id})">📄</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>
      <div style="margin-top:8px;font-size:13px;color:var(--text-light);">
        Al pagar se liquida el sueldo base, transporte, horas normales y recargo dominical/festivo del período, más las horas extra que quedaron pendientes de la quincena anterior. Las horas extra de este período se programan para pagarse en la próxima quincena.
      </div>`;
    container.innerHTML = html;
  }

  // =========================================================
  // 7. PAGAR TRABAJADOR (horas extra en quincena vencida)
  // =========================================================
  window.payWorker = function (workerId) {
    const workers = DB.getWorkers();
    const w = workers.find(x => x.id === workerId);
    if (!w) return toast('Trabajador no encontrado', 'error');

    const attendance = DB.getAttendance();
    const lastPay = w.lastPayDate || '2025-01-01';
    const todayStr = today();
    const atts = attendance.filter(a => a.workerId === workerId && !a.isAbsence && a.exit && a.date >= lastPay && a.date <= todayStr);
    if (!atts.length) return toast('No hay asistencias con salida registrada en este período para pagar', 'warning');

    let regularAmount = 0, regularHours = 0, nightHours = 0, sundayHours = 0, sundayAmount = 0;
    let extraDayHoursNow = 0, extraNightHoursNow = 0, extraAmountNow = 0, baseSalary = 0, transport = 0;

    atts.forEach(a => {
      regularAmount += (a.payRegularDay || 0) + (a.payRegularNight || 0);
      regularHours += a.regularDay || 0;
      nightHours += a.regularNight || 0;
      if (a.isRestDay) { sundayHours += a.totalHours || 0; sundayAmount += a.payRestDay || 0; }
      extraDayHoursNow += a.extraDay || 0;
      extraNightHoursNow += a.extraNight || 0;
      extraAmountNow += (a.payExtraDay || 0) + (a.payExtraNight || 0);
      const rates = getRatesForDate(a.date);
      baseSalary += rates.salary / 30;
      transport += rates.transport / 30;
    });

    const pendingList = DB.getPendingOvertime();
    const duePending = pendingList.filter(p => p.workerId === workerId && !p.paid);
    const overtimePaidNow = duePending.reduce((s, p) => s + p.amount, 0);
    const overtimeHoursPaidNow = duePending.reduce((s, p) => s + p.hours, 0);

    const cfg = DB.getConfig();
    const healthPct = (cfg.health || 4) / 100, pensionPct = (cfg.pension || 4) / 100;
    const healthDed = baseSalary * healthPct, pensionDed = baseSalary * pensionPct;
    const totalDed = healthDed + pensionDed;

    const totalDevengado = baseSalary + transport + regularAmount + sundayAmount + overtimePaidNow;
    const totalNet = totalDevengado - totalDed;

    const payrolls = DB.getPayrolls();
    const payrollId = DB.getNextId(payrolls);
    const payroll = {
      id: payrollId, workerId, startDate: lastPay, endDate: todayStr,
      baseSalary: round2(baseSalary), transportSubsidy: round2(transport),
      regularHours: round2(regularHours), nightHours: round2(nightHours),
      sundayHours: round2(sundayHours), sundayAmount: round2(sundayAmount),
      overtimeHoursPaidNow: round2(overtimeHoursPaidNow), overtimePaidNow: round2(overtimePaidNow),
      overtimeDayPending: round2(extraDayHoursNow), overtimeNightPending: round2(extraNightHoursNow),
      overtimePendingAmount: round2(extraAmountNow),
      totalDevengado: round2(totalDevengado),
      healthDeduction: round2(healthDed), pensionDeduction: round2(pensionDed), totalDeductions: round2(totalDed),
      totalNet: round2(totalNet), status: 'cerrada', createdAt: new Date().toISOString(), daysWorked: atts.length,
    };
    payrolls.push(payroll);
    DB.setPayrolls(payrolls);

    duePending.forEach(p => { p.paid = true; p.paidInPayrollId = payrollId; });
    if (extraDayHoursNow > 0 || extraNightHoursNow > 0) {
      pendingList.push({
        id: DB.getNextId(pendingList), workerId, periodFrom: lastPay, periodTo: todayStr,
        hours: round2(extraDayHoursNow + extraNightHoursNow),
        extraDay: round2(extraDayHoursNow), extraNight: round2(extraNightHoursNow),
        amount: round2(extraAmountNow), paid: false,
      });
    }
    DB.setPendingOvertime(pendingList);

    w.lastPayDate = todayStr;
    DB.setWorkers(workers);

    toast('Pago generado para ' + w.name + ' ✅', 'success');
    renderDashboard(); renderPayroll();
  };

  // =========================================================
  // 8. DETALLE DE TRABAJADOR (historial de entradas/salidas)
  // =========================================================
  window.viewWorkerDetail = function (workerId) {
    const w = DB.getWorkers().find(x => x.id === workerId);
    if (!w) return toast('No encontrado', 'error');
    const atts = DB.getAttendance().filter(a => a.workerId === workerId).sort((a, b) => a.date.localeCompare(b.date));
    if (!atts.length) return toast('No hay asistencias para este trabajador', 'warning');

    let html = `<div style="font-size:14px;max-height:400px;overflow-y:auto;">
      <p><strong>${w.name}</strong> - ${w.type === 'reemplazo' ? 'Reemplazo' : 'Normal'}</p>
      <hr style="border-color:var(--border);margin:8px 0;">
      <table style="width:100%;font-size:13px;"><thead><tr><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Extra</th><th>Total</th></tr></thead><tbody>`;
    atts.slice(-25).forEach(a => {
      if (a.isAbsence) {
        html += `<tr><td>${formatDate(a.date)}</td><td colspan="5"><span class="status-badge pending">${a.absenceType || 'Ausencia'}</span>${a.note ? ' — ' + a.note : ''}</td></tr>`;
        return;
      }
      html += `<tr>
        <td>${formatDate(a.date)}</td><td>${formatTime(a.entry)}</td><td>${a.exit ? formatTime(a.exit) : '—'}</td>
        <td>${(a.totalHours || 0).toFixed(2)}</td><td>${((a.extraDay || 0) + (a.extraNight || 0)).toFixed(2)}</td>
        <td>${formatMoney(a.totalPay)}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
    openModal('Detalle de asistencias', html);
  };

  // =========================================================
  // 9. TRABAJADORES
  // =========================================================
  function renderWorkers() {
    const container = document.getElementById('workerList');
    const workers = DB.getWorkers();
    if (!workers.length) return renderEmpty(container, '👤', 'Sin trabajadores', 'Agrega tu primer trabajador.');
    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Nombre</th><th>Documento</th><th>Tipo</th><th>Ingreso</th><th>Estado</th><th>Acciones</th>
    </tr></thead><tbody>`;
    workers.forEach(w => {
      const active = w.active !== false;
      html += `<tr>
        <td><strong>${w.name}</strong></td>
        <td>${w.document || '—'}</td>
        <td>${w.type === 'reemplazo' ? '🔄 Reemplazo' : '👤 Normal'}</td>
        <td>${w.entryDate ? formatDate(w.entryDate) : '—'}</td>
        <td><span class="status-badge ${active ? 'active' : 'inactive'}">${active ? 'Activo' : 'Inactivo'}</span></td>
        <td class="actions">
          <button class="btn btn-primary btn-sm" onclick="editWorker(${w.id})">✎</button>
          <button class="btn btn-outline btn-sm" onclick="viewWorkerDetail(${w.id})">📄 Historial</button>
          <button class="btn btn-danger btn-sm" onclick="deleteWorker(${w.id})">✕</button>
          <button class="btn btn-outline btn-sm" onclick="toggleWorker(${w.id})">${active ? '❌' : '✅'}</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }

  document.getElementById('btnAddWorker').addEventListener('click', function () {
    openModal('Nuevo trabajador', `
      <form id="workerForm" onsubmit="createWorker(event)">
        <div class="form-grid">
          <div class="form-group"><label>Nombre *</label><input type="text" id="wf_name" required></div>
          <div class="form-group"><label>Documento</label><input type="text" id="wf_document"></div>
          <div class="form-group"><label>Teléfono</label><input type="text" id="wf_phone"></div>
          <div class="form-group"><label>Dirección</label><input type="text" id="wf_address"></div>
          <div class="form-group"><label>Tipo</label>
            <select id="wf_type"><option value="normal">Normal</option><option value="reemplazo">Reemplazo</option></select>
          </div>
          <div class="form-group"><label>Fecha ingreso</label><input type="date" id="wf_entryDate" value="${today()}"></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  });

  window.createWorker = function (e) {
    e.preventDefault();
    const name = document.getElementById('wf_name').value.trim();
    if (!name) return toast('El nombre es obligatorio', 'error');
    const workers = DB.getWorkers();
    const entryDate = document.getElementById('wf_entryDate').value || today();
    workers.push({
      id: DB.getNextId(workers), name,
      document: document.getElementById('wf_document').value.trim(),
      phone: document.getElementById('wf_phone').value.trim(),
      address: document.getElementById('wf_address').value.trim(),
      type: document.getElementById('wf_type').value,
      entryDate, active: true, lastPayDate: entryDate,
    });
    DB.setWorkers(workers);
    closeModal(); toast('Trabajador creado ✅', 'success');
    renderWorkers(); updateWorkerCount();
  };

  window.editWorker = function (id) {
    const w = DB.getWorkers().find(x => x.id === id);
    if (!w) return toast('No encontrado', 'error');
    openModal('Editar trabajador', `
      <form id="workerForm" onsubmit="saveWorker(event, ${id})">
        <div class="form-grid">
          <div class="form-group"><label>Nombre *</label><input type="text" id="wf_name" value="${w.name}" required></div>
          <div class="form-group"><label>Documento</label><input type="text" id="wf_document" value="${w.document || ''}"></div>
          <div class="form-group"><label>Teléfono</label><input type="text" id="wf_phone" value="${w.phone || ''}"></div>
          <div class="form-group"><label>Dirección</label><input type="text" id="wf_address" value="${w.address || ''}"></div>
          <div class="form-group"><label>Tipo</label>
            <select id="wf_type"><option value="normal" ${w.type === 'normal' ? 'selected' : ''}>Normal</option><option value="reemplazo" ${w.type === 'reemplazo' ? 'selected' : ''}>Reemplazo</option></select>
          </div>
          <div class="form-group"><label>Fecha ingreso</label><input type="date" id="wf_entryDate" value="${w.entryDate || ''}"></div>
          <div class="form-group"><label>Estado</label>
            <select id="wf_active"><option value="1" ${w.active !== false ? 'selected' : ''}>Activo</option><option value="0" ${w.active === false ? 'selected' : ''}>Inactivo</option></select>
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  };

  window.saveWorker = function (e, id) {
    e.preventDefault();
    const workers = DB.getWorkers();
    const idx = workers.findIndex(w => w.id === id);
    if (idx === -1) return toast('Error', 'error');
    const name = document.getElementById('wf_name').value.trim();
    if (!name) return toast('El nombre es obligatorio', 'error');
    workers[idx] = {
      ...workers[idx], name,
      document: document.getElementById('wf_document').value.trim(),
      phone: document.getElementById('wf_phone').value.trim(),
      address: document.getElementById('wf_address').value.trim(),
      type: document.getElementById('wf_type').value,
      entryDate: document.getElementById('wf_entryDate').value || today(),
      active: document.getElementById('wf_active').value === '1',
    };
    DB.setWorkers(workers);
    closeModal(); toast('Trabajador actualizado ✅', 'success');
    renderWorkers(); updateWorkerCount();
  };

  window.deleteWorker = function (id) {
    if (!confirm('¿Eliminar este trabajador?')) return;
    DB.setWorkers(DB.getWorkers().filter(w => w.id !== id));
    toast('Eliminado', 'warning');
    renderWorkers(); updateWorkerCount();
  };
  window.toggleWorker = function (id) {
    const workers = DB.getWorkers();
    const w = workers.find(x => x.id === id);
    if (!w) return;
    w.active = w.active === false ? true : false;
    DB.setWorkers(workers);
    toast(w.active ? 'Activado ✅' : 'Desactivado ❌', 'warning');
    renderWorkers(); updateWorkerCount();
  };
  function updateWorkerCount() {
    document.getElementById('workerCount').textContent = DB.getWorkers().length + ' trabajadores';
  }

  // =========================================================
  // 10. ASISTENCIA
  // =========================================================
  function renderAttendance() {
    const container = document.getElementById('attendanceList');
    const dateInput = document.getElementById('attendanceDate');
    if (!dateInput.value) dateInput.value = today();
    const date = dateInput.value;
    const dayAtt = DB.getAttendance().filter(a => a.date === date);
    const workers = DB.getWorkers();
    if (!dayAtt.length) return renderEmpty(container, '📋', 'Sin registros', 'No hay asistencias para esta fecha.');

    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Trabajador</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Diurnas</th><th>Nocturnas</th>
      <th>Extra D</th><th>Extra N</th><th>Total</th><th>Acciones</th>
    </tr></thead><tbody>`;
    dayAtt.forEach(a => {
      const w = workers.find(x => x.id === a.workerId);
      const name = w ? w.name : '—';
      if (a.isAbsence) {
        html += `<tr><td><strong>${name}</strong></td><td colspan="8" style="text-align:center;">
          <span class="status-badge pending">${a.absenceType || 'Ausencia'}</span>${a.note ? ' — ' + a.note : ''}
        </td><td><button class="btn btn-danger btn-sm" onclick="deleteAttendance(${a.id})">✕</button></td></tr>`;
        return;
      }
      html += `<tr>
        <td><strong>${name}</strong></td><td>${formatTime(a.entry)}</td><td>${a.exit ? formatTime(a.exit) : '—'}</td>
        <td>${(a.totalHours || 0).toFixed(2)}</td><td>${(a.dayHours || 0).toFixed(2)}</td><td>${(a.nightHours || 0).toFixed(2)}</td>
        <td>${(a.extraDay || 0).toFixed(2)}</td><td>${(a.extraNight || 0).toFixed(2)}</td>
        <td>${formatMoney(a.totalPay)}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteAttendance(${a.id})">✕</button></td>
      </tr>`;
      html += `<tr class="detail-row"><td colspan="10"><div class="payroll-breakdown" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="item"><span>Diurnas</span><span>${formatMoney(a.payRegularDay || 0)}</span></div>
        <div class="item"><span>Nocturnas</span><span>${formatMoney(a.payRegularNight || 0)}</span></div>
        <div class="item"><span>Extra D</span><span>${formatMoney(a.payExtraDay || 0)}</span></div>
        <div class="item"><span>Extra N</span><span>${formatMoney(a.payExtraNight || 0)}</span></div>
        ${a.isRestDay ? `<div class="item"><span>💰 Festivo/Domingo</span><span>${formatMoney(a.payRestDay || 0)}</span></div>` : ''}
        <div class="item total"><span>Total día</span><span>${formatMoney(a.totalPay || 0)}</span></div>
      </div></td></tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }

  window.deleteAttendance = function (id) {
    if (!confirm('¿Eliminar este registro?')) return;
    DB.setAttendance(DB.getAttendance().filter(a => a.id !== id));
    toast('Registro eliminado', 'warning');
    renderAttendance(); renderQuickAttendance();
  };

  function renderQuickAttendance() {
    const container = document.getElementById('quickAttendance');
    const active = DB.getWorkers().filter(w => w.active !== false);
    if (!active.length) { container.innerHTML = `<div class="empty-state"><p>No hay trabajadores activos.</p></div>`; return; }
    const todayStr = today();
    const attendance = DB.getAttendance();
    const cfg = DB.getConfig();

    let html = `<div style="overflow-x:auto;"><table><thead><tr><th>Trabajador</th><th>Estado hoy</th><th>Entrada</th><th>Salida</th><th>Acciones</th></tr></thead><tbody>`;
    active.forEach(w => {
      const existing = attendance.find(a => a.workerId === w.id && a.date === todayStr);
      let status = 'Pendiente', statusClass = 'pending', entry = '—', exit = '—';
      if (existing) {
        if (existing.isAbsence) { status = existing.absenceType || 'Ausencia'; statusClass = 'pending'; }
        else {
          entry = formatTime(existing.entry);
          exit = existing.exit ? formatTime(existing.exit) : '—';
          status = existing.exit ? 'Salida registrada' : 'Entrada registrada';
          statusClass = existing.exit ? 'out' : 'in';
        }
      }
      const canEntry = !existing, canExit = existing && !existing.isAbsence && !existing.exit;
      html += `<tr>
        <td><strong>${w.name}</strong></td><td><span class="worker-status ${statusClass}">${status}</span></td>
        <td>${entry}</td><td>${exit}</td>
        <td>
          <button class="btn btn-success btn-sm" onclick="quickEntry(${w.id})" ${canEntry ? '' : 'disabled'}>✅ Entrada</button>
          <button class="btn btn-danger btn-sm" onclick="quickExit(${w.id})" ${canExit ? '' : 'disabled'}>❌ Salida</button>
          <button class="btn btn-outline btn-sm" onclick="openAbsenceModal(${w.id})" ${canEntry ? '' : 'disabled'}>📌 Ausencia</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>
      <div style="margin-top:8px;font-size:13px;color:var(--text-light);">
        La entrada y la salida se registran con la hora real que indiques. La jornada ordinaria es de ${cfg.dailyHours || 7} horas: al completarlas, el tiempo adicional se cuenta como hora extra. Si la persona sale antes, solo se paga lo trabajado.
      </div>`;
    container.innerHTML = html;
  }

  window.quickEntry = function (workerId) {
    const todayStr = today();
    const attendance = DB.getAttendance();
    if (attendance.find(a => a.workerId === workerId && a.date === todayStr)) return toast('Ya hay registro para hoy', 'warning');
    const w = DB.getWorkers().find(x => x.id === workerId);
    if (!w) return toast('Trabajador no encontrado', 'error');

    const entryInput = prompt('Hora de entrada de ' + w.name + ' (formato HH:MM):', nowHHMM());
    if (!entryInput) return;
    if (!/^\d{2}:\d{2}$/.test(entryInput)) return toast('Formato inválido, use HH:MM', 'error');
    if (entryInput < '09:00') {
      if (!confirm('La hora ingresada (' + entryInput + ') es antes de las 9:00 a.m. ¿Confirma que desea registrar la entrada de ' + w.name + ' a esta hora?')) return;
    }

    attendance.push({
      id: DB.getNextId(attendance), workerId, date: todayStr, entry: entryInput, exit: null,
      totalHours: 0, dayHours: 0, nightHours: 0, regularDay: 0, regularNight: 0, extraDay: 0, extraNight: 0,
      isRestDay: isSunday(todayStr) || isHoliday(todayStr), isSunday: isSunday(todayStr), isHoliday: isHoliday(todayStr),
      payRegularDay: 0, payRegularNight: 0, payExtraDay: 0, payExtraNight: 0, payRestDay: 0, totalPay: 0, hourValue: 0,
    });
    DB.setAttendance(attendance);
    toast('Entrada registrada a las ' + entryInput + ' ✅', 'success');
    renderQuickAttendance(); renderAttendance(); renderDashboard();
  };

  window.quickExit = function (workerId) {
    const todayStr = today();
    const attendance = DB.getAttendance();
    const idx = attendance.findIndex(a => a.workerId === workerId && a.date === todayStr);
    if (idx === -1) return toast('No hay entrada registrada para hoy', 'error');
    const current = attendance[idx];
    if (current.isAbsence) return toast('Este día está marcado como ausencia', 'warning');
    if (current.exit) return toast('Ya se registró la salida de hoy', 'warning');

    const exitInput = prompt('Hora de salida (formato HH:MM):', nowHHMM());
    if (!exitInput) return;
    if (!/^\d{2}:\d{2}$/.test(exitInput)) return toast('Formato inválido, use HH:MM', 'error');
    const w = DB.getWorkers().find(x => x.id === workerId);
    if (!w) return toast('Trabajador no encontrado', 'error');

    const result = computeDay(w, todayStr, current.entry, exitInput);
    attendance[idx] = { ...attendance[idx], exit: exitInput, ...result };
    DB.setAttendance(attendance);
    toast('Salida registrada ✅ (' + result.totalHours + 'h trabajadas)', 'success');
    renderQuickAttendance(); renderAttendance(); renderDashboard();
  };

  window.openAbsenceModal = function (workerId) {
    const active = DB.getWorkers().filter(x => x.active !== false);
    if (!active.length) return toast('Primero crea un trabajador', 'error');
    const opts = active.map(x => `<option value="${x.id}" ${workerId && x.id === workerId ? 'selected' : ''}>${x.name}</option>`).join('');
    openModal('Registrar ausencia', `
      <form id="absenceForm" onsubmit="saveAbsence(event)">
        <div class="form-grid">
          <div class="form-group"><label>Trabajador</label><select id="ab_worker">${opts}</select></div>
          <div class="form-group"><label>Fecha</label><input type="date" id="ab_date" value="${today()}"></div>
          <div class="form-group"><label>Tipo de ausencia</label>
            <select id="ab_type">
              <option value="Incapacidad">🏥 Incapacidad</option>
              <option value="Calamidad doméstica">⚠️ Calamidad doméstica</option>
              <option value="Vacaciones">🏖️ Vacaciones</option>
              <option value="Día no remunerado">🚫 Día no remunerado</option>
              <option value="Permiso">📝 Permiso</option>
              <option value="Otro">➖ Otro</option>
            </select>
          </div>
          <div class="form-group"><label>Nota (opcional)</label><input type="text" id="ab_note"></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  };

  window.saveAbsence = function (e) {
    e.preventDefault();
    const workerId = parseInt(document.getElementById('ab_worker').value);
    const date = document.getElementById('ab_date').value;
    const type = document.getElementById('ab_type').value;
    const note = document.getElementById('ab_note').value.trim();
    if (!date) return toast('Seleccione una fecha', 'error');
    const attendance = DB.getAttendance();
    if (attendance.find(a => a.workerId === workerId && a.date === date)) return toast('Ya existe un registro para ese día', 'warning');
    attendance.push({ id: DB.getNextId(attendance), workerId, date, isAbsence: true, absenceType: type, note, entry: null, exit: null, totalHours: 0, extraDay: 0, extraNight: 0, totalPay: 0 });
    DB.setAttendance(attendance);
    closeModal(); toast('Ausencia registrada ✅', 'success');
    renderQuickAttendance(); renderAttendance(); renderDashboard();
  };

  document.getElementById('btnAbsence').addEventListener('click', () => openAbsenceModal());
  document.getElementById('btnLoadAttendance').addEventListener('click', renderAttendance);
  document.getElementById('btnAddAttendance').addEventListener('click', function () {
    const workers = DB.getWorkers();
    if (!workers.length) return toast('Primero crea un trabajador', 'error');
    const date = document.getElementById('attendanceDate').value || today();
    const opts = workers.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
    openModal('Registrar asistencia', `
      <form id="attendanceForm" onsubmit="saveAttendanceManual(event)">
        <div class="form-grid">
          <div class="form-group"><label>Trabajador</label><select id="af_worker">${opts}</select></div>
          <div class="form-group"><label>Fecha</label><input type="date" id="af_date" value="${date}"></div>
          <div class="form-group"><label>Entrada</label><input type="time" id="af_entry" value="09:00"></div>
          <div class="form-group"><label>Salida</label><input type="time" id="af_exit" value="16:00"></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  });

  window.saveAttendanceManual = function (e) {
    e.preventDefault();
    const workerId = parseInt(document.getElementById('af_worker').value);
    const date = document.getElementById('af_date').value;
    const entry = document.getElementById('af_entry').value;
    const exit = document.getElementById('af_exit').value;
    if (!date || !entry || !exit) return toast('Complete todos los campos', 'error');
    const w = DB.getWorkers().find(x => x.id === workerId);
    if (!w) return toast('Trabajador no encontrado', 'error');
    const result = computeDay(w, date, entry, exit);
    const attendance = DB.getAttendance();
    const existing = attendance.find(a => a.workerId === workerId && a.date === date);
    if (existing) {
      if (!confirm('Ya existe un registro para este día. ¿Sobrescribir?')) return;
      attendance.splice(attendance.indexOf(existing), 1);
    }
    attendance.push({ id: DB.getNextId(attendance), workerId, date, entry, exit, ...result });
    DB.setAttendance(attendance);
    closeModal(); toast('Asistencia registrada ✅', 'success');
    renderAttendance(); renderQuickAttendance(); renderDashboard();
  };

  // =========================================================
  // 11. NÓMINA (visualización)
  // =========================================================
  function renderPayroll() {
    const container = document.getElementById('payrollList');
    const payrolls = DB.getPayrolls(), workers = DB.getWorkers();
    if (!payrolls.length) return renderEmpty(container, '💰', 'Sin nóminas', 'Realiza pagos desde el Dashboard.');
    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Trabajador</th><th>Período</th><th>Días</th><th>Bruto</th><th>Descuentos</th><th>Neto</th><th>Acciones</th>
    </tr></thead><tbody>`;
    payrolls.slice().reverse().forEach(p => {
      const w = workers.find(x => x.id === p.workerId);
      html += `<tr>
        <td><strong>${w ? w.name : '—'}</strong></td>
        <td>${formatDate(p.startDate)} → ${formatDate(p.endDate)}</td>
        <td>${p.daysWorked || 0}</td>
        <td>${formatMoney(p.totalDevengado || 0)}</td>
        <td>${formatMoney(p.totalDeductions || 0)}</td>
        <td><strong>${formatMoney(p.totalNet || 0)}</strong></td>
        <td><button class="btn btn-primary btn-sm" onclick="viewPayroll(${p.id})">📄</button>
        <button class="btn btn-success btn-sm" onclick="downloadPayrollPDF(${p.id})">PDF</button></td>
      </tr>`;
      html += `<tr class="detail-row"><td colspan="7"><div class="payroll-breakdown" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="item"><span>Salario base</span><span>${formatMoney(p.baseSalary || 0)}</span></div>
        <div class="item"><span>Transporte</span><span>${formatMoney(p.transportSubsidy || 0)}</span></div>
        <div class="item"><span>Horas normales</span><span>${(p.regularHours || 0).toFixed(2)}h</span></div>
        <div class="item"><span>Horas nocturnas</span><span>${(p.nightHours || 0).toFixed(2)}h</span></div>
        <div class="item"><span>Domingo/festivo</span><span>${(p.sundayHours || 0).toFixed(2)}h · ${formatMoney(p.sundayAmount || 0)}</span></div>
        <div class="item"><span>Extra pagada ahora (quincena anterior)</span><span>${(p.overtimeHoursPaidNow || 0).toFixed(2)}h · ${formatMoney(p.overtimePaidNow || 0)}</span></div>
        <div class="item pending-note"><span>⏳ Extra de este período (se pagará después)</span><span>${((p.overtimeDayPending || 0) + (p.overtimeNightPending || 0)).toFixed(2)}h · ${formatMoney(p.overtimePendingAmount || 0)}</span></div>
        <div class="item total"><span>Total neto pagado ahora</span><span>${formatMoney(p.totalNet || 0)}</span></div>
      </div></td></tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }

  window.viewPayroll = function (id) {
    const p = DB.getPayrolls().find(x => x.id === id);
    if (!p) return toast('No encontrado', 'error');
    const w = DB.getWorkers().find(x => x.id === p.workerId);
    const cfg = DB.getConfig();
    openModal('Detalle de nómina', `
      <div style="font-size:14px;line-height:1.9;">
        <p><strong>Trabajador:</strong> ${w ? w.name : '—'}</p>
        <p><strong>Período:</strong> ${formatDate(p.startDate)} — ${formatDate(p.endDate)}</p>
        <p><strong>Días con salida registrada:</strong> ${p.daysWorked || 0}</p>
        <hr style="border-color:var(--border);margin:12px 0;">
        <div class="payroll-breakdown" style="grid-template-columns:1fr 1fr;">
          <div class="item"><span>Salario base</span><span>${formatMoney(p.baseSalary)}</span></div>
          <div class="item"><span>Auxilio transporte</span><span>${formatMoney(p.transportSubsidy)}</span></div>
          <div class="item"><span>Horas normales</span><span>${(p.regularHours || 0).toFixed(2)}h</span></div>
          <div class="item"><span>Horas nocturnas</span><span>${(p.nightHours || 0).toFixed(2)}h</span></div>
          <div class="item"><span>Domingo/festivo</span><span>${(p.sundayHours || 0).toFixed(2)}h · ${formatMoney(p.sundayAmount || 0)}</span></div>
          <div class="item"><span>Extra pagada ahora (quincena anterior)</span><span>${(p.overtimeHoursPaidNow || 0).toFixed(2)}h · ${formatMoney(p.overtimePaidNow || 0)}</span></div>
          <div class="item total"><span>Total devengado</span><span>${formatMoney(p.totalDevengado)}</span></div>
          <div class="item"><span>Salud (${cfg.health || 4}%)</span><span>${formatMoney(p.healthDeduction || 0)}</span></div>
          <div class="item"><span>Pensión (${cfg.pension || 4}%)</span><span>${formatMoney(p.pensionDeduction || 0)}</span></div>
          <div class="item total"><span>Total descuentos</span><span>${formatMoney(p.totalDeductions)}</span></div>
          <div class="item total" style="font-size:18px;grid-column:1/-1;border-top:2px solid var(--accent);padding-top:10px;">
            <span><strong>NETO PAGADO AHORA</strong></span><span><strong>${formatMoney(p.totalNet)}</strong></span>
          </div>
          <div class="item pending-note" style="grid-column:1/-1;">
            <span>⏳ Horas extra de este período (${((p.overtimeDayPending || 0) + (p.overtimeNightPending || 0)).toFixed(2)}h)</span>
            <span>${formatMoney(p.overtimePendingAmount || 0)} — se pagarán en la próxima quincena</span>
          </div>
        </div>
      </div>`);
  };

  window.downloadPayrollPDF = function (id) {
    const p = DB.getPayrolls().find(x => x.id === id);
    if (!p) return toast('No encontrado', 'error');
    const w = DB.getWorkers().find(x => x.id === p.workerId);
    const name = w ? w.name : '—';
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');
    doc.setFontSize(18); doc.text('Comprobante de Nómina', 20, 20);
    doc.setFontSize(12);
    doc.text(`Trabajador: ${name}`, 20, 32);
    doc.text(`Período: ${formatDate(p.startDate)} - ${formatDate(p.endDate)}`, 20, 40);
    doc.text(`Días: ${p.daysWorked || 0}`, 20, 48);
    doc.line(20, 52, 190, 52);
    let y = 60;
    const lines = [
      ['Concepto', 'Valor'],
      ['Salario base', formatMoney(p.baseSalary || 0)],
      ['Auxilio transporte', formatMoney(p.transportSubsidy || 0)],
      ['Horas normales', (p.regularHours || 0).toFixed(2) + 'h'],
      ['Horas nocturnas', (p.nightHours || 0).toFixed(2) + 'h'],
      ['Domingo/festivo', (p.sundayHours || 0).toFixed(2) + 'h · ' + formatMoney(p.sundayAmount || 0)],
      ['Extra pagada ahora (quincena anterior)', (p.overtimeHoursPaidNow || 0).toFixed(2) + 'h · ' + formatMoney(p.overtimePaidNow || 0)],
      ['Total devengado', formatMoney(p.totalDevengado || 0)],
      ['Salud', formatMoney(p.healthDeduction || 0)],
      ['Pensión', formatMoney(p.pensionDeduction || 0)],
      ['Total descuentos', formatMoney(p.totalDeductions || 0)],
      ['NETO PAGADO AHORA', formatMoney(p.totalNet || 0)],
      ['Extra pendiente (próxima quincena)', ((p.overtimeDayPending || 0) + (p.overtimeNightPending || 0)).toFixed(2) + 'h · ' + formatMoney(p.overtimePendingAmount || 0)],
    ];
    lines.forEach((row, i) => {
      doc.text(row[0], 20, y); doc.text(row[1], 120, y); y += 7;
      if (i === 0) { y += 2; doc.line(20, y - 2, 190, y - 2); }
    });
    doc.save(`nomina_${name}_${p.startDate}.pdf`);
    toast('PDF generado ✅', 'success');
  };

  document.getElementById('btnRefreshPayroll').addEventListener('click', renderPayroll);
  document.getElementById('btnPayAll').addEventListener('click', function () {
    const active = DB.getWorkers().filter(w => w.active !== false);
    if (!active.length) return toast('No hay trabajadores activos', 'error');
    if (!confirm('¿Pagar quincena a todos los trabajadores activos?')) return;
    active.forEach(w => window.payWorker(w.id));
    toast('Pago quincenal completado ✅', 'success');
  });

  // =========================================================
  // 12. LIQUIDACIÓN (usa el historial salarial por tramos)
  // =========================================================
  function splitEmploymentBySegments(entryDate, exitDate) {
    const segments = [];
    let cursor = entryDate, guard = 0;
    while (cursor <= exitDate && guard < 500) {
      guard++;
      const period = getRatesForDate(cursor);
      let periodEnd = (period.to && period.to < exitDate) ? period.to : exitDate;
      if (periodEnd < cursor) periodEnd = cursor;
      segments.push({ from: cursor, to: periodEnd, days: daysBetweenInclusive(cursor, periodEnd), salary: period.salary, label: period.label });
      cursor = addDaysStr(periodEnd, 1);
    }
    return segments;
  }

  function renderSettlements() {
    const container = document.getElementById('settlementList');
    const list = DB.getSettlements(), workers = DB.getWorkers();
    if (!list.length) return renderEmpty(container, '⚖️', 'Sin liquidaciones', 'Realiza una liquidación al retirar.');
    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Trabajador</th><th>Ingreso</th><th>Retiro</th><th>Días</th><th>Total</th><th>Acciones</th>
    </tr></thead><tbody>`;
    list.slice().reverse().forEach(s => {
      const w = workers.find(x => x.id === s.workerId);
      html += `<tr>
        <td><strong>${w ? w.name : '—'}</strong></td><td>${formatDate(s.entryDate)}</td><td>${formatDate(s.exitDate)}</td>
        <td>${s.totalDays || 0}</td><td><strong>${formatMoney(s.totalLiquidacion || 0)}</strong></td>
        <td><button class="btn btn-primary btn-sm" onclick="viewSettlement(${s.id})">📄</button>
        <button class="btn btn-success btn-sm" onclick="downloadSettlementPDF(${s.id})">PDF</button></td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }

  document.getElementById('btnNewSettlement').addEventListener('click', function () {
    const workers = DB.getWorkers();
    if (!workers.length) return toast('Primero crea un trabajador', 'error');
    const opts = workers.map(w => `<option value="${w.id}" data-entry="${w.entryDate || ''}">${w.name}</option>`).join('');
    openModal('Nueva liquidación', `
      <form id="settlementForm" onsubmit="createSettlement(event)">
        <div class="form-grid">
          <div class="form-group"><label>Trabajador</label><select id="sf_worker">${opts}</select></div>
          <div class="form-group"><label>Fecha ingreso</label><input type="date" id="sf_entry" value="${today()}"></div>
          <div class="form-group"><label>Fecha retiro</label><input type="date" id="sf_exit" value="${today()}"></div>
        </div>
        <p class="tip" style="margin-top:10px;">El cálculo usará automáticamente el salario mínimo, auxilio y recargos vigentes en cada tramo de fechas (ver Historial salarial).</p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Calcular y guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
    const sel = document.getElementById('sf_worker');
    sel.addEventListener('change', function () {
      const opt = sel.options[sel.selectedIndex];
      if (opt.dataset.entry) document.getElementById('sf_entry').value = opt.dataset.entry;
    });
    if (sel.options.length) {
      const opt = sel.options[sel.selectedIndex];
      if (opt.dataset.entry) document.getElementById('sf_entry').value = opt.dataset.entry;
    }
  });

  window.createSettlement = function (e) {
    e.preventDefault();
    const workerId = parseInt(document.getElementById('sf_worker').value);
    const entryDate = document.getElementById('sf_entry').value;
    const exitDate = document.getElementById('sf_exit').value;
    if (!entryDate || !exitDate) return toast('Complete las fechas', 'error');
    if (exitDate < entryDate) return toast('La fecha de retiro no puede ser anterior al ingreso', 'error');
    const w = DB.getWorkers().find(x => x.id === workerId);
    if (!w) return toast('Trabajador no encontrado', 'error');

    const segments = splitEmploymentBySegments(entryDate, exitDate);
    const totalDays = segments.reduce((s, seg) => s + seg.days, 0);
    let cesantias = 0, prima = 0, vacation = 0;
    segments.forEach(seg => {
      cesantias += seg.salary * (seg.days / 360);
      prima += seg.salary * (seg.days / 360) * 0.5;
      vacation += seg.salary * (seg.days / 360) * (15 / 30);
    });
    const interestCesantias = cesantias * 0.12 * (totalDays / 360);
    const lastSegment = segments[segments.length - 1];
    const salaryPending = lastSegment.salary * (lastSegment.days / 30);
    const years = totalDays / 365;
    const indemnification = lastSegment.salary * Math.min(years, 3) * 0.3;
    const total = salaryPending + prima + cesantias + interestCesantias + vacation + indemnification;

    const settlement = {
      id: DB.getNextId(DB.getSettlements()), workerId, entryDate, exitDate, totalDays,
      segments: segments.map(s => ({ from: s.from, to: s.to, days: s.days, salary: s.salary, label: s.label })),
      salaryPending: round2(salaryPending), prima: round2(prima), cesantias: round2(cesantias),
      interestCesantias: round2(interestCesantias), vacation: round2(vacation),
      indemnification: round2(indemnification), others: 0, totalLiquidacion: round2(total),
      status: 'cerrada', createdAt: new Date().toISOString(),
    };
    const list = DB.getSettlements();
    list.push(settlement);
    DB.setSettlements(list);
    closeModal(); toast('Liquidación generada ✅', 'success');
    renderSettlements();
  };

  window.viewSettlement = function (id) {
    const s = DB.getSettlements().find(x => x.id === id);
    if (!s) return toast('No encontrado', 'error');
    const w = DB.getWorkers().find(x => x.id === s.workerId);
    let segmentsHtml = '';
    if (s.segments && s.segments.length) {
      segmentsHtml = `<p style="margin-top:10px;"><strong>Tramos salariales aplicados:</strong></p><table style="width:100%;font-size:12px;margin-top:4px;"><thead><tr><th>Desde</th><th>Hasta</th><th>Días</th><th>Salario del tramo</th></tr></thead><tbody>` +
        s.segments.map(seg => `<tr><td>${formatDate(seg.from)}</td><td>${formatDate(seg.to)}</td><td>${seg.days}</td><td>${formatMoney(seg.salary)}</td></tr>`).join('') +
        `</tbody></table>`;
    }
    openModal('Detalle de liquidación', `
      <div style="font-size:14px;line-height:1.9;">
        <p><strong>Trabajador:</strong> ${w ? w.name : '—'}</p>
        <p><strong>Ingreso:</strong> ${formatDate(s.entryDate)} · <strong>Retiro:</strong> ${formatDate(s.exitDate)} · <strong>Tiempo:</strong> ${s.totalDays || 0} días</p>
        <hr style="border-color:var(--border);margin:12px 0;">
        <div class="payroll-breakdown" style="grid-template-columns:1fr 1fr;">
          <div class="item"><span>Salario pendiente</span><span>${formatMoney(s.salaryPending || 0)}</span></div>
          <div class="item"><span>Prima proporcional</span><span>${formatMoney(s.prima || 0)}</span></div>
          <div class="item"><span>Cesantías</span><span>${formatMoney(s.cesantias || 0)}</span></div>
          <div class="item"><span>Intereses cesantías</span><span>${formatMoney(s.interestCesantias || 0)}</span></div>
          <div class="item"><span>Vacaciones</span><span>${formatMoney(s.vacation || 0)}</span></div>
          <div class="item"><span>Indemnización (estimada)</span><span>${formatMoney(s.indemnification || 0)}</span></div>
          <div class="item total"><span>TOTAL LIQUIDACIÓN</span><span>${formatMoney(s.totalLiquidacion || 0)}</span></div>
        </div>
        ${segmentsHtml}
        <p class="warn" style="margin-top:12px;">⚠️ Este valor es una estimación de referencia. Para el pago oficial de una liquidación, verifícalo con un contador o abogado laboral, ya que existen reglas adicionales (por ejemplo, causal del retiro) que este sistema no evalúa.</p>
      </div>`);
  };

  window.downloadSettlementPDF = function (id) {
    const s = DB.getSettlements().find(x => x.id === id);
    if (!s) return toast('No encontrado', 'error');
    const w = DB.getWorkers().find(x => x.id === s.workerId);
    const name = w ? w.name : '—';
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');
    doc.setFontSize(20); doc.text('LIQUIDACIÓN LABORAL', 20, 20);
    doc.setFontSize(12);
    doc.text(`Trabajador: ${name}`, 20, 32);
    doc.text(`Ingreso: ${formatDate(s.entryDate)}`, 20, 40);
    doc.text(`Retiro: ${formatDate(s.exitDate)}`, 20, 48);
    doc.text(`Tiempo: ${s.totalDays || 0} días`, 20, 56);
    doc.line(20, 60, 190, 60);
    let y = 68;
    [['Salario pendiente', formatMoney(s.salaryPending || 0)],
     ['Prima proporcional', formatMoney(s.prima || 0)],
     ['Cesantías', formatMoney(s.cesantias || 0)],
     ['Intereses de cesantías', formatMoney(s.interestCesantias || 0)],
     ['Vacaciones', formatMoney(s.vacation || 0)],
     ['Indemnización (estimada)', formatMoney(s.indemnification || 0)]].forEach(row => {
      doc.text(row[0], 20, y); doc.text(row[1], 130, y); y += 7;
    });
    doc.line(20, y + 2, 190, y + 2);
    doc.setFontSize(16); doc.text('TOTAL LIQUIDACIÓN', 20, y + 14); doc.text(formatMoney(s.totalLiquidacion || 0), 130, y + 14);
    doc.setFontSize(9);
    doc.text('Estimación de referencia. Verifíquese con un contador o abogado laboral.', 20, y + 26);
    doc.save(`liquidacion_${name}_${s.exitDate}.pdf`);
    toast('PDF generado ✅', 'success');
  };

  // =========================================================
  // 13. FESTIVOS
  // =========================================================
  function renderHolidays() {
    const container = document.getElementById('holidayList');
    const holidays = DB.getHolidays().slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!holidays.length) return renderEmpty(container, '📅', 'Sin festivos', 'Agrega los días festivos del año.');
    let html = `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Nombre</th><th>Acciones</th></tr></thead><tbody>`;
    holidays.forEach(h => {
      html += `<tr><td>${formatDate(h.date)}</td><td>${h.name || 'Festivo'}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteHoliday(${h.id})">✕</button></td></tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }
  window.deleteHoliday = function (id) {
    if (!confirm('¿Eliminar este festivo?')) return;
    DB.setHolidays(DB.getHolidays().filter(h => h.id !== id));
    toast('Festivo eliminado', 'warning');
    renderHolidays();
  };
  document.getElementById('btnAddHoliday').addEventListener('click', function () {
    openModal('Agregar festivo', `
      <form id="holidayForm" onsubmit="createHoliday(event)">
        <div class="form-grid">
          <div class="form-group"><label>Fecha</label><input type="date" id="hf_date" value="${today()}" required></div>
          <div class="form-group"><label>Nombre</label><input type="text" id="hf_name" placeholder="Ej: 1 de mayo" value="Festivo"></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  });
  window.createHoliday = function (e) {
    e.preventDefault();
    const date = document.getElementById('hf_date').value;
    const name = document.getElementById('hf_name').value.trim() || 'Festivo';
    if (!date) return toast('Seleccione una fecha', 'error');
    const holidays = DB.getHolidays();
    if (holidays.some(h => h.date === date)) return toast('Ya existe este festivo', 'warning');
    holidays.push({ id: DB.getNextId(holidays), date, name });
    DB.setHolidays(holidays);
    closeModal(); toast('Festivo agregado ✅', 'success');
    renderHolidays(); renderCalendar();
  };

  // =========================================================
  // 14. HISTORIAL SALARIAL
  // =========================================================
  function renderWageHistory() {
    const container = document.getElementById('wageHistoryList');
    const history = DB.getWageHistory().slice().sort((a, b) => a.from.localeCompare(b.from));
    if (!history.length) return renderEmpty(container, '💲', 'Sin períodos', 'Agrega el primer período salarial.');
    let html = `<div class="table-wrap"><table><thead><tr>
      <th>Período</th><th>Desde</th><th>Hasta</th><th>Salario</th><th>Auxilio</th><th>Jornada</th><th>Recargo dom/fest</th><th>Estado</th><th>Acciones</th>
    </tr></thead><tbody>`;
    history.forEach(p => {
      const vigente = !p.to;
      html += `<tr>
        <td>${p.label || '—'}</td><td>${formatDate(p.from)}</td><td>${p.to ? formatDate(p.to) : '—'}</td>
        <td>${formatMoney(p.salary)}</td><td>${formatMoney(p.transport)}</td><td>${p.weeklyHours}h/sem</td>
        <td>${p.sundayPremium}%</td>
        <td><span class="status-badge ${vigente ? 'current' : 'inactive'}">${vigente ? 'VIGENTE' : 'Cerrado'}</span></td>
        <td class="actions">
          <button class="btn btn-primary btn-sm" onclick="editWagePeriod(${p.id})">✎</button>
          <button class="btn btn-danger btn-sm" onclick="deleteWagePeriod(${p.id})">✕</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
  }

  function wagePeriodFormHTML(p) {
    p = p || { from: today(), to: '', label: '', salary: '', transport: '', weeklyHours: 42, monthlyHours: 210, nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 90, nightStart: '19:00', nightEnd: '06:00' };
    return `
      <div class="form-grid">
        <div class="form-group"><label>Nombre del período</label><input type="text" id="wp_label" value="${p.label || ''}" placeholder="Ej: 2027 - nuevo salario mínimo"></div>
        <div class="form-group"><label>Desde</label><input type="date" id="wp_from" value="${p.from || ''}" required></div>
        <div class="form-group"><label>Hasta (vacío = vigente)</label><input type="date" id="wp_to" value="${p.to || ''}"></div>
        <div class="form-group"><label>Salario mensual ($)</label><input type="number" id="wp_salary" value="${p.salary}" required></div>
        <div class="form-group"><label>Auxilio transporte ($)</label><input type="number" id="wp_transport" value="${p.transport}" required></div>
        <div class="form-group"><label>Horas semanales</label><input type="number" id="wp_weeklyHours" value="${p.weeklyHours}" step="0.5" required></div>
        <div class="form-group"><label>Horas mensuales (divisor)</label><input type="number" id="wp_monthlyHours" value="${p.monthlyHours}" step="0.5" required></div>
        <div class="form-group"><label>Recargo nocturno (%)</label><input type="number" id="wp_nightPremium" value="${p.nightPremium}" step="0.5" required></div>
        <div class="form-group"><label>Hora extra diurna (%)</label><input type="number" id="wp_overtimeDay" value="${p.overtimeDay}" step="0.5" required></div>
        <div class="form-group"><label>Hora extra nocturna (%)</label><input type="number" id="wp_overtimeNight" value="${p.overtimeNight}" step="0.5" required></div>
        <div class="form-group"><label>Recargo dominical/festivo (%)</label><input type="number" id="wp_sundayPremium" value="${p.sundayPremium}" step="0.5" required></div>
        <div class="form-group"><label>Inicio horario nocturno</label><input type="time" id="wp_nightStart" value="${p.nightStart}" required></div>
        <div class="form-group"><label>Fin horario nocturno</label><input type="time" id="wp_nightEnd" value="${p.nightEnd}" required></div>
      </div>`;
  }

  document.getElementById('btnAddWagePeriod').addEventListener('click', function () {
    openModal('Nuevo período salarial', `
      <form id="wageForm" onsubmit="saveWagePeriod(event)">
        ${wagePeriodFormHTML(null)}
        <p class="tip" style="margin-top:10px;">Si este período es el vigente, deja "Hasta" vacío. Si estás cerrando el período anterior porque cambió el salario mínimo, primero edítalo y ponle una fecha "Hasta".</p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  });

  window.editWagePeriod = function (id) {
    const p = DB.getWageHistory().find(x => x.id === id);
    if (!p) return toast('No encontrado', 'error');
    openModal('Editar período salarial', `
      <form id="wageForm" onsubmit="saveWagePeriod(event, ${id})">
        ${wagePeriodFormHTML(p)}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Guardar</button>
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        </div>
      </form>`);
  };

  window.saveWagePeriod = function (e, id) {
    e.preventDefault();
    const data = {
      label: document.getElementById('wp_label').value.trim(),
      from: document.getElementById('wp_from').value,
      to: document.getElementById('wp_to').value || null,
      salary: parseFloat(document.getElementById('wp_salary').value),
      transport: parseFloat(document.getElementById('wp_transport').value),
      weeklyHours: parseFloat(document.getElementById('wp_weeklyHours').value),
      monthlyHours: parseFloat(document.getElementById('wp_monthlyHours').value),
      nightPremium: parseFloat(document.getElementById('wp_nightPremium').value),
      overtimeDay: parseFloat(document.getElementById('wp_overtimeDay').value),
      overtimeNight: parseFloat(document.getElementById('wp_overtimeNight').value),
      sundayPremium: parseFloat(document.getElementById('wp_sundayPremium').value),
      nightStart: document.getElementById('wp_nightStart').value,
      nightEnd: document.getElementById('wp_nightEnd').value,
    };
    if (!data.from || isNaN(data.salary) || isNaN(data.transport)) return toast('Complete los campos obligatorios', 'error');
    const history = DB.getWageHistory();
    if (id) {
      const idx = history.findIndex(p => p.id === id);
      if (idx === -1) return toast('Error', 'error');
      history[idx] = { ...history[idx], ...data };
    } else {
      history.push({ id: DB.getNextId(history), ...data });
    }
    DB.setWageHistory(history);
    closeModal(); toast('Período salarial guardado ✅', 'success');
    renderWageHistory();
  };

  window.deleteWagePeriod = function (id) {
    if (!confirm('¿Eliminar este período salarial? Esto puede afectar cálculos de fechas dentro de su rango.')) return;
    DB.setWageHistory(DB.getWageHistory().filter(p => p.id !== id));
    toast('Período eliminado', 'warning');
    renderWageHistory();
  };

  // =========================================================
  // 15. PARÁMETROS (reglas internas + seguridad)
  // =========================================================
  function renderSettings() {
    const cfg = DB.getConfig();
    document.getElementById('cfgDailyHours').value = cfg.dailyHours || 7;
    document.getElementById('cfgHealth').value = cfg.health || 4;
    document.getElementById('cfgPension').value = cfg.pension || 4;
  }
  document.getElementById('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    DB.setConfig({
      dailyHours: parseFloat(document.getElementById('cfgDailyHours').value) || 7,
      health: parseFloat(document.getElementById('cfgHealth').value) || 4,
      pension: parseFloat(document.getElementById('cfgPension').value) || 4,
    });
    toast('Parámetros guardados ✅', 'success');
    renderDashboard();
  });

  document.getElementById('passwordForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const oldPassword = document.getElementById('pwOld').value;
    const newPassword = document.getElementById('pwNew').value;
    const newPassword2 = document.getElementById('pwNew2').value;
    if (newPassword !== newPassword2) return toast('Las contraseñas nuevas no coinciden', 'error');
    try {
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error || 'No se pudo cambiar la contraseña', 'error');
      toast('Contraseña actualizada ✅', 'success');
      document.getElementById('passwordForm').reset();
    } catch (err) {
      toast('Sin conexión con el servidor', 'error');
    }
  });

  // =========================================================
  // 16. MANUAL DE USO
  // =========================================================
  function renderManual() {
    document.getElementById('manualContent').innerHTML = `
      <h3>👋 Bienvenido a GUARDIÁN FAMILIAR COS</h3>
      <p>Este sistema controla la asistencia y la nómina de tus trabajadores: registra entradas y salidas reales, calcula horas normales, nocturnas y extra, aplica el recargo dominical/festivo, y genera pagos y liquidaciones.</p>
      <div class="tip">💡 Puedes ingresar desde tu computador y desde tu celular con el mismo usuario y contraseña: la información se guarda en el servidor, no en cada dispositivo.</div>

      <h3>🔑 Ingreso y seguridad</h3>
      <ul>
        <li>Usuario por defecto: <strong>ADMIN</strong> — Contraseña por defecto: <strong>ADMIN123</strong>.</li>
        <li>Cambia la contraseña en <strong>Parámetros → Seguridad</strong> lo antes posible.</li>
        <li>El botón <strong>🚪 Salir</strong> (abajo en el menú) cierra la sesión y regresa al login.</li>
        <li>El botón <strong>◀ Atrás</strong> (arriba) te devuelve a la sección que visitaste antes.</li>
      </ul>

      <h3>👤 Trabajadores</h3>
      <p>Crea aquí cada trabajador con su nombre, documento y fecha de ingreso. Desde "📄 Historial" puedes ver todas sus entradas, salidas y ausencias.</p>

      <h3>📋 Asistencia</h3>
      <ul>
        <li><strong>Entrada:</strong> el sistema pregunta la hora REAL de entrada (no una hora fija). Si la hora es antes de las 9:00 a.m. pedirá una confirmación.</li>
        <li><strong>Salida:</strong> igual, se pregunta la hora real. Con eso se calculan las horas trabajadas, diurnas, nocturnas y extra.</li>
        <li>Si el trabajador sale antes de completar la jornada (por defecto 7 horas, editable en Parámetros), solo se le pagan las horas efectivamente trabajadas.</li>
        <li>Si se cumple la jornada y sigue trabajando, el tiempo adicional se cuenta automáticamente como hora extra.</li>
        <li><strong>📌 Ausencia:</strong> usa este botón para marcar incapacidad, calamidad doméstica, vacaciones, día no remunerado, permiso u otro — sin necesidad de registrar entrada/salida.</li>
      </ul>

      <h3>💰 Nómina y horas extra en quincena vencida</h3>
      <p>Al presionar <strong>💵 Pagar</strong> en el Dashboard, el sistema paga de inmediato el salario base, el auxilio de transporte, las horas normales y el recargo dominical/festivo del período.</p>
      <div class="warn">⏳ Las <strong>horas extra</strong> trabajadas en ese período <strong>NO</strong> se pagan en ese mismo momento: quedan programadas y se pagan junto con la <strong>siguiente</strong> quincena. Por ejemplo: las horas extra del 1 al 15 se pagan el día 30 (nómina del 15 al 30), y las del 15 al 30 se pagan en la nómina del 1 al 15 siguiente.</div>
      <p>En el detalle de cada nómina puedes ver cuánto se pagó por horas extra de la quincena anterior y cuánto quedó pendiente para la próxima.</p>

      <h3>⚖️ Liquidación</h3>
      <p>Al liquidar a un trabajador, el sistema divide todo el tiempo trabajado en tramos según el <strong>Historial salarial</strong>: si la persona empezó a trabajar cuando el salario mínimo era otro y ese salario cambió mientras trabajaba, cada tramo se calcula con el salario que estaba vigente en esas fechas exactas — no con el salario actual aplicado a todo el período.</p>
      <div class="warn">⚠️ Los valores de liquidación son una <strong>estimación de referencia</strong>. Para el pago oficial, verifícalos con un contador o abogado laboral: existen reglas adicionales (causal del retiro, convenios particulares, etc.) que este sistema no evalúa.</div>

      <h3>📅 Festivos</h3>
      <p>Ya vienen precargados los festivos oficiales de Colombia 2026. En el calendario del Dashboard: 🟩 verde = día normal, 🟥 rojo = domingo, 🟨 amarillo = festivo. Puedes agregar o quitar festivos aquí (por ejemplo si trabajas en otro país o cambia la ley).</p>

      <h3>💲 Historial salarial</h3>
      <p>Aquí se guardan los períodos de salario mínimo, auxilio de transporte, jornada semanal y recargos (nocturno, hora extra, dominical/festivo) con sus fechas de vigencia. El período sin fecha "Hasta" es el <strong>VIGENTE</strong> (el que se usa para las fechas de hoy en adelante).</p>
      <p><strong>Cuando cambie el salario mínimo (por ejemplo cada enero):</strong></p>
      <ul>
        <li>1) Edita el período vigente y ponle una fecha "Hasta" (el día anterior al cambio).</li>
        <li>2) Crea un "+ Nuevo período" con el nuevo salario, auxilio y demás valores, con "Desde" el día del cambio y "Hasta" vacío (para que quede como el nuevo vigente).</li>
      </ul>

      <h3>⚙️ Parámetros</h3>
      <p>Aquí solo se configuran reglas internas: la jornada diaria antes de contar horas extra (por defecto 7 horas), y los porcentajes de descuento de salud y pensión. El salario y los recargos se editan en Historial salarial.</p>

      <h3>📖 Nota legal</h3>
      <p class="tip">Este sistema es una herramienta de apoyo para organizar y estimar el control laboral y la nómina de un negocio familiar o pequeño. No reemplaza la asesoría de un contador, abogado laboral, o el uso de un sistema de nómina certificado ante la autoridad correspondiente para efectos legales o tributarios.</p>
    `;
  }

  // =========================================================
  // 17. TEMA, RELOJ, SIDEBAR, LOGOUT
  // =========================================================
  let darkMode = localStorage.getItem('cos_theme') === 'dark';
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    document.getElementById('themeToggle').textContent = darkMode ? '☀️ Modo claro' : '🌙 Modo oscuro';
    localStorage.setItem('cos_theme', darkMode ? 'dark' : 'light');
  }
  document.getElementById('themeToggle').addEventListener('click', function () { darkMode = !darkMode; applyTheme(); });

  document.querySelectorAll('.sidebar-nav button').forEach(btn => {
    btn.addEventListener('click', function () { navigateTo(this.dataset.section); });
  });
  document.getElementById('hamburgerOpen').addEventListener('click', function () {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.getElementById('logoutBtn').addEventListener('click', async function () {
    if (!confirm('¿Cerrar sesión?')) return;
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.href = '/';
  });

  function updateClock() {
    document.getElementById('clockDisplay').textContent = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  window.closeModal = closeModal;

  // =========================================================
  // 18. INICIALIZAR
  // =========================================================
  (async function init() {
    const ok = await checkAuth();
    if (!ok) return;
    try {
      await loadState();
    } catch (e) { return; }
    applyTheme();
    setInterval(updateClock, 1000);
    updateClock();
    updateWorkerCount();
    navigateTo('dashboard');
  })();

})();
