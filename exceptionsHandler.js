/**
 * exceptionsHandler.js
 * Captura y gestiona las excepciones de reglas de MyGeotab
 * que ocurren durante el recorrido de la ruta asignada.
 */

const rmExceptionsHandler = (() => {

  let _service = null;
  let _exceptions = [];        // log de todas las excepciones
  let _seenIds = new Set();    // para no duplicar
  let _ruleCache = {};         // cache de nombres de reglas { ruleId: ruleName }

  // ─────────────────────────────────────────────
  // Inicialización
  // ─────────────────────────────────────────────

  function init(service) {
    _service = service;
    console.log('[rmExceptions] Inicializado');
  }

  // ─────────────────────────────────────────────
  // Categorizar excepción por tipo (para filtro de UI)
  // ─────────────────────────────────────────────

  function _categorizeException(ruleName) {
    if (!ruleName) return 'other';
    const name = ruleName.toLowerCase();
    if (name.includes('speed') || name.includes('velocidad') || name.includes('exceso')) return 'speed';
    if (name.includes('zone') || name.includes('zona') || name.includes('cerca')) return 'zone';
    if (name.includes('harsh') || name.includes('brusco') || name.includes('accel') || name.includes('brake')) return 'driving';
    return 'other';
  }

  // ─────────────────────────────────────────────
  // Resolver nombre de regla
  // ─────────────────────────────────────────────

  function _resolveRuleName(ruleId) {
    if (!ruleId) return Promise.resolve('Regla desconocida');
    if (_ruleCache[ruleId]) return Promise.resolve(_ruleCache[ruleId]);

    return _service.api.call('Get', {
      typeName: 'Rule',
      search: { id: ruleId }
    }).then(rules => {
      const name = (rules && rules[0] && rules[0].name) ? rules[0].name : `Regla ${ruleId}`;
      _ruleCache[ruleId] = name;
      return name;
    }).catch(() => {
      return `Regla ${ruleId}`;
    });
  }

  // ─────────────────────────────────────────────
  // Registrar excepción
  // ─────────────────────────────────────────────

  /**
   * @param {Object} excData - { id, ruleId, deviceId, from, to, distance }
   * @param {Object} service - referencia al service (puede pasarse desde tracking)
   */
  function logException(excData, service) {
    if (!excData || !excData.id) return;
    if (_seenIds.has(excData.id)) return; // ya registrada
    _seenIds.add(excData.id);

    const svc = service || _service;

    _resolveRuleName(excData.ruleId).then(ruleName => {
      const exc = {
        id: excData.id,
        ruleId: excData.ruleId,
        ruleName,
        category: _categorizeException(ruleName),
        deviceId: excData.deviceId,
        from: excData.from,
        to: excData.to,
        distance: excData.distance || null,
        loggedAt: new Date().toISOString()
      };

      _exceptions.push(exc);
      rmUIPanel.addExceptionToLog(exc);
      console.log('[rmExceptions] Excepción registrada:', ruleName, exc.from);
    });
  }

  // ─────────────────────────────────────────────
  // Consulta batch de excepciones (polling manual)
  // ─────────────────────────────────────────────

  function fetchExceptionsForDevice(deviceId, fromDate) {
    if (!_service || !deviceId) return;

    _service.api.call('Get', {
      typeName: 'ExceptionEvent',
      search: {
        deviceSearch: { id: deviceId },
        fromDate: fromDate,
        includeInvalidated: false
      }
    }).then(exceptions => {
      if (!exceptions || exceptions.length === 0) return;
      console.log(`[rmExceptions] ${exceptions.length} excepción(es) encontradas`);
      exceptions.forEach(exc => {
        logException({
          id: exc.id,
          ruleId: exc.rule ? exc.rule.id : null,
          deviceId: exc.device ? exc.device.id : null,
          from: exc.activeFrom,
          to: exc.activeTo,
          distance: exc.distance
        });
      });
    }).catch(err => console.warn('[rmExceptions] Error consultando excepciones:', err));
  }

  // ─────────────────────────────────────────────
  // Filtrar para la UI
  // ─────────────────────────────────────────────

  function getFiltered(category) {
    if (!category || category === 'all') return [..._exceptions];
    return _exceptions.filter(e => e.category === category);
  }

  // ─────────────────────────────────────────────
  // Limpiar
  // ─────────────────────────────────────────────

  function clear() {
    _exceptions = [];
    _seenIds.clear();
    rmUIPanel.clearExceptionLog();
  }

  return {
    init,
    logException,
    fetchExceptionsForDevice,
    getFiltered,
    clear,
    getAll: () => [..._exceptions],
    getCount: () => _exceptions.length
  };

})();
