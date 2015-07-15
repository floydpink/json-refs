(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.JsonRefs = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (global){
"use strict";function getRemoteJson(e,r){var t=remoteCache[e],n=Promise.resolve();return _.isUndefined(t)?(n=pathLoader.load(e,r),n=r.processContent?n.then(function(t){return r.processContent(t,e)}):n.then(JSON.parse),n.then(function(r){return remoteCache[e]=r,r})):n=n.then(function(){return t}),n}function realResolveRefs(e,r,t){function n(e,r){function t(e){".."===e?o.pop():"."!==e&&""!==e&&o.push(e)}var n="#"!==r.charAt(0)&&-1===r.indexOf(":"),o="/"===(e||"").charAt(0)?[""]:[],i=r.split("#")[0].split("/");return _.each((e||"").split("#")[0].split("/"),t),n?_.each(i,t):o=i,o.join("/")}function o(e){var r=[],n=e.map(function(){var e=pathToPointer(this.path);this.circular&&(r.push(e),t[e+"/$ref"].circular=!0,0===s?this.update({}):this.update(traverse(this.node).map(function(){this.circular&&this.parent.update({})})))});return _.each(r,function(e){var r,t=[],o=pathFromPointer(e),i=traverse(n).get(o);for(r=0;s>r;r++)t.push.apply(t,o),traverse(n).set(t,_.cloneDeep(i))}),n}function i(e,r,n,o){var i,s,a,u=!1,f={ref:n};_.isError(r)?(u=!0,a=void 0,f.err=r):(n=-1===n.indexOf("#")?"#":n.substring(n.indexOf("#")),u=!r.has(pathFromPointer(n)),a=r.get(pathFromPointer(n))),s=pathFromPointer(o),i=s.slice(0,s.length-1),u||(0===i.length?e.value=a:e.set(i,a),f.value=a),t[o]=f}var s=_.isUndefined(r.depth)?1:r.depth,a=traverse(e),u={},f=findRefs(e),c=Promise.resolve();return Object.keys(f).length>0?(_.each(f,function(e,r){isRemotePointer(e)?u[r]=e:i(a,a,e,r)}),Object.keys(u).length>0?(c=Promise.resolve(),_.each(u,function(e,o){var s,u=n(r.location,e),f=-1===e.indexOf(":")?void 0:e.split(":")[0];s=-1!==supportedSchemes.indexOf(f)||_.isUndefined(f)?new Promise(function(s){getRemoteJson(u,r).then(function(u){var f=_.cloneDeep(r),c=e.split("#")[0];c=c.substring(0,c.lastIndexOf("/")+1),f.location=n(r.location,c),realResolveRefs(u,f,t).then(function(r){i(a,traverse(r.resolved),e,o),s()},function(r){i(a,r,e,o),s()})},function(r){i(a,r,e,o),s()})}):Promise.resolve(),c=c.then(function(){return s})}),c=c.then(function(){return{metadata:t,resolved:o(a)}},function(e){return Promise.reject(e)})):c=c.then(function(){return{metadata:t,resolved:o(a)}})):c=c.then(function(){return{metadata:t,resolved:o(a)}}),c}"undefined"==typeof Promise&&require("native-promise-only");var _=require("./lib/utils"),pathLoader="undefined"!=typeof window?window.PathLoader:"undefined"!=typeof global?global.PathLoader:null,traverse="undefined"!=typeof window?window.traverse:"undefined"!=typeof global?global.traverse:null,remoteCache={},supportedSchemes=["file","http","https"];module.exports.clearCache=function(){remoteCache={}};var isJsonReference=module.exports.isJsonReference=function(e){return _.isPlainObject(e)&&_.isString(e.$ref)},pathToPointer=module.exports.pathToPointer=function(e){if(_.isUndefined(e))throw new Error("path is required");if(!_.isArray(e))throw new Error("path must be an array");var r="#";return e.length>0&&(r+="/"+e.map(function(e){return e.replace(/~/g,"~0").replace(/\//g,"~1")}).join("/")),r},findRefs=module.exports.findRefs=function(e){if(_.isUndefined(e))throw new Error("json is required");if(!_.isPlainObject(e))throw new Error("json must be an object");return traverse(e).reduce(function(e){var r=this.node;return"$ref"===this.key&&isJsonReference(this.parent.node)&&(e[pathToPointer(this.path)]=r),e},{})},isRemotePointer=module.exports.isRemotePointer=function(e){if(_.isUndefined(e))throw new Error("ptr is required");if(!_.isString(e))throw new Error("ptr must be a string");return""!==e&&"#"!==e.charAt(0)},pathFromPointer=module.exports.pathFromPointer=function(e){if(_.isUndefined(e))throw new Error("ptr is required");if(!_.isString(e))throw new Error("ptr must be a string");var r=[],t=["","#","#/"];return isRemotePointer(e)?r=e:-1===t.indexOf(e)&&"#"===e.charAt(0)&&(r=e.substring(e.indexOf("/")).split("/").reduce(function(e,r){return""!==r&&e.push(r.replace(/~0/g,"~").replace(/~1/g,"/")),e},[])),r};module.exports.resolveRefs=function(e,r,t){var n=Promise.resolve();return 2===arguments.length&&_.isFunction(r)&&(t=r,r={}),_.isUndefined(r)&&(r={}),n=n.then(function(){if(_.isUndefined(e))throw new Error("json is required");if(!_.isPlainObject(e))throw new Error("json must be an object");if(!_.isPlainObject(r))throw new Error("options must be an object");if(!_.isUndefined(t)&&!_.isFunction(t))throw new Error("done must be a function");if(!_.isUndefined(r.processContent)&&!_.isFunction(r.processContent))throw new Error("options.processContent must be a function");if(!_.isUndefined(r.prepareRequest)&&!_.isFunction(r.prepareRequest))throw new Error("options.prepareRequest must be a function");if(!_.isUndefined(r.location)&&!_.isString(r.location))throw new Error("options.location must be a string");if(!_.isUndefined(r.depth)&&!_.isNumber(r.depth))throw new Error("options.depth must be a number");if(!_.isUndefined(r.depth)&&r.depth<0)throw new Error("options.depth must be greater or equal to zero")}),n=n.then(function(){return realResolveRefs(traverse(e).clone(),traverse(r).clone(),{})}),!_.isUndefined(t)&&_.isFunction(t)&&(n=n.then(function(e){t(void 0,e.resolved,e.metadata)},function(e){t(e)})),n};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./lib/utils":2,"native-promise-only":3}],2:[function(require,module,exports){
(function (global){
"use strict";function isType(e,r){return Object.prototype.toString.call(e)==="[object "+r+"]"}var traverse="undefined"!=typeof window?window.traverse:"undefined"!=typeof global?global.traverse:null;module.exports.cloneDeep=function(e){return traverse(e).clone()};var isArray=module.exports.isArray=function(e){return isType(e,"Array")};module.exports.isError=function(e){return isType(e,"Error")},module.exports.isFunction=function(e){return isType(e,"Function")},module.exports.isNumber=function(e){return isType(e,"Number")};var isPlainObject=module.exports.isPlainObject=function(e){return isType(e,"Object")};module.exports.isString=function(e){return isType(e,"String")},module.exports.isUndefined=function(e){return"undefined"==typeof e},module.exports.each=function(e,r){isArray(e)?e.forEach(r):isPlainObject(e)&&Object.keys(e).forEach(function(n){r(e[n],n)})};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],3:[function(require,module,exports){
(function (global){
!function(t,n,e){n[t]=n[t]||e(),"undefined"!=typeof module&&module.exports?module.exports=n[t]:"function"==typeof define&&define.amd&&define(function(){return n[t]})}("Promise","undefined"!=typeof global?global:this,function(){"use strict";function t(t,n){l.add(t,n),h||(h=y(l.drain))}function n(t){var n,e=typeof t;return null==t||"object"!=e&&"function"!=e||(n=t.then),"function"==typeof n?n:!1}function e(){for(var t=0;t<this.chain.length;t++)o(this,1===this.state?this.chain[t].success:this.chain[t].failure,this.chain[t]);this.chain.length=0}function o(t,e,o){var r,i;try{e===!1?o.reject(t.msg):(r=e===!0?t.msg:e.call(void 0,t.msg),r===o.promise?o.reject(TypeError("Promise-chain cycle")):(i=n(r))?i.call(r,o.resolve,o.reject):o.resolve(r))}catch(c){o.reject(c)}}function r(o){var c,u=this;if(!u.triggered){u.triggered=!0,u.def&&(u=u.def);try{(c=n(o))?t(function(){var t=new f(u);try{c.call(o,function(){r.apply(t,arguments)},function(){i.apply(t,arguments)})}catch(n){i.call(t,n)}}):(u.msg=o,u.state=1,u.chain.length>0&&t(e,u))}catch(a){i.call(new f(u),a)}}}function i(n){var o=this;o.triggered||(o.triggered=!0,o.def&&(o=o.def),o.msg=n,o.state=2,o.chain.length>0&&t(e,o))}function c(t,n,e,o){for(var r=0;r<n.length;r++)!function(r){t.resolve(n[r]).then(function(t){e(r,t)},o)}(r)}function f(t){this.def=t,this.triggered=!1}function u(t){this.promise=t,this.state=0,this.triggered=!1,this.chain=[],this.msg=void 0}function a(n){if("function"!=typeof n)throw TypeError("Not a function");if(0!==this.__NPO__)throw TypeError("Not a promise");this.__NPO__=1;var o=new u(this);this.then=function(n,r){var i={success:"function"==typeof n?n:!0,failure:"function"==typeof r?r:!1};return i.promise=new this.constructor(function(t,n){if("function"!=typeof t||"function"!=typeof n)throw TypeError("Not a function");i.resolve=t,i.reject=n}),o.chain.push(i),0!==o.state&&t(e,o),i.promise},this["catch"]=function(t){return this.then(void 0,t)};try{n.call(void 0,function(t){r.call(o,t)},function(t){i.call(o,t)})}catch(c){i.call(o,c)}}var s,h,l,p=Object.prototype.toString,y="undefined"!=typeof setImmediate?function(t){return setImmediate(t)}:setTimeout;try{Object.defineProperty({},"x",{}),s=function(t,n,e,o){return Object.defineProperty(t,n,{value:e,writable:!0,configurable:o!==!1})}}catch(d){s=function(t,n,e){return t[n]=e,t}}l=function(){function t(t,n){this.fn=t,this.self=n,this.next=void 0}var n,e,o;return{add:function(r,i){o=new t(r,i),e?e.next=o:n=o,e=o,o=void 0},drain:function(){var t=n;for(n=e=h=void 0;t;)t.fn.call(t.self),t=t.next}}}();var g=s({},"constructor",a,!1);return a.prototype=g,s(g,"__NPO__",0,!1),s(a,"resolve",function(t){var n=this;return t&&"object"==typeof t&&1===t.__NPO__?t:new n(function(n,e){if("function"!=typeof n||"function"!=typeof e)throw TypeError("Not a function");n(t)})}),s(a,"reject",function(t){return new this(function(n,e){if("function"!=typeof n||"function"!=typeof e)throw TypeError("Not a function");e(t)})}),s(a,"all",function(t){var n=this;return"[object Array]"!=p.call(t)?n.reject(TypeError("Not an array")):0===t.length?n.resolve([]):new n(function(e,o){if("function"!=typeof e||"function"!=typeof o)throw TypeError("Not a function");var r=t.length,i=Array(r),f=0;c(n,t,function(t,n){i[t]=n,++f===r&&e(i)},o)})}),s(a,"race",function(t){var n=this;return"[object Array]"!=p.call(t)?n.reject(TypeError("Not an array")):new n(function(e,o){if("function"!=typeof e||"function"!=typeof o)throw TypeError("Not a function");c(n,t,function(t,n){e(n)},o)})}),a});

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}]},{},[1])(1)
});