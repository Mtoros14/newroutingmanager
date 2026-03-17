/**
 * app.js — Entry point del Map Add-in de MyGeotab v4.2.0
 *
 * FIXES:
 *  - Carga de vehículos: usa multiCall para obtener Device + DeviceStatusInfo
 *    en una sola llamada, y enriquece los datos con estado online/offline.
 *  - Activa el add-in inmediatamente si ya está en foco al cargar.
 */

window.geotab = window.geotab || {};
window.geotab.addin = window.geotab.addin || {};

window.geotab.addin.routingAddin = function(elt, service) {

  console.log('[RoutingAddin] Iniciando v4.2.0...');

  // ── 1. Inicializar módulos ──────────────────────────────────────────
  rmExceptionsHandler.init(service);
  rmUIPanel.init(elt, service);
  rmRouteBuilder.init(service);
  rmTrackingEngine.init(service);

  // ── 2. Cargar vehículos con multiCall ──────────────────────────────
  // Device: lista de todos los dispositivos
  // DeviceStatusInfo: estado de conectividad actual
  service.api.multiCall([
    ['Get', { typeName: 'Device', search: { activeFrom: '1986-01-01T00:00:00.000Z' } }],
    ['Get', { typeName: 'DeviceStatusInfo' }]
  ])
  .then(([devices, statusInfos]) => {
    // Crear mapa de estado por deviceId
    const statusMap = {};
    (statusInfos || []).forEach(si => {
      if (si.device?.id) statusMap[si.device.id] = si;
    });

    // Enriquecer cada device con datos de conectividad
    const enriched = (devices || []).map(d => {
      const si = statusMap[d.id];
      return {
        ...d,
        _online: si ? (si.isDeviceCommunicating === true) : undefined,
        _lastComm: si?.lastCommunicationDate || null,
        _lat: si?.latitude || null,
        _lng: si?.longitude || null
      };
    });

    // Ordenar: online primero, luego alphabético
    enriched.sort((a, b) => {
      if (a._online && !b._online) return -1;
      if (!a._online && b._online) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    console.log(`[RoutingAddin] ${enriched.length} vehículos cargados`);
    rmUIPanel.populateVehicleList(enriched);
  })
  .catch(err => {
    console.error('[RoutingAddin] Error en multiCall vehículos:', err);
    // Fallback: intentar cargar solo los Device sin status
    service.api.call('Get', { typeName: 'Device', search: { activeFrom: '1986-01-01T00:00:00.000Z' } })
      .then(devices => rmUIPanel.populateVehicleList(devices || []))
      .catch(() => rmUIPanel.populateVehicleList([]));
  });

  // ── 3. Focus / blur del panel ──────────────────────────────────────
  service.page.attach('focus', () => {
    console.log('[RoutingAddin] Panel activado — clicks en mapa ON');
    rmRouteBuilder.activate();
  });

  service.page.attach('blur', () => {
    console.log('[RoutingAddin] Panel desactivado — clicks en mapa OFF');
    rmRouteBuilder.deactivate();
  });

  // ── 4. Activar inmediatamente si ya está en foco ───────────────────
  // (el evento focus NO se dispara en la carga inicial)
  if (service.page.active) {
    rmRouteBuilder.activate();
  }

  console.log('[RoutingAddin] Inicializado correctamente ✓');
};
