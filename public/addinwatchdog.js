/* Add-in MyGeotab: registra a página Watchdogs (tela de escolha) */
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
  ["addinwatchdog", "watchdogs", "watchdogBimbo"].forEach(function (n) { window.geotab.addin[n] = entry; });
})();
