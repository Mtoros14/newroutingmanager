/**
 * trackingEngine.js
 * Motor de seguimiento en tiempo real. Soporta MÚLTIPLES rutas/vehículos simultáneos.
 *
 * Cada asignación tiene:
 *   { assignmentId, deviceId, deviceName, routeId, routeName,
 *     waypoints, routeCoords, threshold, status,
 *     startTime, realPathSegments, visitedWaypoints,
 *     vehicleMarker, lastPosition, deviating }
 */
const rmTrackingEngine = (() => {

  let _service = null;
  let _assignments = {};          // key: assignmentId
  let _elapsedTimers = {};        // key: assignmentId → setInterval
  let _startTimes = {};           // key: assignmentId → Date

  // Polling manual cada 30s para excepciones (además de service.events)
  let _excPollingTimer = null;

  // ─────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────
  function init(service) {
    _service = service;
    _service.events.attach('change', _handleDeviceChange);
    _service.events.attach('click',  _handleMapClick);
    _restoreFromStorage();
    console.log('[rmTracking] Inicializado, escuchando eventos del mapa');
  }

  // ─────────────────────────────────────────────
  // Asignar ruta a vehículo (multi-ruta)
  // ─────────────────────────────────────────────
  function assignRoute(deviceId, deviceName, waypoints, routeCoords, routeName, threshold) {
    const assignmentId = 'asgn_' + Date.now();
    const assignment = {
      assignmentId,
      deviceId, deviceName,
      routeName: routeName || 'Ruta sin nombre',
      waypoints: waypoints.map(w => ({...w})),
      routeCoords: [...routeCoords],
      threshold: threshold || 100,
      status: 'pending',           // pending | active | paused | completed
      startTime: null,
      realPathSegments: [],
      visitedWaypoints: new Array(waypoints.length).fill(false),
      vehicleMarker: null,
      lastPosition: null,
      deviating: false,
      deviationCount: 0
    };

    _assignments[assignmentId] = assignment;
    _persistAssignments();
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    console.log(`[rmTracking] Asignación creada: ${assignmentId} → ${deviceName}`);
    return assignmentId;
  }

  // ─────────────────────────────────────────────
  // Iniciar / pausar / finalizar seguimiento
  // ─────────────────────────────────────────────
  function startTracking(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    a.status = 'active';
    a.startTime = a.startTime || new Date().toISOString();
    _startTimes[assignmentId] = new Date(a.startTime);
    _elapsedTimers[assignmentId] = setInterval(() => _updateElapsed(assignmentId), 1000);
    _fetchCurrentPosition(assignmentId);
    _persistAssignments();
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    _startExcPolling();
  }

  function pauseTracking(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    a.status = 'paused';
    clearInterval(_elapsedTimers[assignmentId]);
    _persistAssignments();
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
  }

  function removeAssignment(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    clearInterval(_elapsedTimers[assignmentId]);
    // Limpiar canvas
    a.realPathSegments.forEach(s => { try { s.remove(); } catch(e) {} });
    if (a.vehicleMarker) { try { a.vehicleMarker.remove(); } catch(e) {} }
    delete _assignments[assignmentId];
    delete _elapsedTimers[assignmentId];
    delete _startTimes[assignmentId];
    _persistAssignments();
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
  }

  // ─────────────────────────────────────────────
  // Elapsed timer
  // ─────────────────────────────────────────────
  function _updateElapsed(assignmentId) {
    const start = _startTimes[assignmentId];
    if (!start) return;
    const secs = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
    const str = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    rmUIPanel.updateAssignmentElapsed(assignmentId, str);
  }

  // ─────────────────────────────────────────────
  // Obtener posición actual via API (inicio de sesión)
  // ─────────────────────────────────────────────
  function _fetchCurrentPosition(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    _service.api.call('Get', {
      typeName: 'DeviceStatusInfo',
      search: { deviceSearch: { id: a.deviceId } }
    }).then(results => {
      if (results?.[0]?.latitude && results[0].longitude) {
        _processPosition(assignmentId, {
          lat: results[0].latitude,
          lng: results[0].longitude
        });
      }
    }).catch(err => console.warn('[rmTracking] Error posición inicial:', err));
  }

  // ─────────────────────────────────────────────
  // Handler: cambio de posición en mapa (tiempo real)
  // ─────────────────────────────────────────────
  function _handleDeviceChange(data) {
    if (!data || data.type !== 'device' || !data.location) return;
    // Buscar qué asignación corresponde a este vehículo
    for (const [id, a] of Object.entries(_assignments)) {
      if (a.status === 'active' && a.deviceId === data.entity.id) {
        _processPosition(id, { lat: data.location.lat, lng: data.location.lng });
      }
    }
  }

  // Handler: click en icono de excepción en el mapa
  function _handleMapClick(data) {
    if (!data || data.type !== 'exceptions' || !data.entity?.exceptions) return;
    data.entity.exceptions.forEach(exc => {
      rmExceptionsHandler.logException({
        id: exc.id, ruleId: exc.rule?.id, deviceId: exc.device?.id,
        from: exc.from, to: exc.to
      }, _service);
    });
  }

  // ─────────────────────────────────────────────
  // Procesamiento de nueva posición
  // ─────────────────────────────────────────────
  function _processPosition(assignmentId, pos) {
    const a = _assignments[assignmentId];
    if (!a || a.status !== 'active') return;

    const onRoute = rmDeviationDetector.isOnRoute(pos, a.routeCoords, a.threshold);

    // Dibujar segmento recorrido
    if (a.lastPosition) _drawRealSegment(a, a.lastPosition, pos, onRoute);
    _updateVehicleMarker(a, pos);
    a.lastPosition = pos;

    // Progreso
    const progress = rmDeviationDetector.calculateProgress(pos, a.routeCoords);
    rmUIPanel.updateAssignmentProgress(assignmentId, progress);

    // Waypoints visitados
    a.visitedWaypoints = rmDeviationDetector.updateVisitedWaypoints(
      pos, a.waypoints, a.visitedWaypoints, a.threshold * 1.5
    );
    rmUIPanel.updateAssignmentChecklist(assignmentId, a.visitedWaypoints);

    // Detección de desvío
    if (!onRoute) {
      if (!a.deviating) {
        a.deviating = true;
        a.deviationCount++;
        const dist = rmDeviationDetector.minDistanceToRoute(pos, a.routeCoords);
        rmUIPanel.addDeviationAlert({ assignmentId, deviceName: a.deviceName,
          routeName: a.routeName, timestamp: new Date(), position: pos, distance: dist });
      }
    } else {
      if (a.deviating) {
        a.deviating = false;
        rmUIPanel.addReturnToRouteAlert({ assignmentId, deviceName: a.deviceName,
          routeName: a.routeName, timestamp: new Date() });
      }
    }

    // ¿Ruta completada? (todos los waypoints visitados)
    if (a.visitedWaypoints.every(v => v) && progress.percent >= 95) {
      a.status = 'completed';
      clearInterval(_elapsedTimers[assignmentId]);
      rmUIPanel.addSystemAlert({ type: 'completed', deviceName: a.deviceName,
        routeName: a.routeName, timestamp: new Date() });
      _persistAssignments();
      rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    }
  }

  // ─────────────────────────────────────────────
  // Canvas: segmentos verde/rojo y marcador
  // ─────────────────────────────────────────────
  function _drawRealSegment(assignment, from, to, onRoute) {
    const seg = _service.canvas.path([
      { type: 'M', points: [from] },
      { type: 'L', points: [to] }
    ], 20).change({
      stroke: onRoute ? '#16A34A' : '#DC2626',
      'stroke-width': 5, fill: 'none'
    });
    assignment.realPathSegments.push(seg);
  }

  function _updateVehicleMarker(assignment, pos) {
    const svgTruck = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="#1E40AF" stroke="white" stroke-width="1.5"><rect x="1" y="8" width="15" height="10" rx="1"/><path d="M16 10h4l3 4v4h-7V10z"/><circle cx="5.5" cy="19" r="1.5"/><circle cx="18.5" cy="19" r="1.5"/></svg>`;
    if (assignment.vehicleMarker) { try { assignment.vehicleMarker.remove(); } catch(e) {} }
    assignment.vehicleMarker = _service.canvas.marker(
      pos, 28, 28, 'data:image/svg+xml;base64,' + btoa(svgTruck), 50
    ).change({ dx: -14, dy: -14 });
  }

  // ─────────────────────────────────────────────
  // Polling de excepciones via API cada 60s
  // ─────────────────────────────────────────────
  function _startExcPolling() {
    if (_excPollingTimer) return;
    _excPollingTimer = setInterval(() => {
      Object.values(_assignments).forEach(a => {
        if (a.status !== 'active' || !a.startTime) return;
        rmExceptionsHandler.fetchExceptionsForDevice(a.deviceId, a.startTime);
      });
    }, 60000);
  }

  // ─────────────────────────────────────────────
  // Persistencia
  // ─────────────────────────────────────────────
  function _persistAssignments() {
    // Solo guardar datos serializables (sin canvas refs)
    const serializable = Object.values(_assignments).map(a => ({
      assignmentId: a.assignmentId,
      deviceId: a.deviceId, deviceName: a.deviceName,
      routeName: a.routeName,
      waypoints: a.waypoints, routeCoords: a.routeCoords,
      threshold: a.threshold, status: a.status,
      startTime: a.startTime,
      visitedWaypoints: a.visitedWaypoints,
      deviationCount: a.deviationCount
    }));
    _service.localStorage.set('rm_active_assignments', JSON.stringify(serializable));
  }

  function _restoreFromStorage() {
    _service.localStorage.get('rm_active_assignments').then(data => {
      if (!data) return;
      try {
        const saved = JSON.parse(data);
        saved.forEach(a => {
          if (a.status === 'active' || a.status === 'paused') {
            _assignments[a.assignmentId] = {
              ...a,
              realPathSegments: [],
              vehicleMarker: null,
              lastPosition: null,
              deviating: false
            };
          }
        });
        rmUIPanel.renderAssignmentsList(Object.values(_assignments));
      } catch(e) { console.warn('[rmTracking] Error restaurando:', e); }
    }).catch(() => {});
  }

  return {
    init,
    assignRoute,
    startTracking,
    pauseTracking,
    removeAssignment,
    getAssignments: () => Object.values(_assignments),
    getAssignment:  id => _assignments[id]
  };
})();
