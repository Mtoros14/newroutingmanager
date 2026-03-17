/**
 * uiPanel.js
 * Gestión del panel lateral: tabs, listas de waypoints, vehículos,
 * progreso, alertas y excepciones.
 */

const rmUIPanel = (() => {

  let _service = null;
  let _allDevices = [];
  let _selectedDeviceId = null;
  let _alertCount = 0;
  let _exceptionCount = 0;
  let _seenExcIds = new Set();
  let _seenAlertTimestamps = new Set();

  // ─────────────────────────────────────────────
  // Inicialización — conectar todos los event listeners
  // ─────────────────────────────────────────────

  function init(elt, service) {
    _service = service;

    // ── Tabs ──
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    });

    // ── Planificar ──
    document.getElementById('btn-clear-route')?.addEventListener('click', () => {
      rmRouteBuilder.clearRoute();
      rmTrackingEngine.clearTracking();
      rmExceptionsHandler.clear();
      _alertCount = 0;
      _exceptionCount = 0;
      _seenAlertTimestamps.clear();
      _seenExcIds.clear();
      _updateAlertCount(0);
      _updateExceptionCount(0);
    });

    const slider = document.getElementById('threshold-slider');
    slider?.addEventListener('input', (e) => {
      document.getElementById('threshold-value').textContent = e.target.value + ' m';
      rmRouteBuilder.setDeviationThreshold(Number(e.target.value));
    });

    // ── Asignar ──
    document.getElementById('vehicle-search')?.addEventListener('input', (e) => {
      _filterVehicleList(e.target.value.toLowerCase().trim());
    });

    document.getElementById('btn-assign')?.addEventListener('click', () => {
      if (!_selectedDeviceId) {
        _showToast('Selecciona un vehículo primero', 'warn');
        return;
      }
      if (!rmRouteBuilder.hasRoute()) {
        _showToast('Primero construye una ruta haciendo clic en el mapa', 'warn');
        return;
      }
      rmTrackingEngine.assignRoute(
        _selectedDeviceId,
        rmRouteBuilder.getWaypoints(),
        rmRouteBuilder.getRouteCoords()
      );
      _showToast('Ruta asignada correctamente ✓', 'success');
      _switchTab('progress');
    });

    // ── Progreso ──
    document.getElementById('btn-start-tracking')?.addEventListener('click', () => {
      rmTrackingEngine.startTracking();
    });

    document.getElementById('btn-stop-tracking')?.addEventListener('click', () => {
      rmTrackingEngine.stopTracking();
    });

    // ── Filtro de excepciones ──
    document.getElementById('exception-filter')?.addEventListener('change', (e) => {
      _renderExceptionLog(rmExceptionsHandler.getFiltered(e.target.value));
    });

    console.log('[rmUIPanel] Inicializado, event listeners registrados');
  }

  // ─────────────────────────────────────────────
  // Tabs
  // ─────────────────────────────────────────────

  function _switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tabId));
  }

  // ─────────────────────────────────────────────
  // Lista de waypoints (tab Planificar)
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
      const label = i === 0 ? '🟢 Inicio' : (i === waypoints.length - 1 ? '🔴 Destino' : `🔵 Punto ${i}`);
      const coords = `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
      return `
        <div class="waypoint-item">
          <div class="waypoint-info">
            <span class="waypoint-label">${label}</span>
            <span class="waypoint-coords">${coords}</span>
          </div>
          <button class="waypoint-remove" data-index="${i}" title="Eliminar punto">✕</button>
        </div>`;
    }).join('');

    // Event listeners para botones de eliminar
    list.querySelectorAll('.waypoint-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.index);
        rmRouteBuilder.removeWaypoint(idx);
      });
    });
  }

  function updateRouteStats(stats) {
    const container = document.getElementById('route-stats');
    if (!container) return;
    if (!stats) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';
    const distEl = document.getElementById('stat-distance');
    const timeEl = document.getElementById('stat-time');
    if (distEl) distEl.textContent = stats.distance || '0 km';
    if (timeEl) timeEl.textContent = stats.duration || '0 min';
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
  // Lista de vehículos (tab Asignar)
  // ─────────────────────────────────────────────

  function populateVehicleList(devices) {
    _allDevices = devices || [];
    _renderVehicleList(_allDevices);
  }

  function _filterVehicleList(query) {
    if (!query) {
      _renderVehicleList(_allDevices);
      return;
    }
    const filtered = _allDevices.filter(d =>
      (d.name || '').toLowerCase().includes(query) ||
      (d.serialNumber || '').toLowerCase().includes(query)
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

    list.innerHTML = devices.map(d => `
      <div class="vehicle-item ${_selectedDeviceId === d.id ? 'selected' : ''}" data-id="${d.id}">
        <div class="vehicle-icon">🚛</div>
        <div class="vehicle-info">
          <div class="vehicle-name">${d.name || 'Vehículo sin nombre'}</div>
          <div class="vehicle-serial">${d.serialNumber || d.id}</div>
        </div>
        ${_selectedDeviceId === d.id ? '<div class="vehicle-check">✓</div>' : ''}
      </div>
    `).join('');

    list.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', () => {
        _selectedDeviceId = item.dataset.id;
        _renderVehicleList(
          document.getElementById('vehicle-search')?.value
            ? devices
            : _allDevices
        );
        _updateAssignButton();
      });
    });
  }

  function _updateAssignButton() {
    const btn = document.getElementById('btn-assign');
    if (!btn) return;
    btn.style.display = _selectedDeviceId ? '' : 'none';
    btn.textContent = `Asignar ruta a ${_allDevices.find(d => d.id === _selectedDeviceId)?.name || 'vehículo'}`;
  }

  // ─────────────────────────────────────────────
  // Progreso (tab Progreso)
  // ─────────────────────────────────────────────

  function showProgressPanel(data) {
    const empty = document.getElementById('progress-empty');
    const content = document.getElementById('progress-content');
    if (empty) empty.style.display = 'none';
    if (content) content.style.display = '';

    // Total
    const distTotal = document.getElementById('prog-dist-total');
    if (distTotal && data.distanceTotal) {
      distTotal.textContent = (data.distanceTotal / 1000).toFixed(1) + ' km';
    }
    const timeEst = document.getElementById('prog-time-est');
    if (timeEst && data.durationEst) {
      timeEst.textContent = Math.round(data.durationEst / 60) + ' min';
    }

    // Checklist de waypoints
    _buildWaypointChecklist(data.waypoints);
  }

  function _buildWaypointChecklist(waypoints) {
    const container = document.getElementById('waypoint-checklist');
    if (!container || !waypoints) return;
    container.innerHTML = waypoints.map((wp, i) => {
      const label = i === 0 ? 'Inicio' : (i === waypoints.length - 1 ? 'Destino' : `Parada ${i}`);
      return `
        <div class="checklist-item" id="chk-wp-${i}">
          <span class="chk-icon">⏳</span>
          <span class="chk-label">${label}</span>
        </div>`;
    }).join('');
  }

  function updateWaypointChecklist(visited) {
    visited.forEach((v, i) => {
      const item = document.getElementById(`chk-wp-${i}`);
      if (!item) return;
      const icon = item.querySelector('.chk-icon');
      if (icon) icon.textContent = v ? '✅' : '⏳';
      item.classList.toggle('visited', v);
    });
  }

  function updateProgress(progress) {
    const pct = document.getElementById('progress-percent');
    const bar = document.getElementById('progress-bar');
    const done = document.getElementById('prog-dist-done');

    if (pct) pct.textContent = progress.percent + '%';
    if (bar) bar.style.width = progress.percent + '%';
    if (done) done.textContent = (progress.distanceDone / 1000).toFixed(1) + ' km';
  }

  function updateElapsed(timeStr) {
    const el = document.getElementById('prog-time-elapsed');
    if (el) el.textContent = timeStr;
  }

  function setTrackingState(isTracking) {
    const startBtn = document.getElementById('btn-start-tracking');
    const stopBtn = document.getElementById('btn-stop-tracking');
    if (startBtn) startBtn.style.display = isTracking ? 'none' : '';
    if (stopBtn) stopBtn.style.display = isTracking ? '' : 'none';
  }

  // ─────────────────────────────────────────────
  // Alertas de desvío (tab Alertas)
  // ─────────────────────────────────────────────

  function addDeviationAlert(alert) {
    const key = alert.timestamp.toISOString().substring(0, 19); // agrupar por segundo
    if (_seenAlertTimestamps.has(key)) return;
    _seenAlertTimestamps.add(key);

    _alertCount++;
    _updateAlertCount(_alertCount);

    const log = document.getElementById('alert-log');
    if (!log) return;

    // Limpiar estado vacío
    const empty = log.querySelector('.empty-state');
    if (empty) empty.remove();

    const time = alert.timestamp.toLocaleTimeString('es-AR');
    const dist = alert.distance ? ` (${alert.distance}m fuera de ruta)` : '';
    const coords = alert.position
      ? `${alert.position.lat.toFixed(5)}, ${alert.position.lng.toFixed(5)}`
      : '';

    const item = document.createElement('div');
    item.className = 'alert-item alert-deviation';
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">⚠️ DESVÍO</span>
        <span class="alert-time">${time}</span>
      </div>
      <div class="alert-body">${coords}${dist}</div>`;
    log.insertBefore(item, log.firstChild); // más reciente arriba
  }

  function _updateAlertCount(n) {
    const el = document.getElementById('alert-count');
    if (el) el.textContent = n;
  }

  // ─────────────────────────────────────────────
  // Excepciones (tab Alertas)
  // ─────────────────────────────────────────────

  function addExceptionToLog(exc) {
    if (_seenExcIds.has(exc.id)) return;
    _seenExcIds.add(exc.id);
    _exceptionCount++;
    _updateExceptionCount(_exceptionCount);

    const log = document.getElementById('exception-log');
    if (!log) return;

    const empty = log.querySelector('.empty-state');
    if (empty) empty.remove();

    const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
    const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
    const catIcon = { speed: '🚗💨', zone: '📍', driving: '⚡', other: '📋' }[exc.category] || '📋';

    const item = document.createElement('div');
    item.className = `alert-item alert-exception alert-cat-${exc.category}`;
    item.dataset.category = exc.category;
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-badge">${catIcon} ${exc.ruleName}</span>
        <span class="alert-time">${from}</span>
      </div>
      <div class="alert-body">${from} → ${to}</div>`;
    log.insertBefore(item, log.firstChild);
  }

  function _renderExceptionLog(exceptions) {
    const log = document.getElementById('exception-log');
    if (!log) return;
    if (exceptions.length === 0) {
      log.innerHTML = '<div class="empty-state">Sin excepciones para este filtro</div>';
      return;
    }
    log.innerHTML = exceptions.map(exc => {
      const from = exc.from ? new Date(exc.from).toLocaleTimeString('es-AR') : '--';
      const to   = exc.to   ? new Date(exc.to).toLocaleTimeString('es-AR')   : 'activa';
      const catIcon = { speed: '🚗💨', zone: '📍', driving: '⚡', other: '📋' }[exc.category] || '📋';
      return `
        <div class="alert-item alert-exception alert-cat-${exc.category}">
          <div class="alert-header">
            <span class="alert-badge">${catIcon} ${exc.ruleName}</span>
            <span class="alert-time">${from}</span>
          </div>
          <div class="alert-body">${from} → ${to}</div>
        </div>`;
    }).join('');
  }

  function _updateExceptionCount(n) {
    const el = document.getElementById('exception-count');
    if (el) el.textContent = n;
  }

  function clearExceptionLog() {
    const log = document.getElementById('exception-log');
    if (log) log.innerHTML = '<div class="empty-state">Sin excepciones</div>';
    _exceptionCount = 0;
    _seenExcIds.clear();
    _updateExceptionCount(0);
  }

  // ─────────────────────────────────────────────
  // Toast genérico
  // ─────────────────────────────────────────────

  function _showToast(msg, type = 'info') {
    const colors = { info: '#2563EB', success: '#16A34A', warn: '#D97706', error: '#DC2626' };
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
      background:${colors[type]}; color:#fff; padding:10px 20px;
      border-radius:8px; font-size:13px; font-weight:600;
      box-shadow:0 4px 12px rgba(0,0,0,0.3); z-index:9999;
      animation: rmFadeIn 0.2s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  return {
    init,
    renderWaypointList,
    updateRouteStats,
    showClearButton,
    setHelpText,
    populateVehicleList,
    showProgressPanel,
    updateProgress,
    updateElapsed,
    updateWaypointChecklist,
    setTrackingState,
    addDeviationAlert,
    addExceptionToLog,
    clearExceptionLog
  };

})();
