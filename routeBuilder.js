/**
 * routeBuilder.js
 * Gestiona la construcción de rutas mediante clicks en el mapa nativo de MyGeotab.
 * Usa service.canvas para dibujar y service.actionList para capturar clicks.
 */

const rmRouteBuilder = (() => {

  let _service = null;
  let _waypoints = [];           // { lat, lng } puntos colocados por el usuario
  let _routeCoords = [];         // coordenadas completas de la ruta calculada (OSRM)
  let _waypointMarkers = [];     // referencias a service.canvas elements (círculos)
  let _plannedRoutePath = null;  // referencia al path de la ruta planificada
  let _deviationThreshold = 100; // metros
  let _active = false;
  let _routeDistance = 0;        // metros
  let _routeDuration = 0;        // segundos

  // ─────────────────────────────────────────────
  // Inicialización
  // ─────────────────────────────────────────────

  function init(service) {
    _service = service;
    console.log('[rmRouteBuilder] Inicializado');
  }

  /**
   * Activa la captura de clicks en el mapa para agregar waypoints.
   * Se llama cuando el usuario hace foco en el panel del add-in.
   */
  function activate() {
    if (_active) return;
    _active = true;
    _service.actionList.attachMenu('map', _handleMapClick);
    console.log('[rmRouteBuilder] Modo captura de clicks activado');
    rmUIPanel.setHelpText('Haz clic en el mapa para agregar puntos de ruta');
  }

  /**
   * Desactiva la captura de clicks.
   */
  function deactivate() {
    if (!_active) return;
    _active = false;
    _service.actionList.detachMenu('map', _handleMapClick);
    console.log('[rmRouteBuilder] Modo captura de clicks desactivado');
  }

  // ─────────────────────────────────────────────
  // Handler de click en el mapa
  // ─────────────────────────────────────────────

  /**
   * Intercepta el menú contextual del mapa.
   * IMapMenuEventData: { x, y, menuName, location: { lat, lng } }
   * Retornar [] evita que se muestre el menú contextual nativo.
   */
  function _handleMapClick(menuName, data) {
    if (!data || !data.location) return [];
    const coord = { lat: data.location.lat, lng: data.location.lng };
    _addWaypoint(coord);
    return []; // suprimir menú contextual
  }

  // ─────────────────────────────────────────────
  // Manejo de waypoints
  // ─────────────────────────────────────────────

  function _addWaypoint(coord) {
    const index = _waypoints.length;
    _waypoints.push(coord);

    // Determinar tipo y color del marcador
    let color, radius;
    if (index === 0) {
      color = '#16A34A'; radius = 10; // inicio: verde
    } else {
      color = '#2563EB'; radius = 7;  // waypoint: azul
    }

    // Dibujar marcador en el mapa nativo
    const marker = _service.canvas.circle(coord, radius, 30)
      .change({ fill: color, stroke: '#FFFFFF', 'stroke-width': 2 });
    _waypointMarkers.push(marker);

    // Etiquetar con número
    _service.canvas.text(
      { lat: coord.lat + 0.002, lng: coord.lng },
      index === 0 ? 'A' : String(index),
      31
    ).change({ fill: '#1E3A5F', 'font-size': 11, 'font-weight': 700 });

    // Actualizar UI
    rmUIPanel.renderWaypointList(_waypoints);
    rmUIPanel.showClearButton(true);

    // Calcular ruta si hay 2+ puntos
    if (_waypoints.length >= 2) {
      _calculateRoute();
    }

    console.log(`[rmRouteBuilder] Waypoint ${index} agregado:`, coord);
  }

  function removeWaypoint(index) {
    _waypoints.splice(index, 1);
    _clearAllCanvasElements();
    _redrawAllMarkers();
    if (_waypoints.length >= 2) {
      _calculateRoute();
    } else {
      _routeCoords = [];
      rmUIPanel.renderWaypointList(_waypoints);
      rmUIPanel.updateRouteStats(null);
      if (_waypoints.length === 0) rmUIPanel.showClearButton(false);
    }
  }

  function _redrawAllMarkers() {
    _waypointMarkers = [];
    _waypoints.forEach((coord, index) => {
      let color, radius;
      if (index === 0) {
        color = '#16A34A'; radius = 10;
      } else if (index === _waypoints.length - 1) {
        color = '#DC2626'; radius = 10; // último: rojo
      } else {
        color = '#2563EB'; radius = 7;
      }
      const marker = _service.canvas.circle(coord, radius, 30)
        .change({ fill: color, stroke: '#FFFFFF', 'stroke-width': 2 });
      _waypointMarkers.push(marker);

      _service.canvas.text(
        { lat: coord.lat + 0.002, lng: coord.lng },
        index === 0 ? 'A' : (index === _waypoints.length - 1 ? 'B' : String(index)),
        31
      ).change({ fill: '#1E3A5F', 'font-size': 11, 'font-weight': 700 });
    });
    rmUIPanel.renderWaypointList(_waypoints);
  }

  // ─────────────────────────────────────────────
  // Cálculo de ruta via OSRM
  // ─────────────────────────────────────────────

  function _calculateRoute() {
    const coords = _waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;

    rmUIPanel.setHelpText('Calculando ruta...');

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
          console.error('[rmRouteBuilder] OSRM error:', data);
          rmUIPanel.setHelpText('Error calculando ruta. Intenta con otros puntos.');
          return;
        }
        const route = data.routes[0];
        // GeoJSON coordinates son [lng, lat] → convertir a { lat, lng }
        _routeCoords = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        _routeDistance = route.distance;
        _routeDuration = route.duration;

        _drawPlannedRoute(_routeCoords);

        // Actualizar el marcador del último waypoint a rojo (destino)
        if (_waypointMarkers.length > 0) {
          const lastMarker = _waypointMarkers[_waypointMarkers.length - 1];
          lastMarker.change({ fill: '#DC2626', stroke: '#FFFFFF', 'stroke-width': 2 });
        }

        rmUIPanel.updateRouteStats({
          distance: (route.distance / 1000).toFixed(1) + ' km',
          duration: Math.round(route.duration / 60) + ' min'
        });
        rmUIPanel.setHelpText('Ruta calculada. Continúa agregando puntos o asigna un vehículo.');
        console.log(`[rmRouteBuilder] Ruta calculada: ${(route.distance/1000).toFixed(1)}km`);
      })
      .catch(err => {
        console.error('[rmRouteBuilder] Fetch OSRM error:', err);
        rmUIPanel.setHelpText('Error de red al calcular ruta.');
      });
  }

  // ─────────────────────────────────────────────
  // Dibujo en el mapa nativo (service.canvas)
  // ─────────────────────────────────────────────

  function _drawPlannedRoute(coords) {
    if (_plannedRoutePath) {
      _plannedRoutePath.remove();
      _plannedRoutePath = null;
    }
    if (coords.length < 2) return;

    const segments = [
      { type: 'M', points: [coords[0]] },
      ...coords.slice(1).map(c => ({ type: 'L', points: [c] }))
    ];

    _plannedRoutePath = _service.canvas.path(segments, 10)
      .change({
        stroke: '#2563EB',
        'stroke-width': 4,
        fill: 'none',
        'fill-opacity': 0
      });
  }

  function _clearAllCanvasElements() {
    _waypointMarkers.forEach(m => { try { m.remove(); } catch(e) {} });
    _waypointMarkers = [];
    if (_plannedRoutePath) {
      try { _plannedRoutePath.remove(); } catch(e) {}
      _plannedRoutePath = null;
    }
    // Limpiar textos: no guardamos referencias a los textos,
    // service.canvas.clear() limpia TODO — solo usarlo en clearRoute completo
  }

  // ─────────────────────────────────────────────
  // Limpiar toda la ruta
  // ─────────────────────────────────────────────

  function clearRoute() {
    _waypoints = [];
    _routeCoords = [];
    _routeDistance = 0;
    _routeDuration = 0;
    _service.canvas.clear(); // limpia absolutamente todo del canvas
    _waypointMarkers = [];
    _plannedRoutePath = null;
    rmUIPanel.renderWaypointList([]);
    rmUIPanel.updateRouteStats(null);
    rmUIPanel.showClearButton(false);
    rmUIPanel.setHelpText('Haz clic en el mapa para definir puntos de ruta.');
    console.log('[rmRouteBuilder] Ruta limpiada');
  }

  // ─────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────

  return {
    init,
    activate,
    deactivate,
    clearRoute,
    removeWaypoint,
    hasRoute: () => _waypoints.length >= 2 && _routeCoords.length >= 2,
    getWaypoints: () => [..._waypoints],
    getRouteCoords: () => [..._routeCoords],
    getRouteDistance: () => _routeDistance,
    getRouteDuration: () => _routeDuration,
    setDeviationThreshold: (v) => { _deviationThreshold = v; },
    getDeviationThreshold: () => _deviationThreshold,
    getPlannedRoutePath: () => _plannedRoutePath
  };

})();
