/**
 * deviationDetector.js
 * Algoritmos geoespaciales para detección de desvíos y cálculo de progreso.
 * No depende del objeto `service` — es pura matemática.
 */

const rmDeviationDetector = (() => {

  /**
   * Distancia Haversine entre dos puntos {lat, lng} en metros.
   */
  function haversineDistance(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const x = sinDLat * sinDLat +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
      sinDLng * sinDLng;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  /**
   * Distancia perpendicular de un punto P al segmento AB (en metros).
   * Retorna la distancia mínima al segmento (no a la línea infinita).
   */
  function pointToSegmentDistance(p, a, b) {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) return haversineDistance(p, a);

    let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const closest = {
      lat: a.lat + t * dy,
      lng: a.lng + t * dx
    };
    return haversineDistance(p, closest);
  }

  /**
   * Verifica si un punto está dentro del corredor de la ruta planificada.
   * @param {Object} point       - { lat, lng } posición actual del vehículo
   * @param {Array}  routeCoords - Array de { lat, lng } que forman la ruta planificada
   * @param {number} threshold   - Umbral en metros (default 100)
   * @returns {boolean}
   */
  function isOnRoute(point, routeCoords, threshold = 100) {
    if (!routeCoords || routeCoords.length < 2) return true;

    for (let i = 0; i < routeCoords.length - 1; i++) {
      const dist = pointToSegmentDistance(point, routeCoords[i], routeCoords[i + 1]);
      if (dist <= threshold) return true;
    }
    return false;
  }

  /**
   * Calcula el progreso de la ruta (0–100) en base a la posición actual.
   * Encuentra el segmento más cercano y calcula qué fracción de la ruta fue cubierta.
   * @param {Object} currentPos  - { lat, lng }
   * @param {Array}  routeCoords - Array de { lat, lng }
   * @returns {Object} { percent, distanceDone, distanceTotal, closestSegmentIndex }
   */
  function calculateProgress(currentPos, routeCoords) {
    if (!routeCoords || routeCoords.length < 2) {
      return { percent: 0, distanceDone: 0, distanceTotal: 0, closestSegmentIndex: 0 };
    }

    // Calcular distancia total de la ruta
    let distanceTotal = 0;
    const segmentLengths = [];
    for (let i = 0; i < routeCoords.length - 1; i++) {
      const d = haversineDistance(routeCoords[i], routeCoords[i + 1]);
      segmentLengths.push(d);
      distanceTotal += d;
    }

    // Encontrar el segmento más cercano al punto actual
    let minDist = Infinity;
    let closestSegIdx = 0;
    let closestT = 0;

    for (let i = 0; i < routeCoords.length - 1; i++) {
      const a = routeCoords[i];
      const b = routeCoords[i + 1];
      const dx = b.lng - a.lng;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;

      let t = 0;
      if (lenSq > 0) {
        t = ((currentPos.lng - a.lng) * dx + (currentPos.lat - a.lat) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }

      const closest = { lat: a.lat + t * dy, lng: a.lng + t * dx };
      const dist = haversineDistance(currentPos, closest);

      if (dist < minDist) {
        minDist = dist;
        closestSegIdx = i;
        closestT = t;
      }
    }

    // Distancia recorrida = suma de segmentos anteriores + fracción del segmento actual
    let distanceDone = 0;
    for (let i = 0; i < closestSegIdx; i++) {
      distanceDone += segmentLengths[i];
    }
    distanceDone += closestT * segmentLengths[closestSegIdx];

    const percent = distanceTotal > 0 ? Math.min(100, Math.round((distanceDone / distanceTotal) * 100)) : 0;

    return {
      percent,
      distanceDone: Math.round(distanceDone),
      distanceTotal: Math.round(distanceTotal),
      closestSegmentIndex: closestSegIdx
    };
  }

  /**
   * Calcula qué waypoints discretos (inicio, intermedios, fin) han sido visitados.
   * Un waypoint se considera visitado si el vehículo estuvo a menos de `threshold` metros.
   * @param {Object} currentPos - { lat, lng }
   * @param {Array}  waypoints  - Array de { lat, lng } (los puntos colocados por el usuario)
   * @param {Array}  visited    - Array de booleanos (estado actual)
   * @param {number} threshold
   * @returns {Array} nuevo array de booleanos
   */
  function updateVisitedWaypoints(currentPos, waypoints, visited, threshold = 150) {
    return waypoints.map((wp, i) => {
      if (visited[i]) return true; // ya visitado, no vuelve a false
      return haversineDistance(currentPos, wp) <= threshold;
    });
  }

  return {
    haversineDistance,
    isOnRoute,
    calculateProgress,
    updateVisitedWaypoints,
    pointToSegmentDistance
  };

})();
