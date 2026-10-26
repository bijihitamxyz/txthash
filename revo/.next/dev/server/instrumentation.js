"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(() => {
var exports = {};
exports.id = "instrumentation";
exports.ids = ["instrumentation"];
exports.modules = {

/***/ "(instrument)/./src/instrumentation.ts":
/*!********************************!*\
  !*** ./src/instrumentation.ts ***!
  \********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   register: () => (/* binding */ register)\n/* harmony export */ });\n/**\n * Next.js Server Lifecycle Instrumentation (src/instrumentation.ts)\n * Automatically invoked once on server startup.\n * Initializes the unified in-process trading engine scheduler.\n */ async function register() {\n    if (true) {\n        const { ensureSchedulerStarted } = await __webpack_require__.e(/*! import() */ \"_instrument_src_lib_engineScheduler_ts\").then(__webpack_require__.bind(__webpack_require__, /*! @/lib/engineScheduler */ \"(instrument)/./src/lib/engineScheduler.ts\"));\n        ensureSchedulerStarted();\n        console.log('[Instrumentation] Exness AI Engine In-Process Scheduler registered successfully.');\n    }\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKGluc3RydW1lbnQpLy4vc3JjL2luc3RydW1lbnRhdGlvbi50cyIsIm1hcHBpbmdzIjoiOzs7O0FBQUE7Ozs7Q0FJQyxHQUVNLGVBQWVBO0lBQ3BCLElBQUlDLElBQXFDLEVBQUU7UUFDekMsTUFBTSxFQUFFRyxzQkFBc0IsRUFBRSxHQUFHLE1BQU0sNk1BQStCO1FBQ3hFQTtRQUNBQyxRQUFRQyxHQUFHLENBQUM7SUFDZDtBQUNGIiwic291cmNlcyI6WyIvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvaG9tZS9yZXZvL3NyYy9pbnN0cnVtZW50YXRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBOZXh0LmpzIFNlcnZlciBMaWZlY3ljbGUgSW5zdHJ1bWVudGF0aW9uIChzcmMvaW5zdHJ1bWVudGF0aW9uLnRzKVxuICogQXV0b21hdGljYWxseSBpbnZva2VkIG9uY2Ugb24gc2VydmVyIHN0YXJ0dXAuXG4gKiBJbml0aWFsaXplcyB0aGUgdW5pZmllZCBpbi1wcm9jZXNzIHRyYWRpbmcgZW5naW5lIHNjaGVkdWxlci5cbiAqL1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVnaXN0ZXIoKSB7XG4gIGlmIChwcm9jZXNzLmVudi5ORVhUX1JVTlRJTUUgPT09ICdub2RlanMnKSB7XG4gICAgY29uc3QgeyBlbnN1cmVTY2hlZHVsZXJTdGFydGVkIH0gPSBhd2FpdCBpbXBvcnQoJ0AvbGliL2VuZ2luZVNjaGVkdWxlcicpO1xuICAgIGVuc3VyZVNjaGVkdWxlclN0YXJ0ZWQoKTtcbiAgICBjb25zb2xlLmxvZygnW0luc3RydW1lbnRhdGlvbl0gRXhuZXNzIEFJIEVuZ2luZSBJbi1Qcm9jZXNzIFNjaGVkdWxlciByZWdpc3RlcmVkIHN1Y2Nlc3NmdWxseS4nKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbInJlZ2lzdGVyIiwicHJvY2VzcyIsImVudiIsIk5FWFRfUlVOVElNRSIsImVuc3VyZVNjaGVkdWxlclN0YXJ0ZWQiLCJjb25zb2xlIiwibG9nIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VSb290IjoiIn0=\n//# sourceURL=webpack-internal:///(instrument)/./src/instrumentation.ts\n");

/***/ }),

/***/ "fs":
/*!*********************!*\
  !*** external "fs" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("fs");

/***/ }),

/***/ "os":
/*!*********************!*\
  !*** external "os" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("os");

/***/ }),

/***/ "path":
/*!***********************!*\
  !*** external "path" ***!
  \***********************/
/***/ ((module) => {

module.exports = require("path");

/***/ })

};
;

// load runtime
var __webpack_require__ = require("./webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = (__webpack_exec__("(instrument)/./src/instrumentation.ts"));
module.exports = __webpack_exports__;

})();