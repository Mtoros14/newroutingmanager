/**
 * app.js
 * Entry point del Map Add-in de MyGeotab.
 *
 * CRÍTICO: La función debe registrarse en window.geotab.addin
 * con el nombre exacto del add-in. MyGeotab inyecta (elt, service)
 * automáticamente cuando el usuario abre el panel del add-in.
 *
 * service.api         → llamadas a la API de Geotab
 * service.events      → eventos del mapa (click, change, over, move)
 * service.canvas      → dibujar en el mapa (path, circle, marker, text)
 * service.map         → controlar viewport (setBounds, setZoom)
 * service.actionList  → menú contextual del mapa
 * service.tooltip     → tooltips sobre entidades
 * service.localStorage → persistencia entre sesiones
 * service.page        → focus/blur del panel, navegación
 */

// Namespace seguro para evitar colisiones con otros add-ins activos
window.geotab = window.geotab || {};
window.geotab.addin = window.geotab.addin || {};

window.geotab.addin.routingAddin = function(elt, service) {

  console.log('[RoutingAddin] Iniciando add-in v4.1.0...');

  // ─────────────────────────────────────────────
  // 1. Inicializar todos los módulos con `service`
  // ─────────────────────────────────────────────

  rmExceptionsHandler.init(service);
  rmUIPanel.init(elt, service);
  rmRouteBuilder.init(service);
  rmTrackingEngine.init(service);

  // ─────────────────────────────────────────────
  // 2. Cargar lista de vehículos al inicio
  // ─────────────────────────────────────────────

  service.api.call('Get', {
    typeName: 'Device',
    search: { activeFrom: '1986-01-01T00:00:00.000Z' }
  }).then(devices => {
    console.log(`[RoutingAddin] ${devices.length} vehículos cargados`);
    rmUIPanel.populateVehicleList(devices);
  }).catch(err => {
    console.error('[RoutingAddin] Error cargando vehículos:', err);
    rmUIPanel.populateVehicleList([]);
  });

  // ─────────────────────────────────────────────
  // 3. Restaurar ruta guardada (si existía una sesión previa)
  // ─────────────────────────────────────────────

  rmTrackingEngine.restoreFromStorage();

  // ─────────────────────────────────────────────
  // 4. Eventos de focus/blur del panel
  //    - focus: el usuario abre/activa este tab del add-in
  //    - blur:  el usuario cambia a otro tab o add-in
  // ─────────────────────────────────────────────

  service.page.attach('focus', () => {
    console.log('[RoutingAddin] Panel activado — captura de clicks en mapa ON');
    rmRouteBuilder.activate();
  });

  service.page.attach('blur', () => {
    console.log('[RoutingAddin] Panel desactivado — captura de clicks en mapa OFF');
    rmRouteBuilder.deactivate();
  });

  // ─────────────────────────────────────────────
  // 5. Activar inmediatamente si ya está en foco
  //    (el evento focus no se dispara al cargar por primera vez)
  // ─────────────────────────────────────────────

  if (service.page.active) {
    rmRouteBuilder.activate();
  }

  console.log('[RoutingAddin] Add-in inicializado correctamente ✓');
};
