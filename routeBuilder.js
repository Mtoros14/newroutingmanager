/**
 * routeBuilder.js — v4.3
 *
 * FIXES:
 *  - Click en geocercas: attachMenu("map") + attachMenu("zone") unifcado.
 *  - GetAddresses: al agregar un waypoint llama a la API para obtener
 *    nombre de geocerca o dirección y lo muestra en la lista.
 *  - Guardar / cargar / eliminar rutas persistentes.
 */
const rmRouteBuilder = (() => {

  let _service        = null;
  let _waypoints      = [];       // { lat, lng, label }
  let _routeCoords    = [];
  let _waypointMarkers = [];
  let _waypointLabels  = [];
  let _plannedRoutePath = null;
  let _deviationThreshold = 100;
  let _active         = false;
  let _routeDistance  = 0;
  let _routeDuration  = 0;
  let _savedRoutes    = [];

  // ── Init ─────────────────────────────────────
  function init(service) {
    _service = service;
    _loadSavedRoutes();
    console.log('[rmRouteBuilder] Inicializado');
  }

  // ── Activar / desactivar clicks en mapa ──────
  function activate() {
    if (_active) return;
    _active = true;
    _service.actionList.attachMenu('map',  _handleMenuClick);
    _service.actionList.attachMenu('zone', _handleMenuClick);
    rmUIPanel.setHelpText('✏️ Modo edición activo — Haz clic en el mapa o sobre una geocerca para agregar puntos');
    console.log('[rmRouteBuilder] Captura de clicks ON');
  }

  function deactivate() {
    if (!_active) return;
    _active = false;
    _service.actionList.detachMenu('map',  _handleMenuClick);
    _service.actionList.detachMenu('zone', _handleMenuClick);
    console.log('[rmRouteBuilder] Captura de clicks OFF');
  }

  // ── Handler unificado mapa/geocerca ──────────
  function _handleMenuClick(menuName, data) {
    if (!data || !data.location) return [];
    const coord = { lat: data.location.lat, lng: data.location.lng };
    _addWaypoint(coord);
    return [];
  }

  // ── Agregar waypoint ─────────────────────────
  function _addWaypoint(coord) {
    const index = _waypoints.length;
    const wp    = { lat: coord.lat, lng: coord.lng, label: _formatCoords(coord) };
    _waypoints.push(wp);

    // Marcador provisional mientras resuelve el nombre
    _drawMarker(coord, index);

    // Actualizar UI con coordenadas provisionales
    rmUIPanel.renderWaypointList(_waypoints);
    rmUIPanel.showClearButton(true);

    // ── Resolver nombre via GetAddresses ────────
    _service.api.call('GetAddresses', {
      coordinates: [{ x: coord.lng, y: coord.lat }],
      movingAddresses: false
    })
    .then(results => {
      if (!results || !results[0]) return;
      const addr = results[0];

      // Preferir nombre de geocerca si el punto cae dentro de una
      let label = '';
      if (addr.zones && addr.zones.length > 0) {
        // zones[] es array de objetos { id }; resolver nombres
        const zoneIds = addr.zones.map(z => z.id);
        _resolveZoneNames(zoneIds).then(names => {
          wp.label     = names.join(', ');
          wp.isZone    = true;
          wp.zoneNames = names;
          rmUIPanel.renderWaypointList(_waypoints);
        });
        return; // esperar resolución async de nombres
      }

      // Dirección de calle
      if (addr.streetAddress) label = addr.streetAddress;
      else if (addr.formattedAddress) label = addr.formattedAddress;
      else label = _formatCoords(coord);

      wp.label = label;
      rmUIPanel.renderWaypointList(_waypoints);
    })
    .catch(() => {
      // Mantener coordenadas si falla
    });

    if (_waypoints.length >= 2) _calculateRoute();
  }

  // Resolver nombres de zonas a partir de IDs
  function _resolveZoneNames(ids) {
    const calls = ids.map(id => ['Get', { typeName: 'Zone', search: { id } }]);
    return _service.api.multiCall(calls)
      .then(results => results.map((r, i) => r?.[0]?.name || `Zona ${ids[i]}`))
      .catch(() => ids.map(id => `Zona ${id}`));
  }

  function _formatCoords(c) {
    return `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  }

  // ── Dibujo de marcadores ─────────────────────
  function _drawMarker(coord, index) {
    // Repintar penúltimo como azul (ya no es el último)
    if (index > 0 && _waypointMarkers[index - 1]) {
      _waypointMarkers[index - 1].change({ fill: '#2563EB', stroke: '#fff', 'stroke-width': 2 });
    }
    const color  = index === 0 ? '#16A34A' : '#DC2626';
    const radius = 9;
    const lbl    = index === 0 ? 'A' : String(index);

    const m = _service.canvas.circle(coord, radius, 30)
      .change({ fill: color, stroke: '#fff', 'stroke-width': 2 });
    _waypointMarkers.push(m);

    const t = _service.canvas.text(
      { lat: coord.lat + 0.0018, lng: coord.lng }, lbl, 31
    ).change({ fill: '#fff', 'font-size': 11, 'font-weight': 700 });
    _waypointLabels.push(t);
  }

  function _redrawMarkers() {
    _waypointMarkers = []; _waypointLabels = [];
    _waypoints.forEach((wp, i) => {
      const isFirst = i === 0, isLast = i === _waypoints.length - 1;
      const color = isFirst ? '#16A34A' : isLast ? '#DC2626' : '#2563EB';
      const lbl   = isFirst ? 'A' : isLast ? 'B' : String(i);
      const m = _service.canvas.circle({ lat: wp.lat, lng: wp.lng }, 9, 30)
        .change({ fill: color, stroke: '#fff', 'stroke-width': 2 });
      _waypointMarkers.push(m);
      const t = _service.canvas.text(
        { lat: wp.lat + 0.0018, lng: wp.lng }, lbl, 31
      ).change({ fill: '#fff', 'font-size': 11, 'font-weight': 700 });
      _waypointLabels.push(t);
    });
  }

  function removeWaypoint(index) {
    _waypoints.splice(index, 1);
    _clearCanvas();
    _redrawMarkers();
    if (_waypoints.length >= 2) _calculateRoute();
    else {
      _routeCoords = [];
      rmUIPanel.renderWaypointList(_waypoints);
      rmUIPanel.updateRouteStats(null);
      if (_waypoints.length === 0) rmUIPanel.showClearButton(false);
    }
  }

  // ── OSRM ─────────────────────────────────────
  function _calculateRoute() {
    const coords = _waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    rmUIPanel.setHelpText('⏳ Calculando ruta...');
    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data.code !== 'Ok' || !data.routes?.[0]) {
          rmUIPanel.setHelpText('❌ Error al calcular ruta — intenta con otros puntos.');
          return;
        }
        const route = data.routes[0];
        _routeCoords   = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        _routeDistance = route.distance;
        _routeDuration = route.duration;
        _drawPlannedRoute(_routeCoords);
        rmUIPanel.updateRouteStats({
          distance: (route.distance / 1000).toFixed(1) + ' km',
          duration: Math.round(route.duration / 60) + ' min'
        });
        rmUIPanel.setHelpText('✅ Ruta calculada — podés agregar más puntos, guardarla o asignarla.');
      })
      .catch(() => rmUIPanel.setHelpText('❌ Error de red al calcular ruta.'));
  }

  // ── Canvas ────────────────────────────────────
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

  // ── Guardar / cargar / eliminar rutas ─────────
  function saveCurrentRoute(name) {
    if (!name?.trim() || _waypoints.length < 2 || _routeCoords.length < 2) return false;
    const route = {
      id: 'route_' + Date.now(),
      name: name.trim(),
      waypoints:   [..._waypoints],
      routeCoords: [..._routeCoords],
      distance:    _routeDistance,
      duration:    _routeDuration,
      threshold:   _deviationThreshold,
      createdAt:   new Date().toISOString()
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
    _waypoints          = route.waypoints.map(w => ({...w}));
    _routeCoords        = [...route.routeCoords];
    _routeDistance      = route.distance;
    _routeDuration      = route.duration;
    _deviationThreshold = route.threshold || 100;
    _redrawMarkers();
    _drawPlannedRoute(_routeCoords);
    rmUIPanel.renderWaypointList(_waypoints);
    rmUIPanel.updateRouteStats({
      distance: (route.distance / 1000).toFixed(1) + ' km',
      duration: Math.round(route.duration / 60) + ' min'
    });
    rmUIPanel.showClearButton(true);
    rmUIPanel.setHelpText(`📂 Ruta "${route.name}" cargada en el mapa`);
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
    _service.localStorage.get('rm_saved_routes')
      .then(data => {
        try { _savedRoutes = data ? JSON.parse(data) : []; }
        catch(e) { _savedRoutes = []; }
        rmUIPanel.renderSavedRoutesList(_savedRoutes);
      })
      .catch(() => { _savedRoutes = []; });
  }

  function clearRoute() {
    _waypoints = []; _routeCoords = [];
    _routeDistance = 0; _routeDuration = 0;
    _service.canvas.clear();
    _waypointMarkers = []; _waypointLabels = []; _plannedRoutePath = null;
    rmUIPanel.renderWaypointList([]);
    rmUIPanel.updateRouteStats(null);
    rmUIPanel.showClearButton(false);
    rmUIPanel.setHelpText('Haz clic en el mapa para definir los puntos de la ruta.');
  }

  return {
    init, activate, deactivate,
    clearRoute, removeWaypoint,
    saveCurrentRoute, loadRoute, deleteRoute,
    hasRoute:              () => _waypoints.length >= 2 && _routeCoords.length >= 2,
    getWaypoints:          () => _waypoints.map(w => ({...w})),
    getRouteCoords:        () => [..._routeCoords],
    getRouteDistance:      () => _routeDistance,
    getRouteDuration:      () => _routeDuration,
    getSavedRoutes:        () => [..._savedRoutes],
    setDeviationThreshold: v  => { _deviationThreshold = v; },
    getDeviationThreshold: () => _deviationThreshold
  };
})();
