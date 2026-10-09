/* Add-in MyGeotab: registra a página Watchdog Carretas */
(function () {
  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};
  var entry = function () {
    return {
      initialize: function (api, state, callback) { callback(); },
      focus: function () {},
      blur: function () {}
    };
  };
  ["addincarretas", "watchdogCarretas", "carretas"].forEach(function (n) { window.geotab.addin[n] = entry; });
})();
