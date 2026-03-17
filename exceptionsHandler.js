/**
 * exceptionsHandler.js — Captura y log de excepciones de reglas de MyGeotab
 */
const rmExceptionsHandler = (() => {
  let _service = null;
  let _exceptions = [];
  let _seenIds = new Set();
  let _ruleCache = {};

  function init(service) { _service = service; }

  function _categorize(name) {
    if (!name) return 'other';
    const n = name.toLowerCase();
    if (n.includes('speed') || n.includes('velocidad') || n.includes('exceso')) return 'speed';
    if (n.includes('zone') || n.includes('zona')) return 'zone';
    if (n.includes('harsh') || n.includes('brusco') || n.includes('accel') || n.includes('brake')) return 'driving';
    return 'other';
  }

  function _resolveRuleName(ruleId) {
    if (!ruleId) return Promise.resolve('Regla desconocida');
    if (_ruleCache[ruleId]) return Promise.resolve(_ruleCache[ruleId]);
    const svc = _service;
    return svc.api.call('Get', { typeName: 'Rule', search: { id: ruleId } })
      .then(rules => {
        const name = rules?.[0]?.name || `Regla ${ruleId}`;
        _ruleCache[ruleId] = name;
        return name;
      }).catch(() => `Regla ${ruleId}`);
  }

  function logException(excData, service) {
    if (!excData?.id || _seenIds.has(excData.id)) return;
    _seenIds.add(excData.id);
    const svc = service || _service;
    _resolveRuleName(excData.ruleId).then(ruleName => {
      const exc = {
        id: excData.id, ruleId: excData.ruleId, ruleName,
        category: _categorize(ruleName),
        deviceId: excData.deviceId,
        from: excData.from, to: excData.to,
        loggedAt: new Date().toISOString()
      };
      _exceptions.push(exc);
      rmUIPanel.addExceptionToLog(exc);
    });
  }

  function fetchExceptionsForDevice(deviceId, fromDate) {
    if (!_service || !deviceId) return;
    _service.api.call('Get', {
      typeName: 'ExceptionEvent',
      search: { deviceSearch: { id: deviceId }, fromDate, includeInvalidated: false }
    }).then(excs => {
      (excs || []).forEach(exc => logException({
        id: exc.id, ruleId: exc.rule?.id, deviceId: exc.device?.id,
        from: exc.activeFrom, to: exc.activeTo
      }));
    }).catch(() => {});
  }

  function getFiltered(cat) {
    return !cat || cat === 'all' ? [..._exceptions] : _exceptions.filter(e => e.category === cat);
  }

  function clear() {
    _exceptions = []; _seenIds.clear();
    rmUIPanel.clearExceptionLog();
  }

  return { init, logException, fetchExceptionsForDevice, getFiltered, clear,
           getAll: () => [..._exceptions], getCount: () => _exceptions.length };
})();
