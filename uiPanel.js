/**
 * uiPanel.js — v4.3
 *
 * FIXES:
 *  - Campo de nombre de ruta más grande y visible.
 *  - Botón "Quitar" en el monitor ahora funciona correctamente.
 *  - UI más intuitiva: flujo guiado, indicadores de estado claros.
 *  - Lista de vehículos con estado online/offline.
 */
const rmUIPanel = (() => {

  let _service = null;
  let _allDevices = [];
  let _selectedDeviceId   = null;
  let _selectedDeviceName = '';
  let _alertCount  = 0;
  let _excCount    = 0;
  let _seenExcIds  = new Set();

  // ── Init ─────────────────────────────────────
  function init(elt, service) {
    _service = service;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    });

    // ── Planificar ──
    document.getElementById('btn-clear-route')?.addEventListener('click', () => {
      if (!confirm('¿Limpiar todos los puntos de la ruta actual?')) return;
      rmRouteBuilder.clearRoute();
    });

    document.getElementById('threshold-slider')?.addEventListener('input', e => {
      document.getElementById('threshold-value').textContent = e.target.value + ' m';
      rmRouteBuilder.setDeviationThreshold(Number(e.target.value));
    });

    document.getElementById('btn-save-route')?.addEventListener('click', () => {
      const name = document.getElementById('route-name-input')?.value?.trim();
      if (!name) return _toast('Escribe un nombre para la ruta antes de guardar', 'warn');
      if (!rmRouteBuilder.hasRoute()) return _toast('Construye la ruta en el mapa primero', 'warn');
      const saved = rmRouteBuilder.saveCurrentRoute(name);
      if (saved) {
        _toast(`✅ Ruta "${name}" guardada`, 'success');
        document.getElementById('route-name-input').value = '';
        // Badge en tab Mis Rutas
        _updateRoutesBadge();
      }
    });

    // ── Asignar ──
    document.getElementById('vehicle-search')?.addEventListener('input', e => {
      _filterVehicleList(e.target.value.toLowerCase().trim());
    });

    document.getElementById('btn-assign')?.addEventListener('click', () => {
      if (!_selectedDeviceId) return _toast('Seleccioná un vehículo de la lista', 'warn');
      if (!rmRouteBuilder.hasRoute()) return _toast('Construye o carga una ruta primero', 'warn');
      const routeName = document.getElementById('route-name-input')?.value?.trim()
        || 'Ruta ' + new Date().toLocaleTimeString('es-AR');
      const id = rmTrackingEngine.assignRoute(
        _selectedDeviceId, _selectedDeviceName,
        rmRouteBuilder.getWaypoints(),
        rmRouteBuilder.getRouteCoords(),
        routeName,
        rmRouteBuilder.getDeviationThreshold()
      );
      _toast(`🚛 Ruta asignada a ${_selectedDeviceName}`, 'success');
      _switchTab('monitor');
      setTimeout(() => rmTrackingEngine.startTracking(id), 300);
    });

    // ── Filtro excepciones ──
    document.getElementById('exception-filter')?.addEventListener('change', e => {
      _renderExceptionLog(rmExceptionsHandler.getFiltered(e.target.value));
    });

    console.log('[rmUIPanel] Inicializado ✓');
  }

  // ── Tabs ─────────────────────────────────────
  function _switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tabId));
  }

  function _updateRoutesBadge() {
    const routes = rmRouteBuilder.getSavedRoutes();
    const badge  = document.getElementById('routes-badge');
    if (badge) badge.textContent = routes.length || '';
  }

  // ── Planificar ────────────────────────────────
  function renderWaypointList(waypoints) {
    const list  = document.getElementById('waypoint-list');
    const empty = document.getElementById('empty-waypoints');
    if (!list) return;
    if (!waypoints.length) {
      list.innerHTML = '';
      if (empty) { empty.style.display = 'flex'; list.appendChild(empty); }
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = waypoints.map((wp, i) => {
      const isFirst = i === 0, isLast = i === waypoints.length - 1;
      const icon  = isFirst ? '🟢' : isLast ? '🔴' : '🔵';
      const role  = isFirst ? 'Inicio' : isLast ? 'Destino' : `Parada ${i}`;
      const label = wp.label || `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
      const zoneBadge = wp.isZone
        ? `<span class="zone-badge">📍 Geocerca</span>`
        : '';
      return `
        <div class="wp-item">
          <div class="wp-dot">${icon}</div>
          <div class="wp-info">
            <span class="wp-role">${role}</span>
            <span class="wp-label">${label}${zoneBadge}</span>
          </div>
          <button class="wp-remove" data-index="${i}" title="Eliminar punto">✕</button>
        </div>`;
    }).join('');
    list.querySelectorAll('.wp-remove').forEach(btn => {
      btn.addEventListener('click', e => rmRouteBuilder.removeWaypoint(+e.currentTarget.dataset.index));
    });
  }

  function updateRouteStats(stats) {
    const el = document.getElementById('route-stats');
    if (!el) return;
    el.style.display = stats ? '' : 'none';
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

  // ── Mis Rutas ─────────────────────────────────
  function renderSavedRoutesList(routes) {
    _updateRoutesBadge();
    const list = document.getElementById('saved-routes-list');
    if (!list) return;
    if (!routes?.length) {
      list.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon">🗂️</div>
          <div class="empty-msg">Sin rutas guardadas</div>
          <div class="empty-hint">Construye una ruta en el mapa y presiona "Guardar ruta"</div>
        </div>`;
      return;
    }
    list.innerHTML = routes.map(r => `
      <div class="saved-card">
        <div class="saved-card-header">
          <span class="saved-card-name">📍 ${r.name}</span>
        </div>
        <div class="saved-card-meta">
          <span>📏 ${(r.distance/1000).toFixed(1)} km</span>
          <span>⏱ ${Math.round(r.duration/60)} min</span>
          <span>📌 ${r.waypoints.length} puntos</span>
        </div>
        <div class="saved-card-actions">
          <button class="btn btn-sm btn-outline" data-load="${r.id}">📂 Cargar en mapa</button>
          <button class="btn btn-sm btn-danger-outline" data-delete="${r.id}">🗑 Eliminar</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-load]').forEach(btn => {
      btn.addEventListener('click', e => {
        const route = rmRouteBuilder.loadRoute(e.currentTarget.dataset.load);
        if (route) { _toast(`📂 "${route.name}" cargada en el mapa`, 'success'); _switchTab('plan'); }
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

  // ── Asignar — vehículos ───────────────────────
  function populateVehicleList(devices) {
    _allDevices = devices || [];
    // Mostrar estado vacío si no hay vehículos
    if (!_allDevices.length) {
      const list = document.getElementById('vehicle-list');
      if (list) list.innerHTML = '<div class="empty-card"><div class="empty-icon">🚛</div><div class="empty-msg">Sin vehículos disponibles</div></div>';
      return;
    }
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
    if (!devices.length) {
      list.innerHTML = '<div class="empty-card"><div class="empty-msg">Sin resultados</div></div>';
      return;
    }
    list.innerHTML = devices.map(d => {
      const isSelected = _selectedDeviceId === d.id;
      const dot = d._online === true ? 'online' : d._online === false ? 'offline' : 'unknown';
      const dotLabel = { online: 'En línea', offline: 'Sin señal', unknown: '' }[dot];
      return `
        <div class="vehicle-card ${isSelected ? 'selected' : ''}" data-id="${d.id}" data-name="${(d.name||'').replace(/"/g,'&quot;')}">
          <div class="vehicle-status-dot ${dot}" title="${dotLabel}"></div>
          <div class="vehicle-card-info">
            <div class="vehicle-card-name">${d.name || 'Sin nombre'}</div>
            <div class="vehicle-card-serial">${d.serialNumber || d.id}</div>
          </div>
          ${isSelected ? '<div class="vehicle-check-icon">✓</div>' : ''}
        </div>`;
    }).join('');
    list.querySelectorAll('.vehicle-card').forEach(card => {
      card.addEventListener('click', () => {
        _selectedDeviceId   = card.dataset.id;
        _selectedDeviceName = card.dataset.name;
        _renderVehicleList(devices);
        _updateAssignBtn();
      });
    });
  }

  function _updateAssignBtn() {
    const btn = document.getElementById('btn-assign');
    if (!btn) return;
    if (_selectedDeviceId) {
      btn.style.display = '';
      btn.innerHTML = `🚛 Asignar ruta a <strong>${_selectedDeviceName}</strong>`;
    } else {
      btn.style.display = 'none';
    }
  }

  // ── Monitor — asignaciones ────────────────────
  function renderAssignmentsList(assignments) {
    const list = document.getElementById('assignments-list');
    if (!list) return;
    const active = assignments.filter(a => a.status !== 'completed');
    if (!active.length) {
      list.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon">📡</div>
          <div class="empty-msg">Sin rutas en curso</div>
          <div class="empty-hint">Asigná una ruta a un vehículo en el tab "Asignar"</div>
        </div>`;
      return;
    }
    list.innerHTML = active.map(a => {
      const statusConf = {
        active:  { icon: '🟢', label: 'En seguimiento', cls: 'status-active' },
        paused:  { icon: '🟡', label: 'Pausado',        cls: 'status-paused' },
        pending: { icon: '⚪', label: 'Pendiente',      cls: 'status-pending' }
      }[a.status] || { icon: '⚪', label: '', cls: '' };

      return `
        <div class="monitor-card" id="card-${a.assignmentId}">
          <div class="monitor-card-header">
            <span class="monitor-card-name">${a.routeName}</span>
            <span class="monitor-status ${statusConf.cls}">${statusConf.icon} ${statusConf.label}</span>
          </div>
          <div class="monitor-vehicle">🚛 ${a.deviceName}</div>

          <div class="monitor-progress-row">
            <span class="monitor-pct" id="pct-${a.assignmentId}">0%</span>
            <div class="monitor-track">
              <div class="monitor-fill" id="bar-${a.assignmentId}" style="width:0%"></div>
            </div>
          </div>
          <div class="monitor-elapsed" id="elapsed-${a.assignmentId}"></div>

          <div class="monitor-stops" id="chk-${a.assignmentId}">
            ${a.waypoints.map((wp, i) => {
              const visited = a.visitedWaypoints?.[i];
              const role = i === 0 ? 'Inicio' : i === a.waypoints.length-1 ? 'Destino' : `Parada ${i}`;
              const label = wp.label || `${wp.lat?.toFixed(4)}, ${wp.lng?.toFixed(4)}`;
              return `<div class="stop-item ${visited ? 'visited' : ''}" id="stop-${a.assignmentId}-${i}">
                <span class="stop-dot">${visited ? '✅' : '⏳'}</span>
                <span class="stop-label"><strong>${role}:</strong> ${label}</span>
              </div>`;
            }).join('')}
          </div>

          <div class="monitor-controls">
            ${a.status === 'active'
              ? `<button class="btn btn-sm btn-warning" data-pause="${a.assignmentId}">⏸ Pausar</button>`
              : `<button class="btn btn-sm btn-success" data-start="${a.assignmentId}">▶ Iniciar</button>`}
            <button class="btn btn-sm btn-danger" data-remove="${a.assignmentId}">✕ Quitar</button>
          </div>
        </div>`;
    }).join('');

    // ── FIX: listeners directos con ID del assignment ──
    list.querySelectorAll('[data-start]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        rmTrackingEngine.startTracking(e.currentTarget.dataset.start);
      });
    });
    list.querySelectorAll('[data-pause]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        rmTrackingEngine.pauseTracking(e.currentTarget.dataset.pause);
      });
    });
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = e.currentTarget.dataset.remove;
        if (!confirm('¿Quitar esta asignación del monitor?')) return;
        rmTrackingEngine.removeAssignment(id);
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
    if (el) el.innerHTML = `<span class="elapsed-icon">⏱</span> ${str}`;
  }

  function updateAssignmentChecklist(assignmentId, visited) {
    visited.forEach((v, i) => {
      const el = document.getElementById(`stop-${assignmentId}-${i}`);
      if (!el) return;
      el.classList.toggle('visited', v);
      const dot = el.querySelector('.stop-dot');
      if (dot) dot.textContent = v ? '✅' : '⏳';
    });
  }

  // ── Alertas ───────────────────────────────────
  function addDeviationAlert(alert) {
    _alertCount++;
    _updateAlertBadge();
    const log = document.getElementById('alert-log');
    if (!log) return;
    log.querySelector('.empty-card')?.remove();
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-card alert-deviation';
    item.innerHTML = `
      <div class="alert-card-header">
        <span class="alert-icon-label">⚠️ DESVÍO</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-card-body">
        <strong>${alert.deviceName}</strong> · ${alert.routeName}<br>
        <span class="alert-detail">${alert.distance}m fuera del corredor</span>
      </div>`;
    log.insertBefore(item, log.firstChild);
  }

  function addReturnToRouteAlert(alert) {
    const log = document.getElementById('alert-log');
    if (!log) return;
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-card alert-return';
    item.innerHTML = `
      <div class="alert-card-header">
        <span class="alert-icon-label">✅ RETORNO A RUTA</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-card-body"><strong>${alert.deviceName}</strong> · ${alert.routeName}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function addSystemAlert(alert) {
    const log = document.getElementById('alert-log');
    if (!log) return;
    const t = alert.timestamp.toLocaleTimeString('es-AR');
    const item = document.createElement('div');
    item.className = 'alert-card alert-system';
    item.innerHTML = `
      <div class="alert-card-header">
        <span class="alert-icon-label">🏁 RUTA COMPLETADA</span>
        <span class="alert-time">${t}</span>
      </div>
      <div class="alert-card-body"><strong>${alert.deviceName}</strong> · ${alert.routeName}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function _updateAlertBadge() {
    const el = document.getElementById('alert-count');
    if (el) { el.textContent = _alertCount; el.style.display = _alertCount > 0 ? '' : 'none'; }
    const el2 = document.getElementById('alert-count-inner');
    if (el2) el2.textContent = _alertCount;
  }

  function addExceptionToLog(exc) {
    if (_seenExcIds.has(exc.id)) return;
    _seenExcIds.add(exc.id);
    _excCount++;
    const ec = document.getElementById('exception-count');
    if (ec) ec.textContent = _excCount;
    const log = document.getElementById('exception-log');
    if (!log) return;
    log.querySelector('.empty-card')?.remove();
    const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
    const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
    const icon = { speed:'🚗💨', zone:'📍', driving:'⚡', other:'📋' }[exc.category] || '📋';
    const item = document.createElement('div');
    item.className = `alert-card exc-card exc-${exc.category}`;
    item.dataset.category = exc.category;
    item.innerHTML = `
      <div class="alert-card-header">
        <span class="alert-icon-label">${icon} ${exc.ruleName}</span>
        <span class="alert-time">${from}</span>
      </div>
      <div class="alert-card-body">${from} → ${to}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function _renderExceptionLog(exceptions) {
    const log = document.getElementById('exception-log');
    if (!log) return;
    if (!exceptions.length) {
      log.innerHTML = '<div class="empty-card"><div class="empty-msg">Sin excepciones para este filtro</div></div>';
      return;
    }
    log.innerHTML = exceptions.map(exc => {
      const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
      const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
      const icon = { speed:'🚗💨', zone:'📍', driving:'⚡', other:'📋' }[exc.category] || '📋';
      return `<div class="alert-card exc-card exc-${exc.category}">
        <div class="alert-card-header"><span class="alert-icon-label">${icon} ${exc.ruleName}</span><span class="alert-time">${from}</span></div>
        <div class="alert-card-body">${from} → ${to}</div></div>`;
    }).join('');
  }

  function clearExceptionLog() {
    const log = document.getElementById('exception-log');
    if (log) log.innerHTML = '<div class="empty-card"><div class="empty-msg">Sin excepciones</div></div>';
    _excCount = 0; _seenExcIds.clear();
    const ec = document.getElementById('exception-count');
    if (ec) ec.textContent = '0';
  }

  // ── Toast ─────────────────────────────────────
  function _toast(msg, type = 'info') {
    const colors = { info:'#2563EB', success:'#16A34A', warn:'#D97706', error:'#DC2626' };
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
      background:${colors[type]};color:#fff;padding:10px 18px;border-radius:8px;
      font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.3);z-index:9999;
      animation:rmFadeIn .2s ease;pointer-events:none;white-space:nowrap;max-width:300px;
      text-align:center;line-height:1.4;`;
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
