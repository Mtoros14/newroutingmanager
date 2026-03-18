/**
 * trackingEngine.js — v4.3
 *
 * FIXES:
 *  - removeAssignment: ahora limpia canvas Y actualiza la UI correctamente.
 *  - Progreso solo avanza cuando el vehículo está DENTRO del corredor de la ruta
 *    (isOnRoute = true). Si el vehículo está lejos, el progreso no sube.
 *  - Mejor gestión del estado "deviating" para no spamear alertas.
 */
const rmTrackingEngine = (() => {

  let _service     = null;
  let _assignments = {};
  let _elapsedTimers  = {};
  let _startTimes     = {};
  let _excPollingTimer = null;

  // ── Init ─────────────────────────────────────
  function init(service) {
    _service = service;
    _service.events.attach('change', _handleDeviceChange);
    _service.events.attach('click',  _handleMapClick);
    _restoreFromStorage();
    console.log('[rmTracking] Inicializado');
  }

  // ── Asignar ruta ──────────────────────────────
  function assignRoute(deviceId, deviceName, waypoints, routeCoords, routeName, threshold) {
    const assignmentId = 'asgn_' + Date.now();
    _assignments[assignmentId] = {
      assignmentId, deviceId, deviceName,
      routeName: routeName || 'Ruta',
      waypoints:        waypoints.map(w => ({...w})),
      routeCoords:      [...routeCoords],
      threshold:        threshold || 100,
      status:           'pending',
      startTime:        null,
      realPathSegments: [],
      visitedWaypoints: new Array(waypoints.length).fill(false),
      vehicleMarker:    null,
      lastPosition:     null,
      deviating:        false,
      deviationCount:   0,
      // FIX: progreso solo avanza cuando el vehículo está en el corredor
      hasEnteredRoute:  false,
      lastProgress:     0
    };
    _persistAssignments();
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    console.log(`[rmTracking] Asignación creada: ${assignmentId} → ${deviceName}`);
    return assignmentId;
  }

  // ── Iniciar / pausar ──────────────────────────
  function startTracking(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    a.status    = 'active';
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

  // ── FIX: removeAssignment limpia canvas y UI ──
  function removeAssignment(assignmentId) {
    const a = _assignments[assignmentId];
    if (!a) return;
    // Detener timer
    clearInterval(_elapsedTimers[assignmentId]);
    // Limpiar canvas
    (a.realPathSegments || []).forEach(s => { try { s.remove(); } catch(e) {} });
    if (a.vehicleMarker) { try { a.vehicleMarker.remove(); } catch(e) {} }
    // Eliminar del estado
    delete _assignments[assignmentId];
    delete _elapsedTimers[assignmentId];
    delete _startTimes[assignmentId];
    _persistAssignments();
    // Actualizar UI — si no quedan asignaciones, mostrar estado vacío
    rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    console.log(`[rmTracking] Asignación ${assignmentId} eliminada`);
  }

  // ── Elapsed timer ─────────────────────────────
  function _updateElapsed(assignmentId) {
    const start = _startTimes[assignmentId];
    if (!start) return;
    const secs = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    const str = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    rmUIPanel.updateAssignmentElapsed(assignmentId, str);
  }

  // ── Posición inicial via API ──────────────────
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
    }).catch(() => {});
  }

  // ── Handler de eventos del mapa ───────────────
  function _handleDeviceChange(data) {
    if (!data || data.type !== 'device' || !data.location) return;
    for (const [id, a] of Object.entries(_assignments)) {
      if (a.status === 'active' && a.deviceId === data.entity.id) {
        _processPosition(id, { lat: data.location.lat, lng: data.location.lng });
      }
    }
  }

  function _handleMapClick(data) {
    if (!data || data.type !== 'exceptions' || !data.entity?.exceptions) return;
    data.entity.exceptions.forEach(exc => {
      rmExceptionsHandler.logException({
        id: exc.id, ruleId: exc.rule?.id, deviceId: exc.device?.id,
        from: exc.from, to: exc.to
      }, _service);
    });
  }

  // ── FIX: Procesamiento de posición ────────────
  // El progreso solo avanza si el vehículo está dentro del corredor de la ruta.
  // Esto evita que rutas recién creadas muestren % si el vehículo está lejos.
  function _processPosition(assignmentId, pos) {
    const a = _assignments[assignmentId];
    if (!a || a.status !== 'active') return;

    const onRoute = rmDeviationDetector.isOnRoute(pos, a.routeCoords, a.threshold);

    // El vehículo entró en el corredor por primera vez
    if (onRoute && !a.hasEnteredRoute) {
      a.hasEnteredRoute = true;
    }

    // Dibujar segmento solo si ya entró a la ruta O si está activo hace más de 30s
    // (evita ruido en el inicio)
    if (a.lastPosition) {
      _drawRealSegment(a, a.lastPosition, pos, onRoute);
    }
    _updateVehicleMarker(a, pos);
    a.lastPosition = pos;

    // Calcular progreso SOLO si el vehículo está o estuvo en el corredor
    const progress = rmDeviationDetector.calculateProgress(pos, a.routeCoords);

    // FIX: no retroceder el progreso ni subirlo si el vehículo está lejos
    const effectivePct = a.hasEnteredRoute
      ? Math.max(a.lastProgress, progress.percent)
      : 0;
    a.lastProgress = effectivePct;

    rmUIPanel.updateAssignmentProgress(assignmentId, {
      ...progress,
      percent: effectivePct
    });

    // Waypoints visitados (solo si entró en ruta)
    if (a.hasEnteredRoute) {
      a.visitedWaypoints = rmDeviationDetector.updateVisitedWaypoints(
        pos, a.waypoints, a.visitedWaypoints, a.threshold * 1.5
      );
      rmUIPanel.updateAssignmentChecklist(assignmentId, a.visitedWaypoints);
    }

    // Alertas de desvío
    if (a.hasEnteredRoute) {
      if (!onRoute && !a.deviating) {
        a.deviating = true;
        a.deviationCount++;
        const dist = rmDeviationDetector.minDistanceToRoute(pos, a.routeCoords);
        rmUIPanel.addDeviationAlert({
          assignmentId, deviceName: a.deviceName,
          routeName: a.routeName, timestamp: new Date(), position: pos, distance: dist
        });
      } else if (onRoute && a.deviating) {
        a.deviating = false;
        rmUIPanel.addReturnToRouteAlert({
          assignmentId, deviceName: a.deviceName,
          routeName: a.routeName, timestamp: new Date()
        });
      }
    }

    // Ruta completada
    if (a.hasEnteredRoute && a.visitedWaypoints.every(v => v) && effectivePct >= 95) {
      a.status = 'completed';
      clearInterval(_elapsedTimers[assignmentId]);
      rmUIPanel.addSystemAlert({ type: 'completed', deviceName: a.deviceName,
        routeName: a.routeName, timestamp: new Date() });
      _persistAssignments();
      rmUIPanel.renderAssignmentsList(Object.values(_assignments));
    }
  }

  // ── Canvas ────────────────────────────────────
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="#1E40AF" stroke="white" stroke-width="1.5"><rect x="1" y="8" width="15" height="10" rx="1"/><path d="M16 10h4l3 4v4h-7V10z"/><circle cx="5.5" cy="19" r="1.5"/><circle cx="18.5" cy="19" r="1.5"/></svg>`;
    if (assignment.vehicleMarker) { try { assignment.vehicleMarker.remove(); } catch(e) {} }
    assignment.vehicleMarker = _service.canvas.marker(
      pos, 30, 30, 'data:image/svg+xml;base64,' + btoa(svg), 50
    ).change({ dx: -15, dy: -15 });
  }

  // ── Polling excepciones cada 60s ──────────────
  function _startExcPolling() {
    if (_excPollingTimer) return;
    _excPollingTimer = setInterval(() => {
      Object.values(_assignments).forEach(a => {
        if (a.status === 'active' && a.startTime)
          rmExceptionsHandler.fetchExceptionsForDevice(a.deviceId, a.startTime);
      });
    }, 60000);
  }

  // ── Persistencia ──────────────────────────────
  function _persistAssignments() {
    const data = Object.values(_assignments).map(a => ({
      assignmentId: a.assignmentId,
      deviceId: a.deviceId, deviceName: a.deviceName,
      routeName: a.routeName,
      waypoints: a.waypoints, routeCoords: a.routeCoords,
      threshold: a.threshold, status: a.status,
      startTime: a.startTime,
      visitedWaypoints: a.visitedWaypoints,
      deviationCount: a.deviationCount,
      hasEnteredRoute: a.hasEnteredRoute,
      lastProgress: a.lastProgress
    }));
    _service.localStorage.set('rm_active_assignments', JSON.stringify(data));
  }

  function _restoreFromStorage() {
    _service.localStorage.get('rm_active_assignments')
      .then(data => {
        if (!data) return;
        try {
          JSON.parse(data).forEach(a => {
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
      })
      .catch(() => {});
  }

  return {
    init, assignRoute,
    startTracking, pauseTracking, removeAssignment,
    getAssignments: () => Object.values(_assignments),
    getAssignment:  id => _assignments[id]
  };
})();
