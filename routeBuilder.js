/**
 * routeBuilder.js
 * Construcción de rutas via clicks en el mapa nativo de MyGeotab.
 *
 * FIXES:
 *  - Click en geocerca: ahora usa attachMenu("map") + attachMenu("zone") para
 *    ignorar el tipo de entidad y capturar siempre la coordenada geografica.
 *  - Multi-ruta: soporta múltiples rutas guardadas por nombre.
 *  - Guardar/cargar rutas via service.localStorage con clave "rm_saved_routes".
 */
const rmRouteBuilder = (() => {

  let _service = null;
  let _waypoints = [];
  let _routeCoords = [];
  let _waypointMarkers = [];
  let _waypointLabels  = [];
  let _plannedRoutePath = null;
  let _deviationThreshold = 100;
  let _active = false;
  let _routeDistance = 0;
  let _routeDuration = 0;

  // ── Rutas guardadas: { id, name, waypoints, routeCoords, distance, duration, createdAt }
  let _savedRoutes = [];

  // ─────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────
  function init(service) {
    _service = service;
    _loadSavedRoutes();
    console.log('[rmRouteBuilder] Inicializado');
  }

  // ─────────────────────────────────────────────
  // Activar / desactivar captura de clicks
  // ─────────────────────────────────────────────
  function activate() {
    if (_active) return;
    _active = true;
    // Capturar clicks en mapa vacío Y en geocercas con la misma función
    // Ambos proveen location:{lat,lng} en sus datos de menú
    _service.actionList.attachMenu('map',  _handleMenuClick);
    _service.actionList.attachMenu('zone', _handleMenuClick);
    rmUIPanel.setHelpText('Modo edición activo — Haz clic en el mapa o sobre una geocerca para agregar un punto');
    console.log('[rmRouteBuilder] Captura de clicks ON');
  }

  function deactivate() {
    if (!_active) return;
    _active = false;
    _service.actionList.detachMenu('map',  _handleMenuClick);
    _service.actionList.detachMenu('zone', _handleMenuClick);
    console.log('[rmRouteBuilder] Captura de clicks OFF');
  }

  // ─────────────────────────────────────────────
  // Handler unificado de menú contextual
  // IMapMenuEventData  → { location:{lat,lng}, x, y }
  // IZoneMenuEventData → { location:{lat,lng}, zone:{id} }
  // ─────────────────────────────────────────────
  function _handleMenuClick(menuName, data) {
    if (!data || !data.location) return [];
    const coord = { lat: data.location.lat, lng: data.location.lng };
    _addWaypoint(coord);
    return []; // no mostrar menú contextual nativo
  }

  // ─────────────────────────────────────────────
  // Waypoints
  // ─────────────────────────────────────────────
  function _addWaypoint(coord) {
    const index = _waypoints.length;
    _waypoints.push(coord);

    // Color: verde = inicio, rojo = destino actual, azul = intermedio
    // El último siempre se pinta de rojo; si hay anterior que era rojo → azul
    if (index > 0) {
      // Repintar penúltimo marcador como azul (ya no es el último)
      const prev = _waypointMarkers[index - 1];
      if (prev) prev.change({ fill: '#2563EB', stroke: '#fff', 'stroke-width': 2 });
      const prevLabel = _waypointLabels[index - 1];
      if (prevLabel) prevLabel.change({ fill: '#1E3A5F' });
    }

    const color  = index === 0 ? '#16A34A' : '#DC2626';
    const radius = index === 0 ? 10 : 9;
    const label  = index === 0 ? 'A' : String(index);

    const marker = _service.canvas.circle(coord, radius, 30)
      .change({ fill: color, stroke: '#fff', 'stroke-width': 2 });
    _waypointMarkers.push(marker);

    const lbl = _service.canvas.text(
      { lat: coord.lat + 0.0018, lng: coord.lng }, label, 31
    ).change({ fill: '#1E3A5F', 'font-size': 11, 'font-weight': 700 });
    _waypointLabels.push(lbl);

    rmUIPanel.renderWaypointList(_waypoints);
    rmUIPanel.showClearButton(true);

    if (_waypoints.length >= 2) _calculateRoute();
  }

  function removeWaypoint(index) {
    _waypoints.splice(index, 1);
    _clearCanvas();
    _redrawMarkers();
    if (_waypoints.length >= 2) {
      _calculateRoute();
    } else {
      _routeCoords = [];
      rmUIPanel.renderWaypointList(_waypoints);
      rmUIPanel.updateRouteStats(null);
      if (_waypoints.length === 0) rmUIPanel.showClearButton(false);
    }
  }

  function _redrawMarkers() {
    _waypointMarkers = [];
    _waypointLabels  = [];
    _waypoints.forEach((coord, i) => {
      const isFirst = i === 0;
      const isLast  = i === _waypoints.length - 1;
      const color   = isFirst ? '#16A34A' : isLast ? '#DC2626' : '#2563EB';
      const radius  = isFirst || isLast ? 10 : 7;
      const label   = isFirst ? 'A' : isLast ? 'B' : String(i);
      const m = _service.canvas.circle(coord, radius, 30)
        .change({ fill: color, stroke: '#fff', 'stroke-width': 2 });
      _waypointMarkers.push(m);
      const lbl = _service.canvas.text(
        { lat: coord.lat + 0.0018, lng: coord.lng }, label, 31
      ).change({ fill: '#1E3A5F', 'font-size': 11, 'font-weight': 700 });
      _waypointLabels.push(lbl);
    });
    rmUIPanel.renderWaypointList(_waypoints);
  }

  // ─────────────────────────────────────────────
  // OSRM routing
  // ─────────────────────────────────────────────
  function _calculateRoute() {
    const coords = _waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    rmUIPanel.setHelpText('Calculando ruta...');

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data.code !== 'Ok' || !data.routes?.[0]) {
          rmUIPanel.setHelpText('Error calculando ruta — intenta con otros puntos.');
          return;
        }
        const route = data.routes[0];
        _routeCoords  = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        _routeDistance = route.distance;
        _routeDuration = route.duration;
        _drawPlannedRoute(_routeCoords);
        rmUIPanel.updateRouteStats({
          distance: (route.distance / 1000).toFixed(1) + ' km',
          duration: Math.round(route.duration / 60) + ' min'
        });
        rmUIPanel.setHelpText('Ruta calculada ✓ — Podés seguir agregando puntos, guardar la ruta o asignarla a un vehículo.');
      })
      .catch(() => rmUIPanel.setHelpText('Error de red al calcular ruta.'));
  }

  // ─────────────────────────────────────────────
  // Canvas
  // ─────────────────────────────────────────────
  function _drawPlannedRoute(coords) {
    if (_plannedRoutePath) { try { _plannedRoutePath.remove(); } catch(e) {} _plannedRoutePath = null; }
    if (coords.length < 2) return;
    const segs = [
      { type: 'M', points: [coords[0]] },
      ...coords.slice(1).map(c => ({ type: 'L', points: [c] }))
    ];
    _plannedRoutePath = _service.canvas.path(segs, 10)
      .change({ stroke: '#2563EB', 'stroke-width': 4, fill: 'none' });
  }

  function _clearCanvas() {
    _waypointMarkers.forEach(m => { try { m.remove(); } catch(e) {} });
    _waypointLabels.forEach(l  => { try { l.remove(); } catch(e) {} });
    _waypointMarkers = []; _waypointLabels = [];
    if (_plannedRoutePath) { try { _plannedRoutePath.remove(); } catch(e) {} _plannedRoutePath = null; }
  }

  // ─────────────────────────────────────────────
  // Guardar / cargar / eliminar rutas persistentes
  // ─────────────────────────────────────────────
  function saveCurrentRoute(name) {
    if (!name || !name.trim()) return false;
    if (_waypoints.length < 2 || _routeCoords.length < 2) return false;

    const route = {
      id: 'route_' + Date.now(),
      name: name.trim(),
      waypoints: [..._waypoints],
      routeCoords: [..._routeCoords],
      distance: _routeDistance,
      duration: _routeDuration,
      threshold: _deviationThreshold,
      createdAt: new Date().toISOString()
    };
    _savedRoutes.push(route);
    _persistSavedRoutes();
    rmUIPanel.renderSavedRoutesList(_savedRoutes);
    return route;
  }

  function loadRoute(routeId) {
    const route = _savedRoutes.find(r => r.id === routeId);
    if (!route) return;
    clearRoute();
    _waypoints    = [...route.waypoints];
    _routeCoords  = [...route.routeCoords];
    _routeDistance = route.distance;
    _routeDuration = route.duration;
    _deviationThreshold = route.threshold || 100;
    _redrawMarkers();
    _drawPlannedRoute(_routeCoords);
    rmUIPanel.updateRouteStats({
      distance: (route.distance / 1000).toFixed(1) + ' km',
      duration: Math.round(route.duration / 60) + ' min'
    });
    rmUIPanel.showClearButton(true);
    rmUIPanel.setHelpText(`Ruta "${route.name}" cargada ✓`);
    return route;
  }

  function deleteRoute(routeId) {
    _savedRoutes = _savedRoutes.filter(r => r.id !== routeId);
    _persistSavedRoutes();
    rmUIPanel.renderSavedRoutesList(_savedRoutes);
  }

  function _persistSavedRoutes() {
    _service.localStorage.set('rm_saved_routes', JSON.stringify(_savedRoutes));
  }

  function _loadSavedRoutes() {
    _service.localStorage.get('rm_saved_routes').then(data => {
      if (data) {
        try { _savedRoutes = JSON.parse(data); }
        catch(e) { _savedRoutes = []; }
      }
      rmUIPanel.renderSavedRoutesList(_savedRoutes);
    }).catch(() => { _savedRoutes = []; });
  }

  // ─────────────────────────────────────────────
  // Limpiar ruta actual (no borra las guardadas)
  // ─────────────────────────────────────────────
  function clearRoute() {
    _waypoints = []; _routeCoords = [];
    _routeDistance = 0; _routeDuration = 0;
    _service.canvas.clear();
    _waypointMarkers = []; _waypointLabels = []; _plannedRoutePath = null;
    rmUIPanel.renderWaypointList([]);
    rmUIPanel.updateRouteStats(null);
    rmUIPanel.showClearButton(false);
    rmUIPanel.setHelpText('Haz clic en el mapa para definir puntos de ruta.');
  }

  return {
    init, activate, deactivate,
    clearRoute, removeWaypoint,
    saveCurrentRoute, loadRoute, deleteRoute,
    hasRoute:               () => _waypoints.length >= 2 && _routeCoords.length >= 2,
    getWaypoints:           () => [..._waypoints],
    getRouteCoords:         () => [..._routeCoords],
    getRouteDistance:       () => _routeDistance,
    getRouteDuration:       () => _routeDuration,
    getSavedRoutes:         () => [..._savedRoutes],
    setDeviationThreshold:  v  => { _deviationThreshold = v; },
    getDeviationThreshold:  () => _deviationThreshold
  };
})();
