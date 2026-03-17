/**
 * deviationDetector.js — Algoritmos geoespaciales puros (sin dependencias de service)
 */
const rmDeviationDetector = (() => {

  function haversineDistance(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat/2)**2 +
      Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  }

  function pointToSegmentDistance(p, a, b) {
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const lenSq = dx*dx + dy*dy;
    if (lenSq === 0) return haversineDistance(p, a);
    let t = ((p.lng-a.lng)*dx + (p.lat-a.lat)*dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return haversineDistance(p, { lat: a.lat + t*dy, lng: a.lng + t*dx });
  }

  function isOnRoute(point, routeCoords, threshold = 100) {
    if (!routeCoords || routeCoords.length < 2) return true;
    for (let i = 0; i < routeCoords.length - 1; i++) {
      if (pointToSegmentDistance(point, routeCoords[i], routeCoords[i+1]) <= threshold) return true;
    }
    return false;
  }

  function calculateProgress(currentPos, routeCoords) {
    if (!routeCoords || routeCoords.length < 2)
      return { percent: 0, distanceDone: 0, distanceTotal: 0 };

    let distanceTotal = 0;
    const segLens = [];
    for (let i = 0; i < routeCoords.length-1; i++) {
      const d = haversineDistance(routeCoords[i], routeCoords[i+1]);
      segLens.push(d); distanceTotal += d;
    }

    let minDist = Infinity, closestIdx = 0, closestT = 0;
    for (let i = 0; i < routeCoords.length-1; i++) {
      const a = routeCoords[i], b = routeCoords[i+1];
      const dx = b.lng-a.lng, dy = b.lat-a.lat, lenSq = dx*dx+dy*dy;
      let t = lenSq > 0 ? ((currentPos.lng-a.lng)*dx+(currentPos.lat-a.lat)*dy)/lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const d = haversineDistance(currentPos, { lat:a.lat+t*dy, lng:a.lng+t*dx });
      if (d < minDist) { minDist = d; closestIdx = i; closestT = t; }
    }

    let distanceDone = 0;
    for (let i = 0; i < closestIdx; i++) distanceDone += segLens[i];
    distanceDone += closestT * segLens[closestIdx];

    return {
      percent: distanceTotal > 0 ? Math.min(100, Math.round(distanceDone/distanceTotal*100)) : 0,
      distanceDone: Math.round(distanceDone),
      distanceTotal: Math.round(distanceTotal)
    };
  }

  function updateVisitedWaypoints(currentPos, waypoints, visited, threshold = 150) {
    return waypoints.map((wp, i) => {
      if (visited[i]) return true;
      return haversineDistance(currentPos, wp) <= threshold;
    });
  }

  function minDistanceToRoute(pos, routeCoords) {
    let min = Infinity;
    for (let i = 0; i < routeCoords.length-1; i++) {
      const d = pointToSegmentDistance(pos, routeCoords[i], routeCoords[i+1]);
      if (d < min) min = d;
    }
    return min === Infinity ? 0 : Math.round(min);
  }

  return { haversineDistance, pointToSegmentDistance, isOnRoute,
           calculateProgress, updateVisitedWaypoints, minDistanceToRoute };
})();
