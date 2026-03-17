/**
 * trackingEngine.js
 * Motor de seguimiento en tiempo real.
 * Usa service.events.attach("change") para recibir posiciones del vehículo asignado.
 * Dibuja el recorrido real en verde (en ruta) o rojo (desvío) sobre el mapa nativo.
 */

const rmTrackingEngine = (() => {

  let _service = null;
  let _assignedDeviceId = null;
  let _plannedRoute = [];        // coords de la ruta planificada
  let _waypoints = [];           // waypoints originales del usuario
  let _isTracking = false;
  let _startTime = null;
  let _elapsedInterval = null;

  // Estado del recorrido real
  let _realPathPoints = [];      // historial de posiciones
  let _realPathSegments = [];    // referencias a canvas elements (segmentos verde/rojo)
  let _lastPosition = null;
  let _visitedWaypoints = [];    // array de booleanos

  // Marcador de posición actual del vehículo
  let _vehicleMarker = null;

  // ─────────────────────────────────────────────
  // Inicialización
  // ─────────────────────────────────────────────

  function init(service) {
    _service = service;
    // Escuchar cambios de posición de vehículos en el mapa
    _service.events.attach('change', _handleDeviceChange);
    // Escuchar clicks en excepciones en el mapa
    _service.events.attach('click', _handleMapClick);
    console.log('[rmTracking] Inicializado, escuchando eventos del mapa');
  }

  // ─────────────────────────────────────────────
  // Asignación de ruta
  // ─────────────────────────────────────────────

  function assignRoute(deviceId, waypoints, routeCoords) {
    _assignedDeviceId = deviceId;
    _waypoints = waypoints;
    _plannedRoute = routeCoords;
    _visitedWaypoints = new Array(waypoints.length).fill(false);

    // Persistir en localStorage
    _service.localStorage.set('rm_active_route', JSON.stringify({
      deviceId,
      waypoints,
      routeCoords,
      startTime: new Date().toISOString()
    }));

    rmUIPanel.showProgressPanel({
      waypoints,
      distanceTotal: rmRouteBuilder.getRouteDistance(),
      durationEst: rmRouteBuilder.getRouteDuration()
    });

    console.log(`[rmTracking] Ruta asignada al vehículo ${deviceId}`);
  }

  // ─────────────────────────────────────────────
  // Iniciar / pausar seguimiento
  // ─────────────────────────────────────────────

  function startTracking() {
    if (!_assignedDeviceId) {
      alert('Primero asigná una ruta a un vehículo.');
      return;
    }
    _isTracking = true;
    _startTime = _startTime || new Date();
    _elapsedInterval = setInterval(_updateElapsed, 1000);
    rmUIPanel.setTrackingState(true);

    // Obtener posición actual inmediatamente via API
    _fetchCurrentPosition();
    console.log('[rmTracking] Seguimiento iniciado');
  }

  function stopTracking() {
    _isTracking = false;
    clearInterval(_elapsedInterval);
    _elapsedInterval = null;
    rmUIPanel.setTrackingState(false);
    console.log('[rmTracking] Seguimiento pausado');
  }

  function _updateElapsed() {
    if (!_startTime) return;
    const elapsed = Math.floor((new Date() - _startTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const str = h > 0
      ? `${h}h ${m}m`
      : m > 0 ? `${m}m ${s}s` : `${s}s`;
    rmUIPanel.updateElapsed(str);
  }

  // ─────────────────────────────────────────────
  // Obtener posición actual via API (para inicio)
  // ─────────────────────────────────────────────

  function _fetchCurrentPosition() {
    if (!_assignedDeviceId) return;
    _service.api.call('Get', {
      typeName: 'DeviceStatusInfo',
      search: { deviceSearch: { id: _assignedDeviceId } }
    }).then(results => {
      if (results && results[0] && results[0].currentStateDuration !== undefined) {
        const info = results[0];
        if (info.latitude && info.longitude) {
          const pos = { lat: info.latitude, lng: info.longitude };
          _processNewPosition(pos);
        }
      }
    }).catch(err => console.error('[rmTracking] Error obteniendo posición inicial:', err));
  }

  // ─────────────────────────────────────────────
  // Handler de eventos del mapa
  // ─────────────────────────────────────────────

  /**
   * IDeviceChangeEvent: { type: "device", entity: { id }, visible, location: { lat, lng } }
   * Se dispara automáticamente cuando un vehículo se mueve en el mapa.
   */
  function _handleDeviceChange(data) {
    if (!_isTracking) return;
    if (!data || data.type !== 'device') return;
    if (data.entity.id !== _assignedDeviceId) return;
    if (!data.location) return;

    const pos = { lat: data.location.lat, lng: data.location.lng };
    _processNewPosition(pos);
  }

  /**
   * Interceptar clicks en íconos de excepción en el mapa.
   * IExceptionsEvent: { type: "exceptions", entity: { exceptions: [...] } }
   */
  function _handleMapClick(data) {
    if (!data || data.type !== 'exceptions') return;
    if (!data.entity || !data.entity.exceptions) return;

    data.entity.exceptions.forEach(exc => {
      rmExceptionsHandler.logException({
        id: exc.id,
        ruleId: exc.rule ? exc.rule.id : null,
        deviceId: exc.device ? exc.device.id : null,
        from: exc.from,
        to: exc.to
      }, _service);
    });
  }

  // ─────────────────────────────────────────────
  // Procesamiento de nueva posición
  // ─────────────────────────────────────────────

  function _processNewPosition(pos) {
    const threshold = rmRouteBuilder.getDeviationThreshold();

    // Verificar si está en ruta
    const onRoute = rmDeviationDetector.isOnRoute(pos, _plannedRoute, threshold);

    // Dibujar segmento del recorrido real
    if (_lastPosition) {
      _drawRealSegment(_lastPosition, pos, onRoute);
    }

    // Actualizar marcador del vehículo
    _updateVehicleMarker(pos);

    _lastPosition = pos;
    _realPathPoints.push({ ...pos, onRoute, timestamp: new Date().toISOString() });

    // Calcular progreso
    const progress = rmDeviationDetector.calculateProgress(pos, _plannedRoute);
    rmUIPanel.updateProgress(progress);

    // Actualizar waypoints visitados
    _visitedWaypoints = rmDeviationDetector.updateVisitedWaypoints(
      pos, _waypoints, _visitedWaypoints, threshold * 1.5
    );
    rmUIPanel.updateWaypointChecklist(_visitedWaypoints);

    // Generar alerta si hay desvío
    if (!onRoute) {
      rmUIPanel.addDeviationAlert({
        timestamp: new Date(),
        position: pos,
        distance: _getMinDistanceToRoute(pos)
      });
    }

    // Capturar excepciones activas
    _fetchActiveExceptions(pos);
  }

  function _getMinDistanceToRoute(pos) {
    let minDist = Infinity;
    for (let i = 0; i < _plannedRoute.length - 1; i++) {
      const d = rmDeviationDetector.pointToSegmentDistance(pos, _plannedRoute[i], _plannedRoute[i + 1]);
      if (d < minDist) minDist = d;
    }
    return minDist === Infinity ? 0 : Math.round(minDist);
  }

  // ─────────────────────────────────────────────
  // Dibujo en el mapa
  // ─────────────────────────────────────────────

  function _drawRealSegment(from, to, onRoute) {
    const color = onRoute ? '#16A34A' : '#DC2626'; // verde / rojo

    const seg = _service.canvas.path([
      { type: 'M', points: [from] },
      { type: 'L', points: [to] }
    ], 20) // zIndex 20 > ruta planificada (10)
    .change({
      stroke: color,
      'stroke-width': 5,
      fill: 'none',
      'fill-opacity': 0
    });

    _realPathSegments.push(seg);
  }

  function _updateVehicleMarker(pos) {
    // SVG de camión como marcador
    const truckSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="#1E40AF" stroke="white" stroke-width="1.5"><rect x="1" y="8" width="15" height="10" rx="1"/><path d="M16 10h4l3 4v4h-7V10z"/><circle cx="5.5" cy="19" r="1.5"/><circle cx="18.5" cy="19" r="1.5"/></svg>`;
    const encodedSvg = 'data:image/svg+xml;base64,' + btoa(truckSvg);

    if (_vehicleMarker) {
      try { _vehicleMarker.remove(); } catch(e) {}
    }

    _vehicleMarker = _service.canvas.marker(
      pos, 28, 28, encodedSvg, 50
    ).change({ dx: -14, dy: -14 }); // centrar el marcador
  }

  // ─────────────────────────────────────────────
  // Captura de excepciones activas en la ruta
  // ─────────────────────────────────────────────

  function _fetchActiveExceptions(pos) {
    if (!_assignedDeviceId || !_isTracking) return;
    // Solo consultar cada 30 segundos para no saturar la API
    const now = Date.now();
    if (rmTrackingEngine._lastExcFetch && now - rmTrackingEngine._lastExcFetch < 30000) return;
    rmTrackingEngine._lastExcFetch = now;

    const fromDate = _startTime ? _startTime.toISOString() : new Date(Date.now() - 3600000).toISOString();

    _service.api.call('Get', {
      typeName: 'ExceptionEvent',
      search: {
        deviceSearch: { id: _assignedDeviceId },
        fromDate: fromDate,
        includeInvalidated: false
      }
    }).then(exceptions => {
      if (!exceptions || exceptions.length === 0) return;
      exceptions.forEach(exc => {
        rmExceptionsHandler.logException({
          id: exc.id,
          ruleId: exc.rule ? exc.rule.id : null,
          deviceId: exc.device ? exc.device.id : null,
          from: exc.activeFrom,
          to: exc.activeTo,
          distance: exc.distance
        }, _service);
      });
    }).catch(err => console.warn('[rmTracking] Error consultando excepciones:', err));
  }

  // ─────────────────────────────────────────────
  // Limpiar tracking
  // ─────────────────────────────────────────────

  function clearTracking() {
    stopTracking();
    _assignedDeviceId = null;
    _plannedRoute = [];
    _waypoints = [];
    _realPathPoints = [];
    _realPathSegments.forEach(s => { try { s.remove(); } catch(e) {} });
    _realPathSegments = [];
    if (_vehicleMarker) { try { _vehicleMarker.remove(); } catch(e) {} _vehicleMarker = null; }
    _lastPosition = null;
    _startTime = null;
    _visitedWaypoints = [];
    _service.localStorage.remove('rm_active_route');
    console.log('[rmTracking] Tracking limpiado');
  }

  // ─────────────────────────────────────────────
  // Restaurar estado desde localStorage
  // ─────────────────────────────────────────────

  function restoreFromStorage() {
    _service.localStorage.get('rm_active_route').then(data => {
      if (!data) return;
      try {
        const saved = JSON.parse(data);
        if (saved.deviceId && saved.waypoints && saved.routeCoords) {
          console.log('[rmTracking] Restaurando ruta guardada para device:', saved.deviceId);
          assignRoute(saved.deviceId, saved.waypoints, saved.routeCoords);
        }
      } catch(e) {
        console.warn('[rmTracking] Error restaurando estado:', e);
      }
    }).catch(() => {});
  }

  return {
    init,
    assignRoute,
    startTracking,
    stopTracking,
    clearTracking,
    restoreFromStorage,
    isTracking: () => _isTracking,
    getAssignedDeviceId: () => _assignedDeviceId
  };

})();
