/**
 * uiPanel.js — Panel lateral completo.
 *
 * FIXES:
 *  - Carga de vehículos: usa multiCall para obtener DeviceStatusInfo junto con Device,
 *    y muestra estado de conectividad.
 *  - Multi-ruta: tab "Rutas Activas" con lista de todas las asignaciones.
 *  - Guardar rutas: tab "Mis Rutas" con CRUD de rutas guardadas.
 *  - Progreso por asignación individual.
 */
const rmUIPanel = (() => {

  let _service = null;
  let _allDevices = [];
  let _selectedDeviceId = null;
  let _selectedDeviceName = '';
  let _alertCount = 0;
  let _excCount = 0;
  let _seenExcIds = new Set();

  // ─────────────────────────────────────────────
  // Init — conectar TODOS los listeners del DOM
  // ─────────────────────────────────────────────
  function init(elt, service) {
    _service = service;

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    });

    // ── Planificar ──
    document.getElementById('btn-clear-route')?.addEventListener('click', () => {
      rmRouteBuilder.clearRoute();
    });

    document.getElementById('threshold-slider')?.addEventListener('input', e => {
      document.getElementById('threshold-value').textContent = e.target.value + ' m';
      rmRouteBuilder.setDeviationThreshold(Number(e.target.value));
    });

    // Guardar ruta con nombre
    document.getElementById('btn-save-route')?.addEventListener('click', () => {
      const name = document.getElementById('route-name-input')?.value?.trim();
      if (!name) return _toast('Ingresá un nombre para la ruta', 'warn');
      if (!rmRouteBuilder.hasRoute()) return _toast('Primero construye la ruta en el mapa', 'warn');
      const saved = rmRouteBuilder.saveCurrentRoute(name);
      if (saved) {
        _toast(`Ruta "${name}" guardada ✓`, 'success');
        if (document.getElementById('route-name-input'))
          document.getElementById('route-name-input').value = '';
      }
    });

    // ── Asignar ──
    document.getElementById('vehicle-search')?.addEventListener('input', e => {
      _filterVehicleList(e.target.value.toLowerCase().trim());
    });

    document.getElementById('btn-assign')?.addEventListener('click', () => {
      if (!_selectedDeviceId) return _toast('Seleccioná un vehículo', 'warn');
      if (!rmRouteBuilder.hasRoute()) return _toast('Construye la ruta primero en el mapa', 'warn');
      const threshold = rmRouteBuilder.getDeviationThreshold();
      const id = rmTrackingEngine.assignRoute(
        _selectedDeviceId, _selectedDeviceName,
        rmRouteBuilder.getWaypoints(),
        rmRouteBuilder.getRouteCoords(),
        document.getElementById('route-name-input')?.value?.trim() || 'Ruta ' + new Date().toLocaleTimeString('es-AR'),
        threshold
      );
      _toast(`Ruta asignada a ${_selectedDeviceName} ✓`, 'success');
      _switchTab('monitor');
      // Auto-iniciar seguimiento
      setTimeout(() => rmTrackingEngine.startTracking(id), 500);
    });

    // ── Alertas / filtro excepciones ──
    document.getElementById('exception-filter')?.addEventListener('change', e => {
      _renderExceptionLog(rmExceptionsHandler.getFiltered(e.target.value));
    });

    console.log('[rmUIPanel] Inicializado ✓');
  }

  // ─────────────────────────────────────────────
  // Tabs
  // ─────────────────────────────────────────────
  function _switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tabId));
  }

  // ─────────────────────────────────────────────
  // PLANIFICAR — helpers
  // ─────────────────────────────────────────────
  function renderWaypointList(waypoints) {
    const list = document.getElementById('waypoint-list');
    const empty = document.getElementById('empty-waypoints');
    if (!list) return;
    if (waypoints.length === 0) {
      list.innerHTML = '';
      if (empty) { empty.style.display = 'block'; list.appendChild(empty); }
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = waypoints.map((wp, i) => {
      const label = i === 0 ? '🟢 Inicio' : i === waypoints.length-1 ? '🔴 Destino' : `🔵 Punto ${i}`;
      return `
        <div class="waypoint-item">
          <div class="waypoint-info">
            <span class="waypoint-label">${label}</span>
            <span class="waypoint-coords">${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}</span>
          </div>
          <button class="waypoint-remove" data-index="${i}" title="Eliminar">✕</button>
        </div>`;
    }).join('');
    list.querySelectorAll('.waypoint-remove').forEach(btn => {
      btn.addEventListener('click', e => rmRouteBuilder.removeWaypoint(+e.currentTarget.dataset.index));
    });
  }

  function updateRouteStats(stats) {
    const el = document.getElementById('route-stats');
    if (!el) return;
    el.style.display = stats ? 'block' : 'none';
    if (stats) {
      const d = document.getElementById('stat-distance');
      const t = document.getElementById('stat-time');
      if (d) d.textContent = stats.distance;
      if (t) t.textContent = stats.duration;
    }
  }

  function showClearButton(show) {
    const btn = document.getElementById('btn-clear-route');
    if (btn) btn.style.display = show ? '' : 'none';
  }

  function setHelpText(text) {
    const el = document.getElementById('help-text-plan');
    if (el) el.textContent = text;
  }

  // ─────────────────────────────────────────────
  // Rutas guardadas
  // ─────────────────────────────────────────────
  function renderSavedRoutesList(routes) {
    const list = document.getElementById('saved-routes-list');
    if (!list) return;
    if (!routes || routes.length === 0) {
      list.innerHTML = '<div class="empty-state">Sin rutas guardadas</div>';
      return;
    }
    list.innerHTML = routes.map(r => `
      <div class="saved-route-item">
        <div class="saved-route-info">
          <span class="saved-route-name">${r.name}</span>
          <span class="saved-route-meta">
            ${(r.distance/1000).toFixed(1)}km · ${Math.round(r.duration/60)}min · ${r.waypoints.length} puntos
          </span>
        </div>
        <div class="saved-route-actions">
          <button class="icon-btn" data-load="${r.id}" title="Cargar en mapa">📂</button>
          <button class="icon-btn icon-btn-danger" data-delete="${r.id}" title="Eliminar">🗑</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-load]').forEach(btn => {
      btn.addEventListener('click', e => {
        const route = rmRouteBuilder.loadRoute(e.currentTarget.dataset.load);
        if (route) { _toast(`"${route.name}" cargada en el mapa ✓`, 'success'); _switchTab('plan'); }
      });
    });
    list.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', e => {
        if (!confirm('¿Eliminar esta ruta guardada?')) return;
        rmRouteBuilder.deleteRoute(e.currentTarget.dataset.delete);
        _toast('Ruta eliminada', 'info');
      });
    });
  }

  // ─────────────────────────────────────────────
  // ASIGNAR — lista de vehículos
  // FIX: Ahora llama la API con multiCall para obtener Device + DeviceStatusInfo
  // ─────────────────────────────────────────────
  function populateVehicleList(devices) {
    _allDevices = devices || [];
    _renderVehicleList(_allDevices);
  }

  function _filterVehicleList(q) {
    const filtered = !q ? _allDevices : _allDevices.filter(d =>
      (d.name || '').toLowerCase().includes(q) || (d.serialNumber || '').toLowerCase().includes(q)
    );
    _renderVehicleList(filtered);
  }

  function _renderVehicleList(devices) {
    const list = document.getElementById('vehicle-list');
    if (!list) return;
    if (devices.length === 0) {
      list.innerHTML = '<div class="empty-state">Sin vehículos encontrados</div>';
      return;
    }
    list.innerHTML = devices.map(d => {
      const isSelected = _selectedDeviceId === d.id;
      const statusDot = d._online ? '🟢' : d._online === false ? '🔴' : '⚪';
      return `
        <div class="vehicle-item ${isSelected ? 'selected' : ''}" data-id="${d.id}" data-name="${(d.name||'').replace(/"/g,'&quot;')}">
          <div class="vehicle-icon">${statusDot}</div>
          <div class="vehicle-info">
            <div class="vehicle-name">${d.name || 'Sin nombre'}</div>
            <div class="vehicle-serial">${d.serialNumber || d.id}</div>
          </div>
          ${isSelected ? '<div class="vehicle-check">✓</div>' : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', () => {
        _selectedDeviceId   = item.dataset.id;
        _selectedDeviceName = item.dataset.name;
        _renderVehicleList(devices);
        _updateAssignButton();
      });
    });
  }

  function _updateAssignButton() {
    const btn = document.getElementById('btn-assign');
    if (btn) {
      btn.style.display = _selectedDeviceId ? '' : 'none';
      btn.textContent = `Asignar ruta a ${_selectedDeviceName || 'vehículo'}`;
    }
  }

  // ─────────────────────────────────────────────
  // MONITOR — lista de asignaciones activas
  // ─────────────────────────────────────────────
  function renderAssignmentsList(assignments) {
    const list = document.getElementById('assignments-list');
    if (!list) return;

    const active = assignments.filter(a => a.status !== 'completed');
    if (active.length === 0) {
      list.innerHTML = '<div class="empty-state">Sin rutas activas — asigná una ruta en el tab Asignar</div>';
      return;
    }

    list.innerHTML = active.map(a => {
      const statusIcon  = { active: '🟢', paused: '🟡', pending: '⚪' }[a.status] || '⚪';
      const statusLabel = { active: 'En seguimiento', paused: 'Pausado', pending: 'Pendiente' }[a.status] || '';
      return `
        <div class="assignment-card" id="card-${a.assignmentId}">
          <div class="assignment-header">
            <span class="assignment-name">${statusIcon} ${a.routeName}</span>
            <span class="assignment-status">${statusLabel}</span>
          </div>
          <div class="assignment-vehicle">🚛 ${a.deviceName}</div>
          <div class="assignment-progress-row">
            <span class="assignment-pct" id="pct-${a.assignmentId}">0%</span>
            <div class="assignment-progress-track">
              <div class="assignment-progress-fill" id="bar-${a.assignmentId}" style="width:0%"></div>
            </div>
          </div>
          <div class="assignment-elapsed" id="elapsed-${a.assignmentId}"></div>
          <div class="assignment-checklist" id="chk-${a.assignmentId}">
            ${a.waypoints.map((wp, i) => `
              <div class="chk-item ${a.visitedWaypoints?.[i] ? 'visited' : ''}" id="chkwp-${a.assignmentId}-${i}">
                <span class="chk-icon">${a.visitedWaypoints?.[i] ? '✅' : '⏳'}</span>
                <span>${i === 0 ? 'Inicio' : i === a.waypoints.length-1 ? 'Destino' : `Parada ${i}`}</span>
              </div>`).join('')}
          </div>
          <div class="assignment-controls">
            ${a.status === 'active'
              ? `<button class="btn btn-sm btn-warning" data-pause="${a.assignmentId}">⏸ Pausar</button>`
              : `<button class="btn btn-sm btn-success" data-start="${a.assignmentId}">▶ Iniciar</button>`}
            <button class="btn btn-sm btn-danger" data-remove="${a.assignmentId}">✕ Quitar</button>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-start]').forEach(btn => {
      btn.addEventListener('click', e => rmTrackingEngine.startTracking(e.currentTarget.dataset.start));
    });
    list.querySelectorAll('[data-pause]').forEach(btn => {
      btn.addEventListener('click', e => rmTrackingEngine.pauseTracking(e.currentTarget.dataset.pause));
    });
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', e => {
        if (!confirm('¿Quitar esta asignación?')) return;
        rmTrackingEngine.removeAssignment(e.currentTarget.dataset.remove);
      });
    });
  }

  function updateAssignmentProgress(assignmentId, progress) {
    const pct = document.getElementById(`pct-${assignmentId}`);
    const bar = document.getElementById(`bar-${assignmentId}`);
    if (pct) pct.textContent = progress.percent + '%';
    if (bar) bar.style.width = progress.percent + '%';
  }

  function updateAssignmentElapsed(assignmentId, str) {
    const el = document.getElementById(`elapsed-${assignmentId}`);
    if (el) el.textContent = '⏱ ' + str;
  }

  function updateAssignmentChecklist(assignmentId, visited) {
    visited.forEach((v, i) => {
      const el = document.getElementById(`chkwp-${assignmentId}-${i}`);
      if (!el) return;
      el.classList.toggle('visited', v);
      const icon = el.querySelector('.chk-icon');
      if (icon) icon.textContent = v ? '✅' : '⏳';
    });
  }

  // ─────────────────────────────────────────────
  // ALERTAS
  // ─────────────────────────────────────────────
  function addDeviationAlert(alert) {
    _alertCount++;
    _updateAlertBadge();
    const log = document.getElementById('alert-log');
    if (!log) return;
    log.querySelector('.empty-state')?.remove();
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-item alert-deviation';
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">⚠️ DESVÍO — ${alert.deviceName}</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-body">${alert.routeName} · ${alert.distance}m fuera de ruta</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function addReturnToRouteAlert(alert) {
    const log = document.getElementById('alert-log');
    if (!log) return;
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-item alert-return';
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">✅ RETORNO — ${alert.deviceName}</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-body">${alert.routeName}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function addSystemAlert(alert) {
    const log = document.getElementById('alert-log');
    if (!log) return;
    const icons = { completed: '🏁' };
    const labels = { completed: 'RUTA COMPLETADA' };
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-item alert-system';
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">${icons[alert.type] || '📋'} ${labels[alert.type] || ''} — ${alert.deviceName}</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-body">${alert.routeName}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function _updateAlertBadge() {
    const el = document.getElementById('alert-count');
    if (el) el.textContent = _alertCount;
  }

  function addExceptionToLog(exc) {
    if (_seenExcIds.has(exc.id)) return;
    _seenExcIds.add(exc.id);
    _excCount++;
    const ec = document.getElementById('exception-count');
    if (ec) ec.textContent = _excCount;
    const log = document.getElementById('exception-log');
    if (!log) return;
    log.querySelector('.empty-state')?.remove();
    const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
    const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
    const icon = { speed:'🚗💨', zone:'📍', driving:'⚡', other:'📋' }[exc.category] || '📋';
    const item = document.createElement('div');
    item.className = `alert-item alert-exception alert-cat-${exc.category}`;
    item.dataset.category = exc.category;
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">${icon} ${exc.ruleName}</span>
        <span class="alert-time">${from}</span>
      </div>
      <div class="alert-body">${from} → ${to}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function _renderExceptionLog(exceptions) {
    const log = document.getElementById('exception-log');
    if (!log) return;
    if (!exceptions.length) {
      log.innerHTML = '<div class="empty-state">Sin excepciones para este filtro</div>';
      return;
    }
    log.innerHTML = exceptions.map(exc => {
      const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
      const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
      const icon = { speed:'🚗💨', zone:'📍', driving:'⚡', other:'📋' }[exc.category] || '📋';
      return `<div class="alert-item alert-exception alert-cat-${exc.category}">
        <div class="alert-header"><span class="alert-badge">${icon} ${exc.ruleName}</span><span class="alert-time">${from}</span></div>
        <div class="alert-body">${from} → ${to}</div></div>`;
    }).join('');
  }

  function clearExceptionLog() {
    const log = document.getElementById('exception-log');
    if (log) log.innerHTML = '<div class="empty-state">Sin excepciones</div>';
    _excCount = 0; _seenExcIds.clear();
    const ec = document.getElementById('exception-count');
    if (ec) ec.textContent = '0';
  }

  // ─────────────────────────────────────────────
  // Toast
  // ─────────────────────────────────────────────
  function _toast(msg, type = 'info') {
    const colors = { info:'#2563EB', success:'#16A34A', warn:'#D97706', error:'#DC2626' };
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
      background:${colors[type]};color:#fff;padding:10px 20px;border-radius:8px;
      font-size:13px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.35);z-index:9999;
      animation:rmFadeIn .2s ease;pointer-events:none;white-space:nowrap;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  return {
    init,
    renderWaypointList, updateRouteStats, showClearButton, setHelpText,
    renderSavedRoutesList,
    populateVehicleList,
    renderAssignmentsList, updateAssignmentProgress, updateAssignmentElapsed, updateAssignmentChecklist,
    addDeviationAlert, addReturnToRouteAlert, addSystemAlert,
    addExceptionToLog, clearExceptionLog
  };
})();
