(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.JsonRefs = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (global){
/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Jeremy Whitlock
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

/**
 * Various utilities for JSON References *(http://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03)* and
 * JSON Pointers *(https://tools.ietf.org/html/rfc6901)*.
 *
 * @module JsonRefs
 */

var dirname = require('path').dirname;
var pathLoader = (typeof window !== "undefined" ? window['PathLoader'] : typeof global !== "undefined" ? global['PathLoader'] : null);
var qs = require('querystring');
var slash = require('slash');
var URI = require('uri-js');

var badPtrTokenRegex = /~(?:[^01]|$)/g;
var remoteCache = {};
var remoteTypes = ['relative', 'remote'];
var uriDetailsCache = {};

// Load promises polyfill if necessary
/* istanbul ignore if */
if (typeof Promise === 'undefined') {
  require('native-promise-only');
}

/* Internal Functions */

// This is a very simplistic clone function that does not take into account non-JSON types.  For these types the
// original value is used as the clone.  So while it's not a complete deep clone, for the needs of this project
// this should be sufficient.
function clone (obj) {
  var cloned;

  if (isType(obj, 'Array')) {
    cloned = [];

    obj.forEach(function (value, index) {
      cloned[index] = clone(value);
    });
  } else if (isType(obj, 'Object')) {
    cloned = {};

    Object.keys(obj).forEach(function (key) {
      cloned[key] = clone(obj[key]);
    });
  } else {
    cloned = obj;
  }

  return cloned;
}

function combinePaths (p1, p2) {
  var combined = [];

  function pathToSegments (path) {
    return isType(path, 'Undefined') || path === '' ? [] : path.split('/');
  }

  function handleSegment (seg) {
    if (seg === '..') {
      combined.pop();
    } else {
      combined.push(seg);
    }
  }

  pathToSegments(p1).concat(pathToSegments(p2)).forEach(handleSegment);

  return combined.length === 0 ? '' : combined.join('/');
}

function combineQueryParams (qs1, qs2) {
  var combined = {};

  function mergeQueryParams (obj) {
    Object.keys(obj).forEach(function (key) {
      combined[key] = obj[key];
    });
  }

  mergeQueryParams(qs.parse(qs1 || ''));
  mergeQueryParams(qs.parse(qs2 || ''));

  return Object.keys(combined).length === 0 ? undefined : qs.stringify(combined);
}

function combineURIs (u1, u2) {
  // Convert Windows paths
  if (isType(u1, 'String')) {
    u1 = slash(u1);
  }

  if (isType(u2, 'String')) {
    u2 = slash(u2);
  }

  var u2Details = URI.parse(isType(u2, 'Undefined') ? '' : u2);
  var u1Details;
  var combinedDetails;

  if (u2Details.reference === 'absolute' || u2Details.reference === 'uri') {
    combinedDetails = u2Details;
  } else {
    u1Details = isType(u1, 'Undefined') ? undefined : URI.parse(u1);

    if (!isType(u1Details, 'Undefined')) {
      combinedDetails = u1Details;

      // Join the paths
      combinedDetails.path = URI.normalize(combinePaths(u1Details.path, u2Details.path));

      // Join query parameters
      combinedDetails.query = combineQueryParams(u1Details.query, u2Details.query);
    } else {
      combinedDetails = u2Details;
    }
  }

  // Remove the fragment
  combinedDetails.fragment = undefined;

  return URI.serialize(combinedDetails);
}

function filterRefs (options, refs) {
  var refFilter = makeRefFilter(options);
  var filtered = {};
  var subDocPrefix = pathToPtr(makeSubDocPath(options));

  Object.keys(refs).forEach(function (refPtr) {
    var refDetails = refs[refPtr];

    if (refFilter(refDetails, pathFromPtr(refPtr)) === true &&
        refPtr.indexOf(subDocPrefix) > -1 &&
        (refDetails.type !== 'invalid' || options.includeInvalid === true)) {
      filtered[refPtr] = refDetails;
    }
  });

  return filtered;
}

function findAncestors (obj, path) {
  var ancestors = [];
  var node = obj;

  path.slice(0, path.length - 1).forEach(function (seg) {
    if (seg in node) {
      node = node[seg];

      ancestors.push(node);
    }
  });

  return ancestors;
}

// Should this be its own exported API?
function findAllRefs (obj, options, parents, parentPath, documents) {
  var allTasks = Promise.resolve();
  var refs = findRefs(obj, options);

  Object.keys(refs).forEach(function (refPtr) {
    var refDetails = refs[refPtr];
    var refPath = pathFromPtr(refPtr);
    var location;
    var parentIndex;

    // Only process remote references
    if (remoteTypes.indexOf(refDetails.type) > -1) {
      location = combineURIs(options.relativeBase, refDetails.uri);
      parentIndex = parents.indexOf(location);

      if (parentIndex === -1) {
        allTasks = allTasks
          .then(function () {
            var rParentPath = parentPath.concat(refPath);
            var rOptions = clone(options);

            // Remove the sub document path
            delete rOptions.subDocPath;

            // Remove the relative base
            delete rOptions.relativeBase;

            return findRefsAt(location, rOptions)
              .then(function (rRefs) {
                // Record the location for circular reference identification
                rRefs.location = location;

                if (refDetails.uriDetails.fragment) {
                  // If the remote reference was for a fragment, do not include the reference details
                  rRefs.refs = {};

                  // Record the remote document
                  documents[pathToPtr(rParentPath)] = rRefs;

                  return rRefs;
                } else {
                  // Record the location in the document where the parent document was resolved
                  Object.keys(rRefs.refs).forEach(function (refPtr) {
                    rRefs.refs[refPtr].parentLocation = pathToPtr(rParentPath);
                  });

                  // Record the remote document
                  documents[pathToPtr(rParentPath)] = rRefs;

                  // Update the relative base based on the retrieved location
                  rOptions.relativeBase = dirname(location);

                  // Find all important references within the document
                  return findAllRefs(rRefs.value, rOptions, parents.concat(location), rParentPath, documents);
                }
              }, function (err) {
                refDetails.error = err.message;
                refDetails.missing = true;
              });
          });
      } else {
        // Mark seen ancestors as circular
        parents.slice(parentIndex).forEach(function (parent) {
          Object.keys(documents).forEach(function (cRefPtr) {
            var document = documents[cRefPtr];

            if (document.location === parent) {
              document.circular = true;
            }
          });
        });

        // Mark self as circular
        documents[pathToPtr(parentPath)].refs[refPtr].circular = true;
      }
    }
  });

  allTasks = allTasks
    .then(function () {
      // Only collapse the documents when we're back at the top of the promise stack
      if (parentPath.length === 0) {
        // Collapse all references together into one list
        Object.keys(documents).forEach(function (refPtr) {
          var document = documents[refPtr];

          // Merge each reference into the root document's references
          Object.keys(document.refs).forEach(function (cRefPtr) {
            var fPtr = pathToPtr(pathFromPtr(refPtr).concat(pathFromPtr(cRefPtr)));
            var refDetails = refs[fPtr];

            if (isType(refDetails, 'Undefined')) {
              refs[fPtr] = document.refs[cRefPtr];
            }
          });

          // Record the value of the remote reference
          refs[refPtr].value = document.value;

          // Mark the remote reference itself as circular
          if (document.circular) {
            refs[refPtr].circular = true;
          }
        });
      }

      return refs;
    });

  return allTasks;
}

function findValue (obj, path, ignore) {
  var value = obj;

  try {
    path.forEach(function (seg) {
      if (seg in value) {
        value = value[seg];
      } else {
        throw Error('JSON Pointer points to missing location: ' + pathToPtr(path));
      }
    });
  } catch (err) {
    if (ignore === true) {
      value = undefined;
    } else {
      throw err;
    }
  }

  return value;
}

function getExtraRefKeys (ref) {
  return Object.keys(ref).filter(function (key) {
    return key !== '$ref';
  });
}

function getRemoteDocument (url, options) {
  var cacheEntry = remoteCache[url];
  var allTasks = Promise.resolve();
  var loaderOptions = clone(options.loaderOptions || {});

  if (isType(cacheEntry, 'Undefined')) {
    // If there is no content processor, default to processing the raw response as JSON
    if (isType(loaderOptions.processContent, 'Undefined')) {
      loaderOptions.processContent = function (res, callback) {
        callback(undefined, JSON.parse(res.text));
      };
    }

    // Attempt to load the resource using  path-loader
    allTasks = pathLoader.load(url, loaderOptions);

    // Update the cache
    allTasks = allTasks
      .then(function (res) {
        remoteCache[url] = {
          value: res
        };

        return res;
      })
      .catch(function (err) {
        remoteCache[url] = {
          error: err
        };

        throw err;
      });
  } else {
    // Return the cached version
    allTasks = allTasks.then(function () {
      return cacheEntry.value;
    });
  }

  // Return a cloned version to avoid updating the cache
  allTasks = allTasks.then(function (res) {
    return clone(res);
  });

  return allTasks;
}

function isRefLike (obj, throwWithDetails) {
  var refLike = true;

  try {
    if (!isType(obj, 'Object')) {
      throw new Error('obj is not an Object');
    } else if (!isType(obj.$ref, 'String')) {
      throw new Error('obj.$ref is not a String');
    }
  } catch (err) {
    if (throwWithDetails) {
      throw err;
    }

    refLike = false;
  }

  return refLike;
}

function isType (obj, type) {
  // A PhantomJS bug (https://github.com/ariya/phantomjs/issues/11722) prohibits us from using the same approach for
  // undefined checking that we use for other types.
  if (type === 'Undefined') {
    return typeof obj === 'undefined';
  } else {
    return Object.prototype.toString.call(obj) === '[object ' + type + ']';
  }
}

function makeRefFilter (options) {
  var refFilter;

  if (isType(options.filter, 'Array') || isType(options.filter, 'String')) {
    refFilter = function (refDetails) {
      var validTypes = isType(options.filter, 'String') ? [options.filter] : options.filter;

      return validTypes.indexOf(refDetails.type) > -1;
    };
  } else if (isType(options.filter, 'Function')) {
    refFilter = options.filter;
  } else {
    refFilter = function () {
      return true;
    };
  }

  return refFilter;
}

function makeSubDocPath (options) {
  var fromPath = [];

  if (isType(options.subDocPath, 'Array')) {
    fromPath = options.subDocPath;
  } else if (isType(options.subDocPath, 'String')) {
    fromPath = pathFromPtr(options.subDocPath);
  }

  return fromPath;
}

function setValue (obj, refPath, value) {
  findValue(obj, refPath.slice(0, refPath.length - 1))[refPath[refPath.length - 1]] = value;
}

function walk (ancestors, node, path, fn) {
  var processChildren = true;

  function walkItem (item, segment) {
    path.push(segment);
    walk(ancestors, item, path, fn);
    path.pop();
  }

  // Call the iteratee
  if (isType(fn, 'Function')) {
    processChildren = fn(ancestors, node, path);
  }

  // We do not process circular objects again
  if (ancestors.indexOf(node) === -1) {
    ancestors.push(node);

    if (processChildren !== false) {
      if (isType(node, 'Array')) {
        node.forEach(function (member, index) {
          walkItem(member, index.toString());
        });
      } else if (isType(node, 'Object')) {
        Object.keys(node).forEach(function (key) {
          walkItem(node[key], key);
        });
      }
    }
  }

  ancestors.pop();
}

function validateOptions (options) {
  if (!isType(options, 'Undefined')) {
    if (!isType(options, 'Object')) {
      throw new TypeError('options must be an Object');
    } else if (!isType(options.filter, 'Undefined') &&
               !isType(options.filter, 'Array') &&
               !isType(options.filter, 'Function') &&
               !isType(options.filter, 'String')) {
      throw new TypeError('options.filter must be an Array, a Function of a String');
    } else if (!isType(options.includeInvalid, 'Undefined') &&
               !isType(options.includeInvalid, 'Boolean')) {
      throw new TypeError('options.includeInvalid must be a Boolean');
    } else if (!isType(options.refPreProcessor, 'Undefined') &&
               !isType(options.refPreProcessor, 'Function')) {
      throw new TypeError('options.refPreProcessor must be a Function');
    } else if (!isType(options.refPostProcessor, 'Undefined') &&
               !isType(options.refPostProcessor, 'Function')) {
      throw new TypeError('options.refPostProcessor must be a Function');
    } else if (!isType(options.subDocPath, 'Undefined') &&
               !isType(options.subDocPath, 'Array') &&
               !isPtr(options.subDocPath)) {
      // If a pointer is provided, throw an error if it's not the proper type
      throw new TypeError('options.subDocPath must be an Array of path segments or a valid JSON Pointer');
    }
  }
}

/* Module Members */

/*
 * Each of the functions below are defined as function statements and *then* exported in two steps instead of one due
 * to a bug in jsdoc (https://github.com/jsdoc2md/jsdoc-parse/issues/18) that causes our documentation to be
 * generated improperly.  The impact to the user is significant enough for us to warrant working around it until this
 * is fixed.
 */

/**
 * The options used for various JsonRefs APIs.
 *
 * @typedef {object} JsonRefsOptions
 *
 * @param {string|string[]|function} [filter=function () {return true;}] - The filter to use when gathering JSON
 * References *(If this value is a single string or an array of strings, the value(s) are expected to be the `type(s)`
 * you are interested in collecting as described in {@link module:JsonRefs.getRefDetails}.  If it is a function, it is
 * expected that the function behaves like {@link module:JsonRefs~RefDetailsFilter}.)*
 * @param {boolean} [includeInvalid=false] - Whether or not to include invalid JSON Reference details *(This will make
 * it so that objects that are like JSON Reference objects, as in they are an `Object` and the have a `$ref` property,
 * but fail validation will be included.  This is very useful for when you want to know if you have invalid JSON
 * Reference definitions.  This will not mean that APIs will process invalid JSON References but the reasons as to why
 * the JSON References are invalid will be included in the returned metadata.)*
 * @param {object} [loaderOptions] - The options to pass to
 * {@link https://github.com/whitlockjc/path-loader/blob/master/docs/API.md#module_PathLoader.load|PathLoader~load}
 * @param {RefPreProcessor} [refPreProcessor] - The callback used to pre-process a JSON Reference like
 * object *(This is called prior to validating the JSON Reference like object and getting its details)*
 * @param {RefPostProcessor} [refPostProcessor] - The callback used to post-process the JSON Reference
 * metadata *(This is called prior filtering the references)*
 * @param {string} [options.relativeBase] - The base location to use when resolving relative references *(Only useful
 * for APIs that do remote reference resolution.  If this value is not defined,
 * {@link https://github.com/whitlockjc/path-loader|path-loader} will use `window.location.href` for the browser and
 * `process.cwd()` for Node.js.)*
 * @param {string|string[]} [options.subDocPath=[]] - The JSON Pointer or array of path segments to the sub document
 * location to search from
 */

/**
 * Simple function used to filter out JSON References.
 *
 * @typedef {function} RefDetailsFilter
 *
 * @param {UnresolvedRefDetails} refDetails - The JSON Reference details to test
 * @param {string[]} path - The path to the JSON Reference
 *
 * @returns {boolean} whether the JSON Reference should be filtered *(out)* or not
 */

/**
 * Simple function used to pre-process a JSON Reference like object.
 *
 * @typedef {function} RefPreProcessor
 *
 * @param {object} obj - The JSON Reference like object
 * @param {string[]} path - The path to the JSON Reference like object
 *
 * @returns {object} the processed JSON Reference like object
 */

/**
 * Simple function used to post-process a JSON Reference details.
 *
 * @typedef {function} RefPostProcessor
 *
 * @param {UnresolvedRefDetails} refDetails - The JSON Reference details to test
 * @param {string[]} path - The path to the JSON Reference
 *
 * @returns {object} the processed JSON Reference details object
 */

/**
 * Detailed information about resolved JSON References.
 *
 * @typedef {UnresolvedRefDetails} ResolvedRefDetails
 *
 * @property {boolean} [circular] - Whether or not the JSON Reference is circular *(Will not be set if the JSON
 * Reference is not circular)*
 * @property {boolean} [missing] - Whether or not the referenced value was missing or not *(Will not be set if the
 * referenced value is not missing)*
 * @property {*} [value] - The referenced value *(Will not be set if the referenced value is missing)*
 */

/**
 * The results of resolving the JSON References of an array/object.
 *
 * @typedef {object} ResolvedRefsResults
 *
 * @property {ResolvedRefDetails} refs - An object whose keys are JSON Pointers *(fragment version)*
 * to where the JSON Reference is defined and whose values are {@link module:JsonRefs~ResolvedRefDetails}
 * @property {object} value - The array/object with its JSON References fully resolved
 */

/**
 * An object containing the retrieved document and detailed information about its JSON References.
 *
 * @typedef {object} RetrievedRefsResults
 *
 * @property {UnresolvedRefDetails} refs - An object whose keys are JSON Pointers *(fragment version)*
 * to where the JSON Reference is defined and whose values are {@link module:JsonRefs~UnresolvedRefDetails}
 * @property {object} value - The retrieved document
 */

/**
 * An object containing the retrieved document, the document with its references resolved and  detailed information
 * about its JSON References.
 *
 * @typedef {object} RetrievedResolvedRefsResults
 *
 * @property {UnresolvedRefDetails} refs - An object whose keys are JSON Pointers *(fragment version)*
 * to where the JSON Reference is defined and whose values are {@link module:JsonRefs~UnresolvedRefDetails}
 * @property {ResolvedRefsResults} - An object whose keys are JSON Pointers *(fragment version)*
 * to where the JSON Reference is defined and whose values are {@link module:JsonRefs~ResolvedRefDetails}
 * @property {object} value - The retrieved document
 */

/**
 * Detailed information about unresolved JSON References.
 *
 * @typedef {object} UnresolvedRefDetails
 *
 * @property {object} def - The JSON Reference definition
 * @property {string} [error] - The error information for invalid JSON Reference definition *(Only present when the
 * JSON Reference definition is invalid or there was a problem retrieving a remote reference during resolution)*
 * @property {string} uri - The URI portion of the JSON Reference
 * @property {object} uriDetails - Detailed information about the URI as provided by
 * {@link https://github.com/garycourt/uri-js|URI.parse}.
 * @property {string} type - The JSON Reference type *(This value can be one of the following: `invalid`, `local`,
 * `relative` or `remote`.)*
 * @property {string} [warning] - The warning information *(Only present when the JSON Reference definition produces a
 * warning)*
 */

/**
 * Clears the internal cache of remote documents, reference details, etc.
 *
 * @alias module:JsonRefs.clearCache
 */
function clearCache () {
  remoteCache = {};
}

/**
 * Takes an array of path segments and decodes the JSON Pointer tokens in them.
 *
 * @param {string[]} path - The array of path segments
 *
 * @returns {string} the array of path segments with their JSON Pointer tokens decoded
 *
 * @throws {Error} if the path is not an `Array`
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 *
 * @alias module:JsonRefs.decodePath
 */
function decodePath (path) {
  if (!isType(path, 'Array')) {
    throw new TypeError('path must be an array');
  }

  return path.map(function (seg) {
    if (!isType(seg, 'String')) {
      seg = JSON.stringify(seg);
    }

    return seg.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

/**
 * Takes an array of path segments and encodes the special JSON Pointer characters in them.
 *
 * @param {string[]} path - The array of path segments
 *
 * @returns {string} the array of path segments with their JSON Pointer tokens encoded
 *
 * @throws {Error} if the path is not an `Array`
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 *
 * @alias module:JsonRefs.encodePath
 */
function encodePath (path) {
  if (!isType(path, 'Array')) {
    throw new TypeError('path must be an array');
  }

  return path.map(function (seg) {
    if (!isType(seg, 'String')) {
      seg = JSON.stringify(seg);
    }

    return seg.replace(/~/g, '~0').replace(/\//g, '~1');
  });
}

/**
 * Finds JSON References defined within the provided array/object.
 *
 * @param {array|object} obj - The structure to find JSON References within
 * @param {JsonRefsOptions} [options] - The JsonRefs options
 *
 * @returns {object} an object whose keys are JSON Pointers *(fragment version)* to where the JSON Reference is defined
 * and whose values are {@link module:JsonRefs~UnresolvedRefDetails}.
 *
 * @throws {Error} when the input arguments fail validation or if `options.subDocPath` points to an invalid location
 *
 * @alias module:JsonRefs.findRefs
 *
 * @example
 * // Finding all valid references
 * var allRefs = JsonRefs.findRefs(obj);
 * // Finding all remote references
 * var remoteRefs = JsonRefs.findRefs(obj, {filter: ['relative', 'remote']});
 * // Finding all invalid references
 * var invalidRefs = JsonRefs.findRefs(obj, {filter: 'invalid', includeInvalid: true});
 */
function findRefs (obj, options) {
  var ancestors = [];
  var fromObj = obj;
  var fromPath;
  var refs = {};
  var refFilter;

  // Validate the provided document
  if (!isType(obj, 'Array') && !isType(obj, 'Object')) {
    throw new TypeError('obj must be an Array or an Object');
  }

  // Set default for options
  if (isType(options, 'Undefined')) {
    options = {};
  }

  // Validate options
  validateOptions(options);

  // Convert from to a pointer
  fromPath = makeSubDocPath(options);

  // Convert options.filter from an Array/String to a Function
  refFilter = makeRefFilter(options);

  if (fromPath.length > 0) {
    ancestors = findAncestors(obj, fromPath);
    fromObj = findValue(obj, fromPath);
  }

  // Walk the document (or sub document) and find all JSON References
  walk(ancestors, fromObj, fromPath, function (ancestors, node, path) {
    var processChildren = true;
    var refDetails;

    if (isRefLike(node)) {
      // Pre-process the node when necessary
      if (!isType(options.refPreProcessor, 'Undefined')) {
        node = options.refPreProcessor(node, path);
      }

      refDetails = getRefDetails(node);

      if (refDetails.type !== 'invalid' || options.includeInvalid === true) {
        if (refFilter(refDetails, path) === true) {
          // Post-process the reference details when necessary
          if (!isType(options.refPostProcessor, 'Undefined')) {
            refDetails = options.refPostProcessor(refDetails, path);
          }

          refs[pathToPtr(path)] = refDetails;
        }

        // Whenever a JSON Reference has extra children, its children should be ignored so we want to stop processing.
        //   See: http://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03#section-3
        if (getExtraRefKeys(node).length > 0) {
          processChildren = false;
        }
      }
    }

    return processChildren;
  });

  return refs;
}

/**
 * Finds JSON References defined within the document at the provided location.
 *
 * This API is identical to {@link module:JsonRefs.findRefs} except this API will retrieve a remote document and then
 * return the result of {@link module:JsonRefs.findRefs} on the retrieved document.
 *
 * @param {string} location - The location to retrieve *(Can be relative or absolute, just make sure you look at the
 * {@link module:JsonRefs~JsonRefsOptions|options documentation} to see how relative references are handled.)*
 * @param {JsonRefsOptions} [options] - The JsonRefs options
 *
 * @returns {Promise} a promise that resolves a {@link module:JsonRefs~RetrievedRefsResults} and rejects with an
 * `Error` when the input arguments fail validation, when `options.subDocPath` points to an invalid location or when
 *  the location argument points to an unloadable resource
 *
 * @alias module:JsonRefs.findRefsAt
 *
 * @example
 * // Example that only resolves references within a sub document
 * JsonRefs.findRefsAt('http://petstore.swagger.io/v2/swagger.json', {
 *     subDocPath: '#/definitions'
 *   })
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.value: The retrieved document
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
function findRefsAt (location, options) {
  var allTasks = Promise.resolve();

  allTasks = allTasks
    .then(function () {
      // Validate the provided location
      if (!isType(location, 'String')) {
        throw new TypeError('location must be a string');
      }

      // Set default for options
      if (isType(options, 'Undefined')) {
        options = {};
      }

      // Validate options (Doing this here for a quick)
      validateOptions(options);

      // Combine the location and the optional relative base
      location = combineURIs(options.relativeBase, location);

      return getRemoteDocument(location, options);
    })
    .then(function (res) {
      var cacheEntry = clone(remoteCache[location]);
      var cOptions;

      if (isType(cacheEntry.refs, 'Undefined')) {
        cOptions = clone(options);

        // Do not filter any references so the cache is complete
        delete cOptions.filter;
        delete cOptions.subDocPath;

        cOptions.includeInvalid = true;

        remoteCache[location].refs = findRefs(res, cOptions);

        // Filter out the references based on options.filter and options.subDocPath
        cacheEntry.refs = filterRefs(options, remoteCache[location].refs);
      }

      return cacheEntry;
    });

  return allTasks;
}

/**
 * Returns detailed information about the JSON Reference.
 *
 * @param {object} obj - The JSON Reference definition
 *
 * @returns {UnresolvedRefDetails} the detailed information
 *
 * @alias module:JsonRefs.getRefDetails
 */
function getRefDetails (obj) {
  var details = {
    def: obj
  };
  var cacheKey;
  var extraKeys;
  var uriDetails;

  try {
    if (isRefLike(obj, true)) {
      cacheKey = obj.$ref;
      uriDetails = uriDetailsCache[cacheKey];

      if (isType(uriDetails, 'Undefined')) {
        uriDetails = uriDetailsCache[cacheKey] = URI.parse(cacheKey);
      }

      details.uri = cacheKey;
      details.uriDetails = uriDetails;

      if (isType(uriDetails.error, 'Undefined')) {
        // Convert the URI reference to one of our types
        switch (uriDetails.reference) {
        case 'absolute':
        case 'uri':
          details.type = 'remote';
          break;
        case 'same-document':
          details.type = 'local';
          break;
        default:
          details.type = uriDetails.reference;
        }
      } else {
        details.error = details.uriDetails.error;
        details.type = 'invalid';
      }

      // Identify warning
      extraKeys = getExtraRefKeys(obj);

      if (extraKeys.length > 0) {
        details.warning = 'Extra JSON Reference properties will be ignored: ' + extraKeys.join(', ');
      }
    } else {
      details.type = 'invalid';
    }
  } catch (err) {
    details.error = err.message;
    details.type = 'invalid';
  }

  return details;
}

/**
 * Returns whether the argument represents a JSON Pointer.
 *
 * A string is a JSON Pointer if the following are all true:
 *
 *   * The string is of type `String`
 *   * The string must be empty, `#` or start with a `/` or `#/`
 *
 * @param {string} ptr - The string to check
 * @param {boolean} [throwWithDetails=false] - Whether or not to throw an `Error` with the details as to why the value
 * provided is invalid
 *
 * @returns {boolean} the result of the check
 *
 * @throws {error} when the provided value is invalid and the `throwWithDetails` argument is `true`
 *
 * @alias module:JsonRefs.isPtr
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 *
 * @example
 * // Separating the different ways to invoke isPtr for demonstration purposes
 * if (isPtr(str)) {
 *   // Handle a valid JSON Pointer
 * } else {
 *   // Get the reason as to why the value is not a JSON Pointer so you can fix/report it
 *   try {
 *     isPtr(str, true);
 *   } catch (err) {
 *     // The error message contains the details as to why the provided value is not a JSON Pointer
 *   }
 * }
 */
function isPtr (ptr, throwWithDetails) {
  var valid = true;
  var firstChar;

  try {
    if (isType(ptr, 'String')) {
      if (ptr !== '') {
        firstChar = ptr.charAt(0);

        if (['#', '/'].indexOf(firstChar) === -1) {
          throw new Error('ptr must start with a / or #/');
        } else if (firstChar === '#' && ptr !== '#' && ptr.charAt(1) !== '/') {
          throw new Error('ptr must start with a / or #/');
        } else if (ptr.match(badPtrTokenRegex)) {
          throw new Error('ptr has invalid token(s)');
        }
      }
    } else {
      throw new Error('ptr is not a String');
    }
  } catch (err) {
    if (throwWithDetails === true) {
      throw err;
    }

    valid = false;
  }

  return valid;
}

/**
 * Returns whether the argument represents a JSON Reference.
 *
 * An object is a JSON Reference only if the following are all true:
 *
 *   * The object is of type `Object`
 *   * The object has a `$ref` property
 *   * The `$ref` property is a valid URI
 *
 * @param {object} obj - The object to check
 * @param {boolean} [throwWithDetails=false] - Whether or not to throw an `Error` with the details as to why the value
 * provided is invalid
 *
 * @returns {boolean} the result of the check
 *
 * @throws {error} when the provided value is invalid and the `throwWithDetails` argument is `true`
 *
 * @alias module:JsonRefs.isRef
 *
 * @see {@link http://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03#section-3}
 *
 * @example
 * // Separating the different ways to invoke isRef for demonstration purposes
 * if (isRef(obj)) {
 *   // Handle a valid JSON Reference
 * } else {
 *   // Get the reason as to why the value is not a JSON Reference so you can fix/report it
 *   try {
 *     isRef(str, true);
 *   } catch (err) {
 *     // The error message contains the details as to why the provided value is not a JSON Reference
 *   }
 * }
 */
function isRef (obj, throwWithDetails) {
  return isRefLike(obj, throwWithDetails) && getRefDetails(obj, throwWithDetails).type !== 'invalid';
}

/**
 * Returns an array of path segments for the provided JSON Pointer.
 *
 * @param {string} ptr - The JSON Pointer
 *
 * @returns {string[]} the path segments
 *
 * @throws {Error} if the provided `ptr` argument is not a JSON Pointer
 *
 * @alias module:JsonRefs.pathFromPtr
 */
function pathFromPtr (ptr) {
  if (!isPtr(ptr)) {
    throw new Error('ptr must be a JSON Pointer');
  }

  var segments = ptr.split('/');

  // Remove the first segment
  segments.shift();

  return decodePath(segments);
}

/**
 * Returns a JSON Pointer for the provided array of path segments.
 *
 * **Note:** If a path segment in `path` is not a `String`, it will be converted to one using `JSON.stringify`.
 *
 * @param {string[]} path - The array of path segments
 * @param {boolean} [hashPrefix=true] - Whether or not create a hash-prefixed JSON Pointer
 *
 * @returns {string} the corresponding JSON Pointer
 *
 * @throws {Error} if the `path` argument is not an array
 *
 * @alias module:JsonRefs.pathToPtr
 */
function pathToPtr (path, hashPrefix) {
  if (!isType(path, 'Array')) {
    throw new Error('path must be an Array');
  }

  // Encode each segment and return
  return (hashPrefix !== false ? '#' : '') + (path.length > 0 ? '/' : '') + encodePath(path).join('/');
}

/**
 * Finds JSON References defined within the provided array/object and resolves them.
 *
 * @param {array|object} obj - The structure to find JSON References within
 * @param {JsonRefsOptions} [options] - The JsonRefs options
 *
 * @returns {Promise} a promise that resolves a {@link module:JsonRefs~ResolvedRefsResults} and rejects with an
 * `Error` when the input arguments fail validation, when `options.subDocPath` points to an invalid location or when
 *  the location argument points to an unloadable resource
 *
 * @alias module:JsonRefs.resolveRefs
 *
 * @example
 * // Example that only resolves relative and remote references
 * JsonRefs.resolveRefs(swaggerObj, {
 *     filter: ['relative', 'remote']
 *   })
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.resolved: The document with the appropriate JSON References resolved
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
function resolveRefs (obj, options) {
  var allTasks = Promise.resolve();

  allTasks = allTasks
    .then(function () {
      // Validate the provided document
      if (!isType(obj, 'Array') && !isType(obj, 'Object')) {
        throw new TypeError('obj must be an Array or an Object');
      }

      // Set default for options
      if (isType(options, 'Undefined')) {
        options = {};
      }

      // Validate options
      validateOptions(options);
    })
    .then(function () {
      // Find all references recursively
      return findAllRefs(obj, options, [], [], {});
    })
    .then(function (aRefs) {
      var cloned = clone(obj);
      var parentLocations = [];

      // Replace remote references first
      Object.keys(aRefs).forEach(function (refPtr) {
        var refDetails = aRefs[refPtr];
        var value;

        if (remoteTypes.indexOf(refDetails.type) > -1) {
          if (isType(refDetails.error, 'Undefined') && refDetails.type !== 'invalid') {
            try {
              value = findValue(refDetails.value || {},
                                refDetails.uriDetails.fragment ?
                                pathFromPtr(refDetails.uriDetails.fragment) :
                                  []);
              setValue(cloned, pathFromPtr(refPtr), value);

              // The reference includes a fragment so update the reference details
              if (!isType(refDetails.value, 'Undefined')) {
                refDetails.value = value;
              } else if (refDetails.circular) {
                // If there is no value and it's circular, set its value to an empty value
                refDetails.value = {};
              }
            } catch (err) {
              refDetails.error = err.message;
              refDetails.missing = true;
            }
          } else {
            refDetails.missing = true;
          }
        }
      });

      // Replace local references
      Object.keys(aRefs).forEach(function (refPtr) {
        var refDetails = aRefs[refPtr];
        var parentLocation = refDetails.parentLocation;
        var value;

        // Record that this reference has parent location details so we can clean it up later
        if (!isType(parentLocation, 'Undefined') && parentLocations.indexOf(refPtr) === -1) {
          parentLocations.push(refPtr);
        }

        if (remoteTypes.indexOf(refDetails.type) === -1 && refDetails.type !== 'invalid') {
          if (isType(refDetails.error, 'Undefined')) {
            if (refPtr.indexOf(refDetails.uri) > -1) {
              refDetails.circular = true;
              value = {};
            } else {
              if (!isType(parentLocation, 'Undefined')) {
                // Attempt to get the referenced value from the remote document first
                value = findValue(findValue(cloned, pathFromPtr(parentLocation)),
                                  refDetails.uriDetails.fragment ?
                                    pathFromPtr(refDetails.uriDetails.fragment) :
                                    [], true);
              }
            }

            try {
              if (isType(value, 'Undefined')) {
                value = findValue(cloned,
                                  refDetails.uriDetails.fragment ?
                                  pathFromPtr(refDetails.uriDetails.fragment) :
                                    []);
              }

              setValue(cloned, pathFromPtr(refPtr), value);

              refDetails.value = value;
            } catch (err) {
              refDetails.error = err.message;
              refDetails.missing = true;
            }
          } else {
            refDetails.missing = true;
          }
        }
      });

      // Remove all parentLocation values
      parentLocations.forEach(function (refPtr) {
        delete aRefs[refPtr].parentLocation;
      });

      return {
        refs: aRefs,
        resolved: cloned
      };
    });

  return allTasks;
}

/**
 * Resolves JSON References defined within the document at the provided location.
 *
 * This API is identical to {@link module:JsonRefs.resolveRefs} except this API will retrieve a remote document and then
 * return the result of {@link module:JsonRefs.resolveRefs} on the retrieved document.
 *
 * @param {string} location - The location to retrieve *(Can be relative or absolute, just make sure you look at the
 * {@link module:JsonRefs~JsonRefsOptions|options documentation} to see how relative references are handled.)*
 * @param {JsonRefsOptions} [options] - The JsonRefs options
 *
 * @returns {Promise} a promise that resolves a {@link module:JsonRefs~RetrievedResolvedRefsResults} and rejects with an
 * `Error` when the input arguments fail validation, when `options.subDocPath` points to an invalid location or when
 *  the location argument points to an unloadable resource
 *
 * @alias module:JsonRefs.resolveRefsAt
 *
 * @example
 * // Example that loads a JSON document (No options.loaderOptions.processContent required) and resolves all references
 * JsonRefs.resolveRefsAt('./swagger.json')
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.resolved: The document with the appropriate JSON References resolved
 *      // res.value: The retrieved document
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
function resolveRefsAt (location, options) {
  var allTasks = Promise.resolve();

  allTasks = allTasks
    .then(function () {
      // Validate the provided location
      if (!isType(location, 'String')) {
        throw new TypeError('location must be a string');
      }

      // Set default for options
      if (isType(options, 'Undefined')) {
        options = {};
      }

      // Validate options (Doing this here for a quick)
      validateOptions(options);

      // Combine the location and the optional relative base
      location = combineURIs(options.relativeBase, location);

      return getRemoteDocument(location, options);
    })
    .then(function (res) {
      var cOptions = clone(options);

      // Update the relative base based on the retrieved location
      cOptions.relativeBase = dirname(location);

      return resolveRefs(res, cOptions)
        .then(function (res2) {
          return {
            refs: res2.refs,
            resolved: res2.resolved,
            value: res
          };
        });
    });

  return allTasks;
}

/* Export the module members */
module.exports.clearCache = clearCache;
module.exports.decodePath = decodePath;
module.exports.encodePath = encodePath;
module.exports.findRefs = findRefs;
module.exports.findRefsAt = findRefsAt;
module.exports.getRefDetails = getRefDetails;
module.exports.isPtr = isPtr;
module.exports.isRef = isRef;
module.exports.pathFromPtr = pathFromPtr;
module.exports.pathToPtr = pathToPtr;
module.exports.resolveRefs = resolveRefs;
module.exports.resolveRefsAt = resolveRefsAt;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"native-promise-only":2,"path":3,"querystring":7,"slash":8,"uri-js":14}],2:[function(require,module,exports){
(function (global){
/*! Native Promise Only
    v0.8.1 (c) Kyle Simpson
    MIT License: http://getify.mit-license.org
*/

(function UMD(name,context,definition){
	// special form of UMD for polyfilling across evironments
	context[name] = context[name] || definition();
	if (typeof module != "undefined" && module.exports) { module.exports = context[name]; }
	else if (typeof define == "function" && define.amd) { define(function $AMD$(){ return context[name]; }); }
})("Promise",typeof global != "undefined" ? global : this,function DEF(){
	/*jshint validthis:true */
	"use strict";

	var builtInProp, cycle, scheduling_queue,
		ToString = Object.prototype.toString,
		timer = (typeof setImmediate != "undefined") ?
			function timer(fn) { return setImmediate(fn); } :
			setTimeout
	;

	// dammit, IE8.
	try {
		Object.defineProperty({},"x",{});
		builtInProp = function builtInProp(obj,name,val,config) {
			return Object.defineProperty(obj,name,{
				value: val,
				writable: true,
				configurable: config !== false
			});
		};
	}
	catch (err) {
		builtInProp = function builtInProp(obj,name,val) {
			obj[name] = val;
			return obj;
		};
	}

	// Note: using a queue instead of array for efficiency
	scheduling_queue = (function Queue() {
		var first, last, item;

		function Item(fn,self) {
			this.fn = fn;
			this.self = self;
			this.next = void 0;
		}

		return {
			add: function add(fn,self) {
				item = new Item(fn,self);
				if (last) {
					last.next = item;
				}
				else {
					first = item;
				}
				last = item;
				item = void 0;
			},
			drain: function drain() {
				var f = first;
				first = last = cycle = void 0;

				while (f) {
					f.fn.call(f.self);
					f = f.next;
				}
			}
		};
	})();

	function schedule(fn,self) {
		scheduling_queue.add(fn,self);
		if (!cycle) {
			cycle = timer(scheduling_queue.drain);
		}
	}

	// promise duck typing
	function isThenable(o) {
		var _then, o_type = typeof o;

		if (o != null &&
			(
				o_type == "object" || o_type == "function"
			)
		) {
			_then = o.then;
		}
		return typeof _then == "function" ? _then : false;
	}

	function notify() {
		for (var i=0; i<this.chain.length; i++) {
			notifyIsolated(
				this,
				(this.state === 1) ? this.chain[i].success : this.chain[i].failure,
				this.chain[i]
			);
		}
		this.chain.length = 0;
	}

	// NOTE: This is a separate function to isolate
	// the `try..catch` so that other code can be
	// optimized better
	function notifyIsolated(self,cb,chain) {
		var ret, _then;
		try {
			if (cb === false) {
				chain.reject(self.msg);
			}
			else {
				if (cb === true) {
					ret = self.msg;
				}
				else {
					ret = cb.call(void 0,self.msg);
				}

				if (ret === chain.promise) {
					chain.reject(TypeError("Promise-chain cycle"));
				}
				else if (_then = isThenable(ret)) {
					_then.call(ret,chain.resolve,chain.reject);
				}
				else {
					chain.resolve(ret);
				}
			}
		}
		catch (err) {
			chain.reject(err);
		}
	}

	function resolve(msg) {
		var _then, self = this;

		// already triggered?
		if (self.triggered) { return; }

		self.triggered = true;

		// unwrap
		if (self.def) {
			self = self.def;
		}

		try {
			if (_then = isThenable(msg)) {
				schedule(function(){
					var def_wrapper = new MakeDefWrapper(self);
					try {
						_then.call(msg,
							function $resolve$(){ resolve.apply(def_wrapper,arguments); },
							function $reject$(){ reject.apply(def_wrapper,arguments); }
						);
					}
					catch (err) {
						reject.call(def_wrapper,err);
					}
				})
			}
			else {
				self.msg = msg;
				self.state = 1;
				if (self.chain.length > 0) {
					schedule(notify,self);
				}
			}
		}
		catch (err) {
			reject.call(new MakeDefWrapper(self),err);
		}
	}

	function reject(msg) {
		var self = this;

		// already triggered?
		if (self.triggered) { return; }

		self.triggered = true;

		// unwrap
		if (self.def) {
			self = self.def;
		}

		self.msg = msg;
		self.state = 2;
		if (self.chain.length > 0) {
			schedule(notify,self);
		}
	}

	function iteratePromises(Constructor,arr,resolver,rejecter) {
		for (var idx=0; idx<arr.length; idx++) {
			(function IIFE(idx){
				Constructor.resolve(arr[idx])
				.then(
					function $resolver$(msg){
						resolver(idx,msg);
					},
					rejecter
				);
			})(idx);
		}
	}

	function MakeDefWrapper(self) {
		this.def = self;
		this.triggered = false;
	}

	function MakeDef(self) {
		this.promise = self;
		this.state = 0;
		this.triggered = false;
		this.chain = [];
		this.msg = void 0;
	}

	function Promise(executor) {
		if (typeof executor != "function") {
			throw TypeError("Not a function");
		}

		if (this.__NPO__ !== 0) {
			throw TypeError("Not a promise");
		}

		// instance shadowing the inherited "brand"
		// to signal an already "initialized" promise
		this.__NPO__ = 1;

		var def = new MakeDef(this);

		this["then"] = function then(success,failure) {
			var o = {
				success: typeof success == "function" ? success : true,
				failure: typeof failure == "function" ? failure : false
			};
			// Note: `then(..)` itself can be borrowed to be used against
			// a different promise constructor for making the chained promise,
			// by substituting a different `this` binding.
			o.promise = new this.constructor(function extractChain(resolve,reject) {
				if (typeof resolve != "function" || typeof reject != "function") {
					throw TypeError("Not a function");
				}

				o.resolve = resolve;
				o.reject = reject;
			});
			def.chain.push(o);

			if (def.state !== 0) {
				schedule(notify,def);
			}

			return o.promise;
		};
		this["catch"] = function $catch$(failure) {
			return this.then(void 0,failure);
		};

		try {
			executor.call(
				void 0,
				function publicResolve(msg){
					resolve.call(def,msg);
				},
				function publicReject(msg) {
					reject.call(def,msg);
				}
			);
		}
		catch (err) {
			reject.call(def,err);
		}
	}

	var PromisePrototype = builtInProp({},"constructor",Promise,
		/*configurable=*/false
	);

	// Note: Android 4 cannot use `Object.defineProperty(..)` here
	Promise.prototype = PromisePrototype;

	// built-in "brand" to signal an "uninitialized" promise
	builtInProp(PromisePrototype,"__NPO__",0,
		/*configurable=*/false
	);

	builtInProp(Promise,"resolve",function Promise$resolve(msg) {
		var Constructor = this;

		// spec mandated checks
		// note: best "isPromise" check that's practical for now
		if (msg && typeof msg == "object" && msg.__NPO__ === 1) {
			return msg;
		}

		return new Constructor(function executor(resolve,reject){
			if (typeof resolve != "function" || typeof reject != "function") {
				throw TypeError("Not a function");
			}

			resolve(msg);
		});
	});

	builtInProp(Promise,"reject",function Promise$reject(msg) {
		return new this(function executor(resolve,reject){
			if (typeof resolve != "function" || typeof reject != "function") {
				throw TypeError("Not a function");
			}

			reject(msg);
		});
	});

	builtInProp(Promise,"all",function Promise$all(arr) {
		var Constructor = this;

		// spec mandated checks
		if (ToString.call(arr) != "[object Array]") {
			return Constructor.reject(TypeError("Not an array"));
		}
		if (arr.length === 0) {
			return Constructor.resolve([]);
		}

		return new Constructor(function executor(resolve,reject){
			if (typeof resolve != "function" || typeof reject != "function") {
				throw TypeError("Not a function");
			}

			var len = arr.length, msgs = Array(len), count = 0;

			iteratePromises(Constructor,arr,function resolver(idx,msg) {
				msgs[idx] = msg;
				if (++count === len) {
					resolve(msgs);
				}
			},reject);
		});
	});

	builtInProp(Promise,"race",function Promise$race(arr) {
		var Constructor = this;

		// spec mandated checks
		if (ToString.call(arr) != "[object Array]") {
			return Constructor.reject(TypeError("Not an array"));
		}

		return new Constructor(function executor(resolve,reject){
			if (typeof resolve != "function" || typeof reject != "function") {
				throw TypeError("Not a function");
			}

			iteratePromises(Constructor,arr,function resolver(idx,msg){
				resolve(msg);
			},reject);
		});
	});

	return Promise;
});

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],3:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))

},{"_process":4}],4:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],5:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],6:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],7:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":5,"./encode":6}],8:[function(require,module,exports){
'use strict';
module.exports = function (str) {
	var isExtendedLengthPath = /^\\\\\?\\/.test(str);
	var hasNonAscii = /[^\x00-\x80]+/.test(str);

	if (isExtendedLengthPath || hasNonAscii) {
		return str;
	}

	return str.replace(/\\/g, '/');
};

},{}],9:[function(require,module,exports){
/*! https://mths.be/punycode v1.3.2 by @mathias, modified for URI.js */

var punycode = (function () {

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		version: '1.3.2',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		ucs2: {
			decode: ucs2decode,
			encode: ucs2encode
		},
		decode: decode,
		encode: encode,
		toASCII: toASCII,
		toUnicode: toUnicode
	};

	return punycode;
}());

if (typeof COMPILED === "undefined" && typeof module !== "undefined") module.exports = punycode;
},{}],10:[function(require,module,exports){
///<reference path="commonjs.d.ts"/>
require("./schemes/http");
require("./schemes/urn");
require("./schemes/mailto");

},{"./schemes/http":11,"./schemes/mailto":12,"./schemes/urn":13}],11:[function(require,module,exports){
///<reference path="../uri.ts"/>
if (typeof COMPILED === "undefined" && typeof URI === "undefined" && typeof require === "function")
    var URI = require("../uri");
URI.SCHEMES["http"] = URI.SCHEMES["https"] = {
    domainHost: true,
    parse: function (components, options) {
        //report missing host
        if (!components.host) {
            components.error = components.error || "HTTP URIs must have a host.";
        }
        return components;
    },
    serialize: function (components, options) {
        //normalize the default port
        if (components.port === (String(components.scheme).toLowerCase() !== "https" ? 80 : 443) || components.port === "") {
            components.port = undefined;
        }
        //normalize the empty path
        if (!components.path) {
            components.path = "/";
        }
        //NOTE: We do not parse query strings for HTTP URIs
        //as WWW Form Url Encoded query strings are part of the HTML4+ spec,
        //and not the HTTP spec. 
        return components;
    }
};

},{"../uri":14}],12:[function(require,module,exports){
///<reference path="../uri.ts"/>
if (typeof COMPILED === "undefined" && typeof URI === "undefined" && typeof require === "function") {
    var URI = require("../uri"), punycode = require("../punycode");
}
(function () {
    function merge() {
        var sets = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            sets[_i - 0] = arguments[_i];
        }
        if (sets.length > 1) {
            sets[0] = sets[0].slice(0, -1);
            var xl = sets.length - 1;
            for (var x = 1; x < xl; ++x) {
                sets[x] = sets[x].slice(1, -1);
            }
            sets[xl] = sets[xl].slice(1);
            return sets.join('');
        }
        else {
            return sets[0];
        }
    }
    function subexp(str) {
        return "(?:" + str + ")";
    }
    var O = {}, isIRI = URI.IRI_SUPPORT, 
    //RFC 3986
    UNRESERVED$$ = "[A-Za-z0-9\\-\\.\\_\\~" + (isIRI ? "\\xA0-\\u200D\\u2010-\\u2029\\u202F-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF" : "") + "]", HEXDIG$$ = "[0-9A-Fa-f]", PCT_ENCODED$ = subexp(subexp("%[EFef]" + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$) + "|" + subexp("%[89A-Fa-f]" + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$) + "|" + subexp("%" + HEXDIG$$ + HEXDIG$$)), 
    //RFC 5322, except these symbols as per RFC 6068: @ : / ? # [ ] & ; = 
    //ATEXT$$ = "[A-Za-z0-9\\!\\#\\$\\%\\&\\'\\*\\+\\-\\/\\=\\?\\^\\_\\`\\{\\|\\}\\~]",
    //WSP$$ = "[\\x20\\x09]",
    //OBS_QTEXT$$ = "[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]",  //(%d1-8 / %d11-12 / %d14-31 / %d127)
    //QTEXT$$ = merge("[\\x21\\x23-\\x5B\\x5D-\\x7E]", OBS_QTEXT$$),  //%d33 / %d35-91 / %d93-126 / obs-qtext
    //VCHAR$$ = "[\\x21-\\x7E]",
    //WSP$$ = "[\\x20\\x09]",
    //OBS_QP$ = subexp("\\\\" + merge("[\\x00\\x0D\\x0A]", OBS_QTEXT$$)),  //%d0 / CR / LF / obs-qtext
    //FWS$ = subexp(subexp(WSP$$ + "*" + "\\x0D\\x0A") + "?" + WSP$$ + "+"),
    //QUOTED_PAIR$ = subexp(subexp("\\\\" + subexp(VCHAR$$ + "|" + WSP$$)) + "|" + OBS_QP$),
    //QUOTED_STRING$ = subexp('\\"' + subexp(FWS$ + "?" + QCONTENT$) + "*" + FWS$ + "?" + '\\"'),
    ATEXT$$ = "[A-Za-z0-9\\!\\$\\%\\'\\*\\+\\-\\^\\_\\`\\{\\|\\}\\~]", QTEXT$$ = "[\\!\\$\\%\\'\\(\\)\\*\\+\\,\\-\\.0-9\\<\\>A-Z\\x5E-\\x7E]", VCHAR$$ = merge(QTEXT$$, "[\\\"\\\\]"), DOT_ATOM_TEXT$ = subexp(ATEXT$$ + "+" + subexp("\\." + ATEXT$$ + "+") + "*"), QUOTED_PAIR$ = subexp("\\\\" + VCHAR$$), QCONTENT$ = subexp(QTEXT$$ + "|" + QUOTED_PAIR$), QUOTED_STRING$ = subexp('\\"' + QCONTENT$ + "*" + '\\"'), 
    //RFC 6068
    DTEXT_NO_OBS$$ = "[\\x21-\\x5A\\x5E-\\x7E]", SOME_DELIMS$$ = "[\\!\\$\\'\\(\\)\\*\\+\\,\\;\\:\\@]", QCHAR$ = subexp(UNRESERVED$$ + "|" + PCT_ENCODED$ + "|" + SOME_DELIMS$$), DOMAIN$ = subexp(DOT_ATOM_TEXT$ + "|" + "\\[" + DTEXT_NO_OBS$$ + "*" + "\\]"), LOCAL_PART$ = subexp(DOT_ATOM_TEXT$ + "|" + QUOTED_STRING$), ADDR_SPEC$ = subexp(LOCAL_PART$ + "\\@" + DOMAIN$), TO$ = subexp(ADDR_SPEC$ + subexp("\\," + ADDR_SPEC$) + "*"), HFNAME$ = subexp(QCHAR$ + "*"), HFVALUE$ = HFNAME$, HFIELD$ = subexp(HFNAME$ + "\\=" + HFVALUE$), HFIELDS2$ = subexp(HFIELD$ + subexp("\\&" + HFIELD$) + "*"), HFIELDS$ = subexp("\\?" + HFIELDS2$), MAILTO_URI = URI.VALIDATE_SUPPORT && new RegExp("^mailto\\:" + TO$ + "?" + HFIELDS$ + "?$"), UNRESERVED = new RegExp(UNRESERVED$$, "g"), PCT_ENCODED = new RegExp(PCT_ENCODED$, "g"), NOT_LOCAL_PART = new RegExp(merge("[^]", ATEXT$$, "[\\.]", '[\\"]', VCHAR$$), "g"), NOT_DOMAIN = new RegExp(merge("[^]", ATEXT$$, "[\\.]", "[\\[]", DTEXT_NO_OBS$$, "[\\]]"), "g"), NOT_HFNAME = new RegExp(merge("[^]", UNRESERVED$$, SOME_DELIMS$$), "g"), NOT_HFVALUE = NOT_HFNAME, TO = URI.VALIDATE_SUPPORT && new RegExp("^" + TO$ + "$"), HFIELDS = URI.VALIDATE_SUPPORT && new RegExp("^" + HFIELDS2$ + "$");
    function toUpperCase(str) {
        return str.toUpperCase();
    }
    function decodeUnreserved(str) {
        var decStr = URI.pctDecChars(str);
        return (!decStr.match(UNRESERVED) ? str : decStr);
    }
    function toArray(obj) {
        return obj !== undefined && obj !== null ? (obj instanceof Array && !obj.callee ? obj : (typeof obj.length !== "number" || obj.split || obj.setInterval || obj.call ? [obj] : Array.prototype.slice.call(obj))) : [];
    }
    URI.SCHEMES["mailto"] = {
        parse: function (components, options) {
            if (URI.VALIDATE_SUPPORT && !components.error) {
                if (components.path && !TO.test(components.path)) {
                    components.error = "Email address is not valid";
                }
                else if (components.query && !HFIELDS.test(components.query)) {
                    components.error = "Header fields are invalid";
                }
            }
            var to = components.to = (components.path ? components.path.split(",") : []);
            components.path = undefined;
            if (components.query) {
                var unknownHeaders = false, headers = {};
                var hfields = components.query.split("&");
                for (var x = 0, xl = hfields.length; x < xl; ++x) {
                    var hfield = hfields[x].split("=");
                    switch (hfield[0]) {
                        case "to":
                            var toAddrs = hfield[1].split(",");
                            for (var x_1 = 0, xl_1 = toAddrs.length; x_1 < xl_1; ++x_1) {
                                to.push(toAddrs[x_1]);
                            }
                            break;
                        case "subject":
                            components.subject = URI.unescapeComponent(hfield[1], options);
                            break;
                        case "body":
                            components.body = URI.unescapeComponent(hfield[1], options);
                            break;
                        default:
                            unknownHeaders = true;
                            headers[URI.unescapeComponent(hfield[0], options)] = URI.unescapeComponent(hfield[1], options);
                            break;
                    }
                }
                if (unknownHeaders)
                    components.headers = headers;
            }
            components.query = undefined;
            for (var x = 0, xl = to.length; x < xl; ++x) {
                var addr = to[x].split("@");
                addr[0] = URI.unescapeComponent(addr[0]);
                if (typeof punycode !== "undefined" && !options.unicodeSupport) {
                    //convert Unicode IDN -> ASCII IDN
                    try {
                        addr[1] = punycode.toASCII(URI.unescapeComponent(addr[1], options).toLowerCase());
                    }
                    catch (e) {
                        components.error = components.error || "Email address's domain name can not be converted to ASCII via punycode: " + e;
                    }
                }
                else {
                    addr[1] = URI.unescapeComponent(addr[1], options).toLowerCase();
                }
                to[x] = addr.join("@");
            }
            return components;
        },
        serialize: function (components, options) {
            var to = toArray(components.to);
            if (to) {
                for (var x = 0, xl = to.length; x < xl; ++x) {
                    var toAddr = String(to[x]);
                    var atIdx = toAddr.lastIndexOf("@");
                    var localPart = toAddr.slice(0, atIdx);
                    var domain = toAddr.slice(atIdx + 1);
                    localPart = localPart.replace(PCT_ENCODED, decodeUnreserved).replace(PCT_ENCODED, toUpperCase).replace(NOT_LOCAL_PART, URI.pctEncChar);
                    if (typeof punycode !== "undefined") {
                        //convert IDN via punycode
                        try {
                            domain = (!options.iri ? punycode.toASCII(URI.unescapeComponent(domain, options).toLowerCase()) : punycode.toUnicode(domain));
                        }
                        catch (e) {
                            components.error = components.error || "Email address's domain name can not be converted to " + (!options.iri ? "ASCII" : "Unicode") + " via punycode: " + e;
                        }
                    }
                    else {
                        domain = domain.replace(PCT_ENCODED, decodeUnreserved).toLowerCase().replace(PCT_ENCODED, toUpperCase).replace(NOT_DOMAIN, URI.pctEncChar);
                    }
                    to[x] = localPart + "@" + domain;
                }
                components.path = to.join(",");
            }
            var headers = components.headers = components.headers || {};
            if (components.subject)
                headers["subject"] = components.subject;
            if (components.body)
                headers["body"] = components.body;
            var fields = [];
            for (var name_1 in headers) {
                if (headers[name_1] !== O[name_1]) {
                    fields.push(name_1.replace(PCT_ENCODED, decodeUnreserved).replace(PCT_ENCODED, toUpperCase).replace(NOT_HFNAME, URI.pctEncChar) +
                        "=" +
                        headers[name_1].replace(PCT_ENCODED, decodeUnreserved).replace(PCT_ENCODED, toUpperCase).replace(NOT_HFVALUE, URI.pctEncChar));
                }
            }
            if (fields.length) {
                components.query = fields.join("&");
            }
            return components;
        }
    };
})();

},{"../punycode":9,"../uri":14}],13:[function(require,module,exports){
///<reference path="../uri.ts"/>
if (typeof COMPILED === "undefined" && typeof URI === "undefined" && typeof require === "function")
    var URI = require("../uri");
(function () {
    var pctEncChar = URI.pctEncChar, NID$ = "(?:[0-9A-Za-z][0-9A-Za-z\\-]{1,31})", PCT_ENCODED$ = "(?:\\%[0-9A-Fa-f]{2})", TRANS$$ = "[0-9A-Za-z\\(\\)\\+\\,\\-\\.\\:\\=\\@\\;\\$\\_\\!\\*\\'\\/\\?\\#]", NSS$ = "(?:(?:" + PCT_ENCODED$ + "|" + TRANS$$ + ")+)", URN_SCHEME = new RegExp("^urn\\:(" + NID$ + ")$"), URN_PATH = new RegExp("^(" + NID$ + ")\\:(" + NSS$ + ")$"), URN_PARSE = /^([^\:]+)\:(.*)/, URN_EXCLUDED = /[\x00-\x20\\\"\&\<\>\[\]\^\`\{\|\}\~\x7F-\xFF]/g, UUID = /^[0-9A-Fa-f]{8}(?:\-[0-9A-Fa-f]{4}){3}\-[0-9A-Fa-f]{12}$/;
    //RFC 2141
    URI.SCHEMES["urn"] = {
        parse: function (components, options) {
            var matches = components.path.match(URN_PATH), scheme, schemeHandler;
            if (!matches) {
                if (!options.tolerant) {
                    components.error = components.error || "URN is not strictly valid.";
                }
                matches = components.path.match(URN_PARSE);
            }
            if (matches) {
                scheme = "urn:" + matches[1].toLowerCase();
                schemeHandler = URI.SCHEMES[scheme];
                //in order to serialize properly, 
                //every URN must have a serializer that calls the URN serializer 
                if (!schemeHandler) {
                    //create fake scheme handler
                    schemeHandler = URI.SCHEMES[scheme] = {
                        parse: function (components, options) {
                            return components;
                        },
                        serialize: URI.SCHEMES["urn"].serialize
                    };
                }
                components.scheme = scheme;
                components.path = matches[2];
                components = schemeHandler.parse(components, options);
            }
            else {
                components.error = components.error || "URN can not be parsed.";
            }
            return components;
        },
        serialize: function (components, options) {
            var scheme = components.scheme || options.scheme, matches;
            if (scheme && scheme !== "urn") {
                var matches = scheme.match(URN_SCHEME);
                if (!matches) {
                    matches = ["urn:" + scheme, scheme];
                }
                components.scheme = "urn";
                components.path = matches[1] + ":" + (components.path ? components.path.replace(URN_EXCLUDED, pctEncChar) : "");
            }
            return components;
        }
    };
    //RFC 4122
    URI.SCHEMES["urn:uuid"] = {
        parse: function (components, options) {
            if (!options.tolerant && (!components.path || !components.path.match(UUID))) {
                components.error = components.error || "UUID is not valid.";
            }
            return components;
        },
        serialize: function (components, options) {
            //ensure UUID is valid
            if (!options.tolerant && (!components.path || !components.path.match(UUID))) {
                //invalid UUIDs can not have this scheme
                components.scheme = undefined;
            }
            else {
                //normalize UUID
                components.path = (components.path || "").toLowerCase();
            }
            return URI.SCHEMES["urn"].serialize(components, options);
        }
    };
}());

},{"../uri":14}],14:[function(require,module,exports){
/**
 * URI.js
 *
 * @fileoverview An RFC 3986 compliant, scheme extendable URI parsing/validating/resolving library for JavaScript.
 * @author <a href="mailto:gary.court@gmail.com">Gary Court</a>
 * @version 2.0.0
 * @see http://github.com/garycourt/uri-js
 * @license URI.js v2.0.0 (c) 2011 Gary Court. License: http://github.com/garycourt/uri-js
 */
/**
 * Copyright 2011 Gary Court. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are
 * permitted provided that the following conditions are met:
 *
 *    1. Redistributions of source code must retain the above copyright notice, this list of
 *       conditions and the following disclaimer.
 *
 *    2. Redistributions in binary form must reproduce the above copyright notice, this list
 *       of conditions and the following disclaimer in the documentation and/or other materials
 *       provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY GARY COURT ``AS IS'' AND ANY EXPRESS OR IMPLIED
 * WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL GARY COURT OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * The views and conclusions contained in the software and documentation are those of the
 * authors and should not be interpreted as representing official policies, either expressed
 * or implied, of Gary Court.
 */
///<reference path="punycode.d.ts"/>
///<reference path="commonjs.d.ts"/>
/**
 * Compiler switch for indicating code is compiled
 * @define {boolean}
 */
var COMPILED = false;
/**
 * Compiler switch for supporting IRI URIs
 * @define {boolean}
 */
var URI__IRI_SUPPORT = true;
/**
 * Compiler switch for supporting URI validation
 * @define {boolean}
 */
var URI__VALIDATE_SUPPORT = true;
var URI = (function () {
    function merge() {
        var sets = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            sets[_i - 0] = arguments[_i];
        }
        if (sets.length > 1) {
            sets[0] = sets[0].slice(0, -1);
            var xl = sets.length - 1;
            for (var x = 1; x < xl; ++x) {
                sets[x] = sets[x].slice(1, -1);
            }
            sets[xl] = sets[xl].slice(1);
            return sets.join('');
        }
        else {
            return sets[0];
        }
    }
    function subexp(str) {
        return "(?:" + str + ")";
    }
    function buildExps(isIRI) {
        var ALPHA$$ = "[A-Za-z]", CR$ = "[\\x0D]", DIGIT$$ = "[0-9]", DQUOTE$$ = "[\\x22]", HEXDIG$$ = merge(DIGIT$$, "[A-Fa-f]"), LF$$ = "[\\x0A]", SP$$ = "[\\x20]", PCT_ENCODED$ = subexp(subexp("%[EFef]" + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$) + "|" + subexp("%[89A-Fa-f]" + HEXDIG$$ + "%" + HEXDIG$$ + HEXDIG$$) + "|" + subexp("%" + HEXDIG$$ + HEXDIG$$)), GEN_DELIMS$$ = "[\\:\\/\\?\\#\\[\\]\\@]", SUB_DELIMS$$ = "[\\!\\$\\&\\'\\(\\)\\*\\+\\,\\;\\=]", RESERVED$$ = merge(GEN_DELIMS$$, SUB_DELIMS$$), UCSCHAR$$ = isIRI ? "[\\xA0-\\u200D\\u2010-\\u2029\\u202F-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF]" : "[]", IPRIVATE$$ = isIRI ? "[\\uE000-\\uF8FF]" : "[]", UNRESERVED$$ = merge(ALPHA$$, DIGIT$$, "[\\-\\.\\_\\~]", UCSCHAR$$), SCHEME$ = subexp(ALPHA$$ + merge(ALPHA$$, DIGIT$$, "[\\+\\-\\.]") + "*"), USERINFO$ = subexp(subexp(PCT_ENCODED$ + "|" + merge(UNRESERVED$$, SUB_DELIMS$$, "[\\:]")) + "*"), DEC_OCTET$ = subexp(subexp("25[0-5]") + "|" + subexp("2[0-4]" + DIGIT$$) + "|" + subexp("1" + DIGIT$$ + DIGIT$$) + "|" + subexp("[1-9]" + DIGIT$$) + "|" + DIGIT$$), IPV4ADDRESS$ = subexp(DEC_OCTET$ + "\\." + DEC_OCTET$ + "\\." + DEC_OCTET$ + "\\." + DEC_OCTET$), H16$ = subexp(HEXDIG$$ + "{1,4}"), LS32$ = subexp(subexp(H16$ + "\\:" + H16$) + "|" + IPV4ADDRESS$), IPV6ADDRESS$ = subexp(merge(UNRESERVED$$, SUB_DELIMS$$, "[\\:]") + "+"), IPVFUTURE$ = subexp("v" + HEXDIG$$ + "+\\." + merge(UNRESERVED$$, SUB_DELIMS$$, "[\\:]") + "+"), IP_LITERAL$ = subexp("\\[" + subexp(IPV6ADDRESS$ + "|" + IPVFUTURE$) + "\\]"), REG_NAME$ = subexp(subexp(PCT_ENCODED$ + "|" + merge(UNRESERVED$$, SUB_DELIMS$$)) + "*"), HOST$ = subexp(IP_LITERAL$ + "|" + IPV4ADDRESS$ + "(?!" + REG_NAME$ + ")" + "|" + REG_NAME$), PORT$ = subexp(DIGIT$$ + "*"), AUTHORITY$ = subexp(subexp(USERINFO$ + "@") + "?" + HOST$ + subexp("\\:" + PORT$) + "?"), PCHAR$ = subexp(PCT_ENCODED$ + "|" + merge(UNRESERVED$$, SUB_DELIMS$$, "[\\:\\@]")), SEGMENT$ = subexp(PCHAR$ + "*"), SEGMENT_NZ$ = subexp(PCHAR$ + "+"), SEGMENT_NZ_NC$ = subexp(subexp(PCT_ENCODED$ + "|" + merge(UNRESERVED$$, SUB_DELIMS$$, "[\\@]")) + "+"), PATH_ABEMPTY$ = subexp(subexp("\\/" + SEGMENT$) + "*"), PATH_ABSOLUTE$ = subexp("\\/" + subexp(SEGMENT_NZ$ + PATH_ABEMPTY$) + "?"), PATH_NOSCHEME$ = subexp(SEGMENT_NZ_NC$ + PATH_ABEMPTY$), PATH_ROOTLESS$ = subexp(SEGMENT_NZ$ + PATH_ABEMPTY$), PATH_EMPTY$ = "(?!" + PCHAR$ + ")", PATH$ = subexp(PATH_ABEMPTY$ + "|" + PATH_ABSOLUTE$ + "|" + PATH_NOSCHEME$ + "|" + PATH_ROOTLESS$ + "|" + PATH_EMPTY$), QUERY$ = subexp(subexp(PCHAR$ + "|" + merge("[\\/\\?]", IPRIVATE$$)) + "*"), FRAGMENT$ = subexp(subexp(PCHAR$ + "|[\\/\\?]") + "*"), HIER_PART$ = subexp(subexp("\\/\\/" + AUTHORITY$ + PATH_ABEMPTY$) + "|" + PATH_ABSOLUTE$ + "|" + PATH_ROOTLESS$ + "|" + PATH_EMPTY$), URI$ = subexp(SCHEME$ + "\\:" + HIER_PART$ + subexp("\\?" + QUERY$) + "?" + subexp("\\#" + FRAGMENT$) + "?"), RELATIVE_PART$ = subexp(subexp("\\/\\/" + AUTHORITY$ + PATH_ABEMPTY$) + "|" + PATH_ABSOLUTE$ + "|" + PATH_NOSCHEME$ + "|" + PATH_EMPTY$), RELATIVE$ = subexp(RELATIVE_PART$ + subexp("\\?" + QUERY$) + "?" + subexp("\\#" + FRAGMENT$) + "?"), URI_REFERENCE$ = subexp(URI$ + "|" + RELATIVE$), ABSOLUTE_URI$ = subexp(SCHEME$ + "\\:" + HIER_PART$ + subexp("\\?" + QUERY$) + "?"), GENERIC_REF$ = "^(" + SCHEME$ + ")\\:" + subexp(subexp("\\/\\/(" + subexp("(" + USERINFO$ + ")@") + "?(" + HOST$ + ")" + subexp("\\:(" + PORT$ + ")") + "?)") + "?(" + PATH_ABEMPTY$ + "|" + PATH_ABSOLUTE$ + "|" + PATH_ROOTLESS$ + "|" + PATH_EMPTY$ + ")") + subexp("\\?(" + QUERY$ + ")") + "?" + subexp("\\#(" + FRAGMENT$ + ")") + "?$", RELATIVE_REF$ = "^(){0}" + subexp(subexp("\\/\\/(" + subexp("(" + USERINFO$ + ")@") + "?(" + HOST$ + ")" + subexp("\\:(" + PORT$ + ")") + "?)") + "?(" + PATH_ABEMPTY$ + "|" + PATH_ABSOLUTE$ + "|" + PATH_NOSCHEME$ + "|" + PATH_EMPTY$ + ")") + subexp("\\?(" + QUERY$ + ")") + "?" + subexp("\\#(" + FRAGMENT$ + ")") + "?$", ABSOLUTE_REF$ = "^(" + SCHEME$ + ")\\:" + subexp(subexp("\\/\\/(" + subexp("(" + USERINFO$ + ")@") + "?(" + HOST$ + ")" + subexp("\\:(" + PORT$ + ")") + "?)") + "?(" + PATH_ABEMPTY$ + "|" + PATH_ABSOLUTE$ + "|" + PATH_ROOTLESS$ + "|" + PATH_EMPTY$ + ")") + subexp("\\?(" + QUERY$ + ")") + "?$", SAMEDOC_REF$ = "^" + subexp("\\#(" + FRAGMENT$ + ")") + "?$", AUTHORITY_REF$ = "^" + subexp("(" + USERINFO$ + ")@") + "?(" + HOST$ + ")" + subexp("\\:(" + PORT$ + ")") + "?$";
        return {
            URI_REF: URI__VALIDATE_SUPPORT && new RegExp("(" + GENERIC_REF$ + ")|(" + RELATIVE_REF$ + ")"),
            NOT_SCHEME: new RegExp(merge("[^]", ALPHA$$, DIGIT$$, "[\\+\\-\\.]"), "g"),
            NOT_USERINFO: new RegExp(merge("[^\\%\\:]", UNRESERVED$$, SUB_DELIMS$$), "g"),
            NOT_HOST: new RegExp(merge("[^\\%]", UNRESERVED$$, SUB_DELIMS$$), "g"),
            NOT_PATH: new RegExp(merge("[^\\%\\/\\:\\@]", UNRESERVED$$, SUB_DELIMS$$), "g"),
            NOT_PATH_NOSCHEME: new RegExp(merge("[^\\%\\/\\@]", UNRESERVED$$, SUB_DELIMS$$), "g"),
            NOT_QUERY: new RegExp(merge("[^\\%]", UNRESERVED$$, SUB_DELIMS$$, "[\\:\\@\\/\\?]", IPRIVATE$$), "g"),
            NOT_FRAGMENT: new RegExp(merge("[^\\%]", UNRESERVED$$, SUB_DELIMS$$, "[\\:\\@\\/\\?]"), "g"),
            ESCAPE: new RegExp(merge("[^]", UNRESERVED$$, SUB_DELIMS$$), "g"),
            UNRESERVED: new RegExp(UNRESERVED$$, "g"),
            OTHER_CHARS: new RegExp(merge("[^\\%]", UNRESERVED$$, RESERVED$$), "g"),
            PCT_ENCODED: new RegExp(PCT_ENCODED$, "g")
        };
    }
    var URI_PROTOCOL = buildExps(false), IRI_PROTOCOL = URI__IRI_SUPPORT ? buildExps(true) : undefined, URI_PARSE = /^(?:([^:\/?#]+):)?(?:\/\/((?:([^\/?#@]*)@)?([^\/?#:]*)(?:\:(\d*))?))?([^?#]*)(?:\?([^#]*))?(?:#((?:.|\n)*))?/i, RDS1 = /^\.\.?\//, RDS2 = /^\/\.(\/|$)/, RDS3 = /^\/\.\.(\/|$)/, RDS4 = /^\.\.?$/, RDS5 = /^\/?(?:.|\n)*?(?=\/|$)/, NO_MATCH_IS_UNDEFINED = ("").match(/(){0}/)[1] === undefined;
    function pctEncChar(chr) {
        var c = chr.charCodeAt(0), e;
        if (c < 16)
            e = "%0" + c.toString(16).toUpperCase();
        else if (c < 128)
            e = "%" + c.toString(16).toUpperCase();
        else if (c < 2048)
            e = "%" + ((c >> 6) | 192).toString(16).toUpperCase() + "%" + ((c & 63) | 128).toString(16).toUpperCase();
        else
            e = "%" + ((c >> 12) | 224).toString(16).toUpperCase() + "%" + (((c >> 6) & 63) | 128).toString(16).toUpperCase() + "%" + ((c & 63) | 128).toString(16).toUpperCase();
        return e;
    }
    function pctDecChars(str) {
        var newStr = "", i = 0, il = str.length, c, c2, c3;
        while (i < il) {
            c = parseInt(str.substr(i + 1, 2), 16);
            if (c < 128) {
                newStr += String.fromCharCode(c);
                i += 3;
            }
            else if (c >= 194 && c < 224) {
                if ((il - i) >= 6) {
                    c2 = parseInt(str.substr(i + 4, 2), 16);
                    newStr += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
                }
                else {
                    newStr += str.substr(i, 6);
                }
                i += 6;
            }
            else if (c >= 224) {
                if ((il - i) >= 9) {
                    c2 = parseInt(str.substr(i + 4, 2), 16);
                    c3 = parseInt(str.substr(i + 7, 2), 16);
                    newStr += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
                }
                else {
                    newStr += str.substr(i, 9);
                }
                i += 9;
            }
            else {
                newStr += str.substr(i, 3);
                i += 3;
            }
        }
        return newStr;
    }
    function typeOf(o) {
        return o === undefined ? "undefined" : (o === null ? "null" : Object.prototype.toString.call(o).split(" ").pop().split("]").shift().toLowerCase());
    }
    function toUpperCase(str) {
        return str.toUpperCase();
    }
    var SCHEMES = {};
    function _normalizeComponentEncoding(components, protocol) {
        function decodeUnreserved(str) {
            var decStr = pctDecChars(str);
            return (!decStr.match(protocol.UNRESERVED) ? str : decStr);
        }
        if (components.scheme)
            components.scheme = String(components.scheme).replace(protocol.PCT_ENCODED, decodeUnreserved).toLowerCase().replace(protocol.NOT_SCHEME, "");
        if (components.userinfo !== undefined)
            components.userinfo = String(components.userinfo).replace(protocol.PCT_ENCODED, decodeUnreserved).replace(protocol.NOT_USERINFO, pctEncChar).replace(protocol.PCT_ENCODED, toUpperCase);
        if (components.host !== undefined)
            components.host = String(components.host).replace(protocol.PCT_ENCODED, decodeUnreserved).toLowerCase().replace(protocol.NOT_HOST, pctEncChar).replace(protocol.PCT_ENCODED, toUpperCase);
        if (components.path !== undefined)
            components.path = String(components.path).replace(protocol.PCT_ENCODED, decodeUnreserved).replace((components.scheme ? protocol.NOT_PATH : protocol.NOT_PATH_NOSCHEME), pctEncChar).replace(protocol.PCT_ENCODED, toUpperCase);
        if (components.query !== undefined)
            components.query = String(components.query).replace(protocol.PCT_ENCODED, decodeUnreserved).replace(protocol.NOT_QUERY, pctEncChar).replace(protocol.PCT_ENCODED, toUpperCase);
        if (components.fragment !== undefined)
            components.fragment = String(components.fragment).replace(protocol.PCT_ENCODED, decodeUnreserved).replace(protocol.NOT_FRAGMENT, pctEncChar).replace(protocol.PCT_ENCODED, toUpperCase);
        return components;
    }
    ;
    function parse(uriString, options) {
        if (options === void 0) { options = {}; }
        var protocol = (URI__IRI_SUPPORT && options.iri !== false ? IRI_PROTOCOL : URI_PROTOCOL), matches, parseError = false, components = {}, schemeHandler;
        if (options.reference === "suffix")
            uriString = (options.scheme ? options.scheme + ":" : "") + "//" + uriString;
        if (URI__VALIDATE_SUPPORT) {
            matches = uriString.match(protocol.URI_REF);
            if (matches) {
                if (matches[1]) {
                    //generic URI
                    matches = matches.slice(1, 10);
                }
                else {
                    //relative URI
                    matches = matches.slice(10, 19);
                }
            }
            if (!matches) {
                parseError = true;
                if (!options.tolerant)
                    components.error = components.error || "URI is not strictly valid.";
                matches = uriString.match(URI_PARSE);
            }
        }
        else {
            matches = uriString.match(URI_PARSE);
        }
        if (matches) {
            if (NO_MATCH_IS_UNDEFINED) {
                //store each component
                components.scheme = matches[1];
                //components.authority = matches[2];
                components.userinfo = matches[3];
                components.host = matches[4];
                components.port = parseInt(matches[5], 10);
                components.path = matches[6] || "";
                components.query = matches[7];
                components.fragment = matches[8];
                //fix port number
                if (isNaN(components.port)) {
                    components.port = matches[5];
                }
            }
            else {
                //store each component
                components.scheme = matches[1] || undefined;
                //components.authority = (uriString.indexOf("//") !== -1 ? matches[2] : undefined);
                components.userinfo = (uriString.indexOf("@") !== -1 ? matches[3] : undefined);
                components.host = (uriString.indexOf("//") !== -1 ? matches[4] : undefined);
                components.port = parseInt(matches[5], 10);
                components.path = matches[6] || "";
                components.query = (uriString.indexOf("?") !== -1 ? matches[7] : undefined);
                components.fragment = (uriString.indexOf("#") !== -1 ? matches[8] : undefined);
                //fix port number
                if (isNaN(components.port)) {
                    components.port = (uriString.match(/\/\/(?:.|\n)*\:(?:\/|\?|\#|$)/) ? matches[4] : undefined);
                }
            }
            //determine reference type
            if (components.scheme === undefined && components.userinfo === undefined && components.host === undefined && components.port === undefined && !components.path && components.query === undefined) {
                components.reference = "same-document";
            }
            else if (components.scheme === undefined) {
                components.reference = "relative";
            }
            else if (components.fragment === undefined) {
                components.reference = "absolute";
            }
            else {
                components.reference = "uri";
            }
            //check for reference errors
            if (options.reference && options.reference !== "suffix" && options.reference !== components.reference) {
                components.error = components.error || "URI is not a " + options.reference + " reference.";
            }
            //find scheme handler
            schemeHandler = SCHEMES[(options.scheme || components.scheme || "").toLowerCase()];
            //check if scheme can't handle IRIs
            if (URI__IRI_SUPPORT && typeof punycode !== "undefined" && !options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
                //if host component is a domain name
                if (components.host && (options.domainHost || (schemeHandler && schemeHandler.domainHost))) {
                    //convert Unicode IDN -> ASCII IDN
                    try {
                        components.host = punycode.toASCII(components.host.replace(protocol.PCT_ENCODED, pctDecChars).toLowerCase());
                    }
                    catch (e) {
                        components.error = components.error || "Host's domain name can not be converted to ASCII via punycode: " + e;
                    }
                }
                //convert IRI -> URI
                _normalizeComponentEncoding(components, URI_PROTOCOL);
            }
            else {
                //normalize encodings
                _normalizeComponentEncoding(components, protocol);
            }
            //perform scheme specific parsing
            if (schemeHandler && schemeHandler.parse) {
                schemeHandler.parse(components, options);
            }
        }
        else {
            parseError = true;
            components.error = components.error || "URI can not be parsed.";
        }
        return components;
    }
    ;
    function _recomposeAuthority(components, options) {
        var uriTokens = [];
        if (components.userinfo !== undefined) {
            uriTokens.push(components.userinfo);
            uriTokens.push("@");
        }
        if (components.host !== undefined) {
            uriTokens.push(components.host);
        }
        if (typeof components.port === "number") {
            uriTokens.push(":");
            uriTokens.push(components.port.toString(10));
        }
        return uriTokens.length ? uriTokens.join("") : undefined;
    }
    ;
    function removeDotSegments(input) {
        var output = [], s;
        while (input.length) {
            if (input.match(RDS1)) {
                input = input.replace(RDS1, "");
            }
            else if (input.match(RDS2)) {
                input = input.replace(RDS2, "/");
            }
            else if (input.match(RDS3)) {
                input = input.replace(RDS3, "/");
                output.pop();
            }
            else if (input === "." || input === "..") {
                input = "";
            }
            else {
                s = input.match(RDS5)[0];
                input = input.slice(s.length);
                output.push(s);
            }
        }
        return output.join("");
    }
    ;
    function serialize(components, options) {
        if (options === void 0) { options = {}; }
        var protocol = (URI__IRI_SUPPORT && options.iri ? IRI_PROTOCOL : URI_PROTOCOL), uriTokens = [], schemeHandler, authority, s;
        //find scheme handler
        schemeHandler = SCHEMES[(options.scheme || components.scheme || "").toLowerCase()];
        //perform scheme specific serialization
        if (schemeHandler && schemeHandler.serialize)
            schemeHandler.serialize(components, options);
        //if host component is a domain name
        if (URI__IRI_SUPPORT && typeof punycode !== "undefined" && components.host && (options.domainHost || (schemeHandler && schemeHandler.domainHost))) {
            //convert IDN via punycode
            try {
                components.host = (!options.iri ? punycode.toASCII(components.host.replace(protocol.PCT_ENCODED, pctDecChars).toLowerCase()) : punycode.toUnicode(components.host));
            }
            catch (e) {
                components.error = components.error || "Host's domain name can not be converted to " + (!options.iri ? "ASCII" : "Unicode") + " via punycode: " + e;
            }
        }
        //normalize encoding
        _normalizeComponentEncoding(components, protocol);
        if (options.reference !== "suffix" && components.scheme) {
            uriTokens.push(components.scheme);
            uriTokens.push(":");
        }
        authority = _recomposeAuthority(components, options);
        if (authority !== undefined) {
            if (options.reference !== "suffix") {
                uriTokens.push("//");
            }
            uriTokens.push(authority);
            if (components.path && components.path.charAt(0) !== "/") {
                uriTokens.push("/");
            }
        }
        if (components.path !== undefined) {
            s = components.path;
            if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
                s = removeDotSegments(s);
            }
            if (authority === undefined) {
                s = s.replace(/^\/\//, "/%2F"); //don't allow the path to start with "//"
            }
            uriTokens.push(s);
        }
        if (components.query !== undefined) {
            uriTokens.push("?");
            uriTokens.push(components.query);
        }
        if (components.fragment !== undefined) {
            uriTokens.push("#");
            uriTokens.push(components.fragment);
        }
        return uriTokens.join(''); //merge tokens into a string
    }
    ;
    function resolveComponents(base, relative, options, skipNormalization) {
        if (options === void 0) { options = {}; }
        var target = {};
        if (!skipNormalization) {
            base = parse(serialize(base, options), options); //normalize base components
            relative = parse(serialize(relative, options), options); //normalize relative components
        }
        options = options || {};
        if (!options.tolerant && relative.scheme) {
            target.scheme = relative.scheme;
            //target.authority = relative.authority;
            target.userinfo = relative.userinfo;
            target.host = relative.host;
            target.port = relative.port;
            target.path = removeDotSegments(relative.path);
            target.query = relative.query;
        }
        else {
            if (relative.userinfo !== undefined || relative.host !== undefined || relative.port !== undefined) {
                //target.authority = relative.authority;
                target.userinfo = relative.userinfo;
                target.host = relative.host;
                target.port = relative.port;
                target.path = removeDotSegments(relative.path);
                target.query = relative.query;
            }
            else {
                if (!relative.path) {
                    target.path = base.path;
                    if (relative.query !== undefined) {
                        target.query = relative.query;
                    }
                    else {
                        target.query = base.query;
                    }
                }
                else {
                    if (relative.path.charAt(0) === "/") {
                        target.path = removeDotSegments(relative.path);
                    }
                    else {
                        if ((base.userinfo !== undefined || base.host !== undefined || base.port !== undefined) && !base.path) {
                            target.path = "/" + relative.path;
                        }
                        else if (!base.path) {
                            target.path = relative.path;
                        }
                        else {
                            target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
                        }
                        target.path = removeDotSegments(target.path);
                    }
                    target.query = relative.query;
                }
                //target.authority = base.authority;
                target.userinfo = base.userinfo;
                target.host = base.host;
                target.port = base.port;
            }
            target.scheme = base.scheme;
        }
        target.fragment = relative.fragment;
        return target;
    }
    ;
    function resolve(baseURI, relativeURI, options) {
        return serialize(resolveComponents(parse(baseURI, options), parse(relativeURI, options), options, true), options);
    }
    ;
    function normalize(uri, options) {
        if (typeof uri === "string") {
            uri = serialize(parse(uri, options), options);
        }
        else if (typeOf(uri) === "object") {
            uri = parse(serialize(uri, options), options);
        }
        return uri;
    }
    ;
    function equal(uriA, uriB, options) {
        if (typeof uriA === "string") {
            uriA = serialize(parse(uriA, options), options);
        }
        else if (typeOf(uriA) === "object") {
            uriA = serialize(uriA, options);
        }
        if (typeof uriB === "string") {
            uriB = serialize(parse(uriB, options), options);
        }
        else if (typeOf(uriB) === "object") {
            uriB = serialize(uriB, options);
        }
        return uriA === uriB;
    }
    ;
    function escapeComponent(str, options) {
        return str && str.toString().replace((!URI__IRI_SUPPORT || !options || !options.iri ? URI_PROTOCOL.ESCAPE : IRI_PROTOCOL.ESCAPE), pctEncChar);
    }
    ;
    function unescapeComponent(str, options) {
        return str && str.toString().replace((!URI__IRI_SUPPORT || !options || !options.iri ? URI_PROTOCOL.PCT_ENCODED : IRI_PROTOCOL.PCT_ENCODED), pctDecChars);
    }
    ;
    return {
        IRI_SUPPORT: URI__IRI_SUPPORT,
        VALIDATE_SUPPORT: URI__VALIDATE_SUPPORT,
        pctEncChar: pctEncChar,
        pctDecChars: pctDecChars,
        SCHEMES: SCHEMES,
        parse: parse,
        _recomposeAuthority: _recomposeAuthority,
        removeDotSegments: removeDotSegments,
        serialize: serialize,
        resolveComponents: resolveComponents,
        resolve: resolve,
        normalize: normalize,
        equal: equal,
        escapeComponent: escapeComponent,
        unescapeComponent: unescapeComponent
    };
})();
if (!COMPILED && typeof module !== "undefined" && typeof require === "function") {
    var punycode = require("./punycode");
    module.exports = URI;
    require("./schemes");
}

},{"./punycode":9,"./schemes":10}]},{},[1])(1)
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJpbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9uYXRpdmUtcHJvbWlzZS1vbmx5L2xpYi9ucG8uc3JjLmpzIiwibm9kZV9tb2R1bGVzL3BhdGgtYnJvd3NlcmlmeS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcXVlcnlzdHJpbmctZXMzL2RlY29kZS5qcyIsIm5vZGVfbW9kdWxlcy9xdWVyeXN0cmluZy1lczMvZW5jb2RlLmpzIiwibm9kZV9tb2R1bGVzL3F1ZXJ5c3RyaW5nLWVzMy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zbGFzaC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy91cmktanMvYnVpbGQvcHVueWNvZGUuanMiLCJub2RlX21vZHVsZXMvdXJpLWpzL2J1aWxkL3NjaGVtZXMuanMiLCJub2RlX21vZHVsZXMvdXJpLWpzL2J1aWxkL3NjaGVtZXMvaHR0cC5qcyIsIm5vZGVfbW9kdWxlcy91cmktanMvYnVpbGQvc2NoZW1lcy9tYWlsdG8uanMiLCJub2RlX21vZHVsZXMvdXJpLWpzL2J1aWxkL3NjaGVtZXMvdXJuLmpzIiwibm9kZV9tb2R1bGVzL3VyaS1qcy9idWlsZC91cmkuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ3J4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNyWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDaE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKlxuICogQ29weXJpZ2h0IChjKSAyMDE0IEplcmVteSBXaGl0bG9ja1xuICpcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcbiAqXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKlxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKi9cblxuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAqIFZhcmlvdXMgdXRpbGl0aWVzIGZvciBKU09OIFJlZmVyZW5jZXMgKihodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1wYnJ5YW4tenlwLWpzb24tcmVmLTAzKSogYW5kXG4gKiBKU09OIFBvaW50ZXJzICooaHR0cHM6Ly90b29scy5pZXRmLm9yZy9odG1sL3JmYzY5MDEpKi5cbiAqXG4gKiBAbW9kdWxlIEpzb25SZWZzXG4gKi9cblxudmFyIGRpcm5hbWUgPSByZXF1aXJlKCdwYXRoJykuZGlybmFtZTtcbnZhciBwYXRoTG9hZGVyID0gKHR5cGVvZiB3aW5kb3cgIT09IFwidW5kZWZpbmVkXCIgPyB3aW5kb3dbJ1BhdGhMb2FkZXInXSA6IHR5cGVvZiBnbG9iYWwgIT09IFwidW5kZWZpbmVkXCIgPyBnbG9iYWxbJ1BhdGhMb2FkZXInXSA6IG51bGwpO1xudmFyIHFzID0gcmVxdWlyZSgncXVlcnlzdHJpbmcnKTtcbnZhciBzbGFzaCA9IHJlcXVpcmUoJ3NsYXNoJyk7XG52YXIgVVJJID0gcmVxdWlyZSgndXJpLWpzJyk7XG5cbnZhciBiYWRQdHJUb2tlblJlZ2V4ID0gL34oPzpbXjAxXXwkKS9nO1xudmFyIHJlbW90ZUNhY2hlID0ge307XG52YXIgcmVtb3RlVHlwZXMgPSBbJ3JlbGF0aXZlJywgJ3JlbW90ZSddO1xudmFyIHVyaURldGFpbHNDYWNoZSA9IHt9O1xuXG4vLyBMb2FkIHByb21pc2VzIHBvbHlmaWxsIGlmIG5lY2Vzc2FyeVxuLyogaXN0YW5idWwgaWdub3JlIGlmICovXG5pZiAodHlwZW9mIFByb21pc2UgPT09ICd1bmRlZmluZWQnKSB7XG4gIHJlcXVpcmUoJ25hdGl2ZS1wcm9taXNlLW9ubHknKTtcbn1cblxuLyogSW50ZXJuYWwgRnVuY3Rpb25zICovXG5cbi8vIFRoaXMgaXMgYSB2ZXJ5IHNpbXBsaXN0aWMgY2xvbmUgZnVuY3Rpb24gdGhhdCBkb2VzIG5vdCB0YWtlIGludG8gYWNjb3VudCBub24tSlNPTiB0eXBlcy4gIEZvciB0aGVzZSB0eXBlcyB0aGVcbi8vIG9yaWdpbmFsIHZhbHVlIGlzIHVzZWQgYXMgdGhlIGNsb25lLiAgU28gd2hpbGUgaXQncyBub3QgYSBjb21wbGV0ZSBkZWVwIGNsb25lLCBmb3IgdGhlIG5lZWRzIG9mIHRoaXMgcHJvamVjdFxuLy8gdGhpcyBzaG91bGQgYmUgc3VmZmljaWVudC5cbmZ1bmN0aW9uIGNsb25lIChvYmopIHtcbiAgdmFyIGNsb25lZDtcblxuICBpZiAoaXNUeXBlKG9iaiwgJ0FycmF5JykpIHtcbiAgICBjbG9uZWQgPSBbXTtcblxuICAgIG9iai5mb3JFYWNoKGZ1bmN0aW9uICh2YWx1ZSwgaW5kZXgpIHtcbiAgICAgIGNsb25lZFtpbmRleF0gPSBjbG9uZSh2YWx1ZSk7XG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoaXNUeXBlKG9iaiwgJ09iamVjdCcpKSB7XG4gICAgY2xvbmVkID0ge307XG5cbiAgICBPYmplY3Qua2V5cyhvYmopLmZvckVhY2goZnVuY3Rpb24gKGtleSkge1xuICAgICAgY2xvbmVkW2tleV0gPSBjbG9uZShvYmpba2V5XSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgY2xvbmVkID0gb2JqO1xuICB9XG5cbiAgcmV0dXJuIGNsb25lZDtcbn1cblxuZnVuY3Rpb24gY29tYmluZVBhdGhzIChwMSwgcDIpIHtcbiAgdmFyIGNvbWJpbmVkID0gW107XG5cbiAgZnVuY3Rpb24gcGF0aFRvU2VnbWVudHMgKHBhdGgpIHtcbiAgICByZXR1cm4gaXNUeXBlKHBhdGgsICdVbmRlZmluZWQnKSB8fCBwYXRoID09PSAnJyA/IFtdIDogcGF0aC5zcGxpdCgnLycpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlU2VnbWVudCAoc2VnKSB7XG4gICAgaWYgKHNlZyA9PT0gJy4uJykge1xuICAgICAgY29tYmluZWQucG9wKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbWJpbmVkLnB1c2goc2VnKTtcbiAgICB9XG4gIH1cblxuICBwYXRoVG9TZWdtZW50cyhwMSkuY29uY2F0KHBhdGhUb1NlZ21lbnRzKHAyKSkuZm9yRWFjaChoYW5kbGVTZWdtZW50KTtcblxuICByZXR1cm4gY29tYmluZWQubGVuZ3RoID09PSAwID8gJycgOiBjb21iaW5lZC5qb2luKCcvJyk7XG59XG5cbmZ1bmN0aW9uIGNvbWJpbmVRdWVyeVBhcmFtcyAocXMxLCBxczIpIHtcbiAgdmFyIGNvbWJpbmVkID0ge307XG5cbiAgZnVuY3Rpb24gbWVyZ2VRdWVyeVBhcmFtcyAob2JqKSB7XG4gICAgT2JqZWN0LmtleXMob2JqKS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHtcbiAgICAgIGNvbWJpbmVkW2tleV0gPSBvYmpba2V5XTtcbiAgICB9KTtcbiAgfVxuXG4gIG1lcmdlUXVlcnlQYXJhbXMocXMucGFyc2UocXMxIHx8ICcnKSk7XG4gIG1lcmdlUXVlcnlQYXJhbXMocXMucGFyc2UocXMyIHx8ICcnKSk7XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKGNvbWJpbmVkKS5sZW5ndGggPT09IDAgPyB1bmRlZmluZWQgOiBxcy5zdHJpbmdpZnkoY29tYmluZWQpO1xufVxuXG5mdW5jdGlvbiBjb21iaW5lVVJJcyAodTEsIHUyKSB7XG4gIC8vIENvbnZlcnQgV2luZG93cyBwYXRoc1xuICBpZiAoaXNUeXBlKHUxLCAnU3RyaW5nJykpIHtcbiAgICB1MSA9IHNsYXNoKHUxKTtcbiAgfVxuXG4gIGlmIChpc1R5cGUodTIsICdTdHJpbmcnKSkge1xuICAgIHUyID0gc2xhc2godTIpO1xuICB9XG5cbiAgdmFyIHUyRGV0YWlscyA9IFVSSS5wYXJzZShpc1R5cGUodTIsICdVbmRlZmluZWQnKSA/ICcnIDogdTIpO1xuICB2YXIgdTFEZXRhaWxzO1xuICB2YXIgY29tYmluZWREZXRhaWxzO1xuXG4gIGlmICh1MkRldGFpbHMucmVmZXJlbmNlID09PSAnYWJzb2x1dGUnIHx8IHUyRGV0YWlscy5yZWZlcmVuY2UgPT09ICd1cmknKSB7XG4gICAgY29tYmluZWREZXRhaWxzID0gdTJEZXRhaWxzO1xuICB9IGVsc2Uge1xuICAgIHUxRGV0YWlscyA9IGlzVHlwZSh1MSwgJ1VuZGVmaW5lZCcpID8gdW5kZWZpbmVkIDogVVJJLnBhcnNlKHUxKTtcblxuICAgIGlmICghaXNUeXBlKHUxRGV0YWlscywgJ1VuZGVmaW5lZCcpKSB7XG4gICAgICBjb21iaW5lZERldGFpbHMgPSB1MURldGFpbHM7XG5cbiAgICAgIC8vIEpvaW4gdGhlIHBhdGhzXG4gICAgICBjb21iaW5lZERldGFpbHMucGF0aCA9IFVSSS5ub3JtYWxpemUoY29tYmluZVBhdGhzKHUxRGV0YWlscy5wYXRoLCB1MkRldGFpbHMucGF0aCkpO1xuXG4gICAgICAvLyBKb2luIHF1ZXJ5IHBhcmFtZXRlcnNcbiAgICAgIGNvbWJpbmVkRGV0YWlscy5xdWVyeSA9IGNvbWJpbmVRdWVyeVBhcmFtcyh1MURldGFpbHMucXVlcnksIHUyRGV0YWlscy5xdWVyeSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbWJpbmVkRGV0YWlscyA9IHUyRGV0YWlscztcbiAgICB9XG4gIH1cblxuICAvLyBSZW1vdmUgdGhlIGZyYWdtZW50XG4gIGNvbWJpbmVkRGV0YWlscy5mcmFnbWVudCA9IHVuZGVmaW5lZDtcblxuICByZXR1cm4gVVJJLnNlcmlhbGl6ZShjb21iaW5lZERldGFpbHMpO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJSZWZzIChvcHRpb25zLCByZWZzKSB7XG4gIHZhciByZWZGaWx0ZXIgPSBtYWtlUmVmRmlsdGVyKG9wdGlvbnMpO1xuICB2YXIgZmlsdGVyZWQgPSB7fTtcbiAgdmFyIHN1YkRvY1ByZWZpeCA9IHBhdGhUb1B0cihtYWtlU3ViRG9jUGF0aChvcHRpb25zKSk7XG5cbiAgT2JqZWN0LmtleXMocmVmcykuZm9yRWFjaChmdW5jdGlvbiAocmVmUHRyKSB7XG4gICAgdmFyIHJlZkRldGFpbHMgPSByZWZzW3JlZlB0cl07XG5cbiAgICBpZiAocmVmRmlsdGVyKHJlZkRldGFpbHMsIHBhdGhGcm9tUHRyKHJlZlB0cikpID09PSB0cnVlICYmXG4gICAgICAgIHJlZlB0ci5pbmRleE9mKHN1YkRvY1ByZWZpeCkgPiAtMSAmJlxuICAgICAgICAocmVmRGV0YWlscy50eXBlICE9PSAnaW52YWxpZCcgfHwgb3B0aW9ucy5pbmNsdWRlSW52YWxpZCA9PT0gdHJ1ZSkpIHtcbiAgICAgIGZpbHRlcmVkW3JlZlB0cl0gPSByZWZEZXRhaWxzO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIGZpbHRlcmVkO1xufVxuXG5mdW5jdGlvbiBmaW5kQW5jZXN0b3JzIChvYmosIHBhdGgpIHtcbiAgdmFyIGFuY2VzdG9ycyA9IFtdO1xuICB2YXIgbm9kZSA9IG9iajtcblxuICBwYXRoLnNsaWNlKDAsIHBhdGgubGVuZ3RoIC0gMSkuZm9yRWFjaChmdW5jdGlvbiAoc2VnKSB7XG4gICAgaWYgKHNlZyBpbiBub2RlKSB7XG4gICAgICBub2RlID0gbm9kZVtzZWddO1xuXG4gICAgICBhbmNlc3RvcnMucHVzaChub2RlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBhbmNlc3RvcnM7XG59XG5cbi8vIFNob3VsZCB0aGlzIGJlIGl0cyBvd24gZXhwb3J0ZWQgQVBJP1xuZnVuY3Rpb24gZmluZEFsbFJlZnMgKG9iaiwgb3B0aW9ucywgcGFyZW50cywgcGFyZW50UGF0aCwgZG9jdW1lbnRzKSB7XG4gIHZhciBhbGxUYXNrcyA9IFByb21pc2UucmVzb2x2ZSgpO1xuICB2YXIgcmVmcyA9IGZpbmRSZWZzKG9iaiwgb3B0aW9ucyk7XG5cbiAgT2JqZWN0LmtleXMocmVmcykuZm9yRWFjaChmdW5jdGlvbiAocmVmUHRyKSB7XG4gICAgdmFyIHJlZkRldGFpbHMgPSByZWZzW3JlZlB0cl07XG4gICAgdmFyIHJlZlBhdGggPSBwYXRoRnJvbVB0cihyZWZQdHIpO1xuICAgIHZhciBsb2NhdGlvbjtcbiAgICB2YXIgcGFyZW50SW5kZXg7XG5cbiAgICAvLyBPbmx5IHByb2Nlc3MgcmVtb3RlIHJlZmVyZW5jZXNcbiAgICBpZiAocmVtb3RlVHlwZXMuaW5kZXhPZihyZWZEZXRhaWxzLnR5cGUpID4gLTEpIHtcbiAgICAgIGxvY2F0aW9uID0gY29tYmluZVVSSXMob3B0aW9ucy5yZWxhdGl2ZUJhc2UsIHJlZkRldGFpbHMudXJpKTtcbiAgICAgIHBhcmVudEluZGV4ID0gcGFyZW50cy5pbmRleE9mKGxvY2F0aW9uKTtcblxuICAgICAgaWYgKHBhcmVudEluZGV4ID09PSAtMSkge1xuICAgICAgICBhbGxUYXNrcyA9IGFsbFRhc2tzXG4gICAgICAgICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHJQYXJlbnRQYXRoID0gcGFyZW50UGF0aC5jb25jYXQocmVmUGF0aCk7XG4gICAgICAgICAgICB2YXIgck9wdGlvbnMgPSBjbG9uZShvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gUmVtb3ZlIHRoZSBzdWIgZG9jdW1lbnQgcGF0aFxuICAgICAgICAgICAgZGVsZXRlIHJPcHRpb25zLnN1YkRvY1BhdGg7XG5cbiAgICAgICAgICAgIC8vIFJlbW92ZSB0aGUgcmVsYXRpdmUgYmFzZVxuICAgICAgICAgICAgZGVsZXRlIHJPcHRpb25zLnJlbGF0aXZlQmFzZTtcblxuICAgICAgICAgICAgcmV0dXJuIGZpbmRSZWZzQXQobG9jYXRpb24sIHJPcHRpb25zKVxuICAgICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoclJlZnMpIHtcbiAgICAgICAgICAgICAgICAvLyBSZWNvcmQgdGhlIGxvY2F0aW9uIGZvciBjaXJjdWxhciByZWZlcmVuY2UgaWRlbnRpZmljYXRpb25cbiAgICAgICAgICAgICAgICByUmVmcy5sb2NhdGlvbiA9IGxvY2F0aW9uO1xuXG4gICAgICAgICAgICAgICAgaWYgKHJlZkRldGFpbHMudXJpRGV0YWlscy5mcmFnbWVudCkge1xuICAgICAgICAgICAgICAgICAgLy8gSWYgdGhlIHJlbW90ZSByZWZlcmVuY2Ugd2FzIGZvciBhIGZyYWdtZW50LCBkbyBub3QgaW5jbHVkZSB0aGUgcmVmZXJlbmNlIGRldGFpbHNcbiAgICAgICAgICAgICAgICAgIHJSZWZzLnJlZnMgPSB7fTtcblxuICAgICAgICAgICAgICAgICAgLy8gUmVjb3JkIHRoZSByZW1vdGUgZG9jdW1lbnRcbiAgICAgICAgICAgICAgICAgIGRvY3VtZW50c1twYXRoVG9QdHIoclBhcmVudFBhdGgpXSA9IHJSZWZzO1xuXG4gICAgICAgICAgICAgICAgICByZXR1cm4gclJlZnM7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIC8vIFJlY29yZCB0aGUgbG9jYXRpb24gaW4gdGhlIGRvY3VtZW50IHdoZXJlIHRoZSBwYXJlbnQgZG9jdW1lbnQgd2FzIHJlc29sdmVkXG4gICAgICAgICAgICAgICAgICBPYmplY3Qua2V5cyhyUmVmcy5yZWZzKS5mb3JFYWNoKGZ1bmN0aW9uIChyZWZQdHIpIHtcbiAgICAgICAgICAgICAgICAgICAgclJlZnMucmVmc1tyZWZQdHJdLnBhcmVudExvY2F0aW9uID0gcGF0aFRvUHRyKHJQYXJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAvLyBSZWNvcmQgdGhlIHJlbW90ZSBkb2N1bWVudFxuICAgICAgICAgICAgICAgICAgZG9jdW1lbnRzW3BhdGhUb1B0cihyUGFyZW50UGF0aCldID0gclJlZnM7XG5cbiAgICAgICAgICAgICAgICAgIC8vIFVwZGF0ZSB0aGUgcmVsYXRpdmUgYmFzZSBiYXNlZCBvbiB0aGUgcmV0cmlldmVkIGxvY2F0aW9uXG4gICAgICAgICAgICAgICAgICByT3B0aW9ucy5yZWxhdGl2ZUJhc2UgPSBkaXJuYW1lKGxvY2F0aW9uKTtcblxuICAgICAgICAgICAgICAgICAgLy8gRmluZCBhbGwgaW1wb3J0YW50IHJlZmVyZW5jZXMgd2l0aGluIHRoZSBkb2N1bWVudFxuICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpbmRBbGxSZWZzKHJSZWZzLnZhbHVlLCByT3B0aW9ucywgcGFyZW50cy5jb25jYXQobG9jYXRpb24pLCByUGFyZW50UGF0aCwgZG9jdW1lbnRzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZWZEZXRhaWxzLmVycm9yID0gZXJyLm1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgcmVmRGV0YWlscy5taXNzaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBNYXJrIHNlZW4gYW5jZXN0b3JzIGFzIGNpcmN1bGFyXG4gICAgICAgIHBhcmVudHMuc2xpY2UocGFyZW50SW5kZXgpLmZvckVhY2goZnVuY3Rpb24gKHBhcmVudCkge1xuICAgICAgICAgIE9iamVjdC5rZXlzKGRvY3VtZW50cykuZm9yRWFjaChmdW5jdGlvbiAoY1JlZlB0cikge1xuICAgICAgICAgICAgdmFyIGRvY3VtZW50ID0gZG9jdW1lbnRzW2NSZWZQdHJdO1xuXG4gICAgICAgICAgICBpZiAoZG9jdW1lbnQubG9jYXRpb24gPT09IHBhcmVudCkge1xuICAgICAgICAgICAgICBkb2N1bWVudC5jaXJjdWxhciA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIE1hcmsgc2VsZiBhcyBjaXJjdWxhclxuICAgICAgICBkb2N1bWVudHNbcGF0aFRvUHRyKHBhcmVudFBhdGgpXS5yZWZzW3JlZlB0cl0uY2lyY3VsYXIgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgYWxsVGFza3MgPSBhbGxUYXNrc1xuICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgIC8vIE9ubHkgY29sbGFwc2UgdGhlIGRvY3VtZW50cyB3aGVuIHdlJ3JlIGJhY2sgYXQgdGhlIHRvcCBvZiB0aGUgcHJvbWlzZSBzdGFja1xuICAgICAgaWYgKHBhcmVudFBhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIENvbGxhcHNlIGFsbCByZWZlcmVuY2VzIHRvZ2V0aGVyIGludG8gb25lIGxpc3RcbiAgICAgICAgT2JqZWN0LmtleXMoZG9jdW1lbnRzKS5mb3JFYWNoKGZ1bmN0aW9uIChyZWZQdHIpIHtcbiAgICAgICAgICB2YXIgZG9jdW1lbnQgPSBkb2N1bWVudHNbcmVmUHRyXTtcblxuICAgICAgICAgIC8vIE1lcmdlIGVhY2ggcmVmZXJlbmNlIGludG8gdGhlIHJvb3QgZG9jdW1lbnQncyByZWZlcmVuY2VzXG4gICAgICAgICAgT2JqZWN0LmtleXMoZG9jdW1lbnQucmVmcykuZm9yRWFjaChmdW5jdGlvbiAoY1JlZlB0cikge1xuICAgICAgICAgICAgdmFyIGZQdHIgPSBwYXRoVG9QdHIocGF0aEZyb21QdHIocmVmUHRyKS5jb25jYXQocGF0aEZyb21QdHIoY1JlZlB0cikpKTtcbiAgICAgICAgICAgIHZhciByZWZEZXRhaWxzID0gcmVmc1tmUHRyXTtcblxuICAgICAgICAgICAgaWYgKGlzVHlwZShyZWZEZXRhaWxzLCAnVW5kZWZpbmVkJykpIHtcbiAgICAgICAgICAgICAgcmVmc1tmUHRyXSA9IGRvY3VtZW50LnJlZnNbY1JlZlB0cl07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICAvLyBSZWNvcmQgdGhlIHZhbHVlIG9mIHRoZSByZW1vdGUgcmVmZXJlbmNlXG4gICAgICAgICAgcmVmc1tyZWZQdHJdLnZhbHVlID0gZG9jdW1lbnQudmFsdWU7XG5cbiAgICAgICAgICAvLyBNYXJrIHRoZSByZW1vdGUgcmVmZXJlbmNlIGl0c2VsZiBhcyBjaXJjdWxhclxuICAgICAgICAgIGlmIChkb2N1bWVudC5jaXJjdWxhcikge1xuICAgICAgICAgICAgcmVmc1tyZWZQdHJdLmNpcmN1bGFyID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVmcztcbiAgICB9KTtcblxuICByZXR1cm4gYWxsVGFza3M7XG59XG5cbmZ1bmN0aW9uIGZpbmRWYWx1ZSAob2JqLCBwYXRoLCBpZ25vcmUpIHtcbiAgdmFyIHZhbHVlID0gb2JqO1xuXG4gIHRyeSB7XG4gICAgcGF0aC5mb3JFYWNoKGZ1bmN0aW9uIChzZWcpIHtcbiAgICAgIGlmIChzZWcgaW4gdmFsdWUpIHtcbiAgICAgICAgdmFsdWUgPSB2YWx1ZVtzZWddO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ0pTT04gUG9pbnRlciBwb2ludHMgdG8gbWlzc2luZyBsb2NhdGlvbjogJyArIHBhdGhUb1B0cihwYXRoKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmIChpZ25vcmUgPT09IHRydWUpIHtcbiAgICAgIHZhbHVlID0gdW5kZWZpbmVkO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBnZXRFeHRyYVJlZktleXMgKHJlZikge1xuICByZXR1cm4gT2JqZWN0LmtleXMocmVmKS5maWx0ZXIoZnVuY3Rpb24gKGtleSkge1xuICAgIHJldHVybiBrZXkgIT09ICckcmVmJztcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFJlbW90ZURvY3VtZW50ICh1cmwsIG9wdGlvbnMpIHtcbiAgdmFyIGNhY2hlRW50cnkgPSByZW1vdGVDYWNoZVt1cmxdO1xuICB2YXIgYWxsVGFza3MgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgdmFyIGxvYWRlck9wdGlvbnMgPSBjbG9uZShvcHRpb25zLmxvYWRlck9wdGlvbnMgfHwge30pO1xuXG4gIGlmIChpc1R5cGUoY2FjaGVFbnRyeSwgJ1VuZGVmaW5lZCcpKSB7XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gY29udGVudCBwcm9jZXNzb3IsIGRlZmF1bHQgdG8gcHJvY2Vzc2luZyB0aGUgcmF3IHJlc3BvbnNlIGFzIEpTT05cbiAgICBpZiAoaXNUeXBlKGxvYWRlck9wdGlvbnMucHJvY2Vzc0NvbnRlbnQsICdVbmRlZmluZWQnKSkge1xuICAgICAgbG9hZGVyT3B0aW9ucy5wcm9jZXNzQ29udGVudCA9IGZ1bmN0aW9uIChyZXMsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKHVuZGVmaW5lZCwgSlNPTi5wYXJzZShyZXMudGV4dCkpO1xuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBBdHRlbXB0IHRvIGxvYWQgdGhlIHJlc291cmNlIHVzaW5nICBwYXRoLWxvYWRlclxuICAgIGFsbFRhc2tzID0gcGF0aExvYWRlci5sb2FkKHVybCwgbG9hZGVyT3B0aW9ucyk7XG5cbiAgICAvLyBVcGRhdGUgdGhlIGNhY2hlXG4gICAgYWxsVGFza3MgPSBhbGxUYXNrc1xuICAgICAgLnRoZW4oZnVuY3Rpb24gKHJlcykge1xuICAgICAgICByZW1vdGVDYWNoZVt1cmxdID0ge1xuICAgICAgICAgIHZhbHVlOiByZXNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIHJlbW90ZUNhY2hlW3VybF0gPSB7XG4gICAgICAgICAgZXJyb3I6IGVyclxuICAgICAgICB9O1xuXG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFJldHVybiB0aGUgY2FjaGVkIHZlcnNpb25cbiAgICBhbGxUYXNrcyA9IGFsbFRhc2tzLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIGNhY2hlRW50cnkudmFsdWU7XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBjbG9uZWQgdmVyc2lvbiB0byBhdm9pZCB1cGRhdGluZyB0aGUgY2FjaGVcbiAgYWxsVGFza3MgPSBhbGxUYXNrcy50aGVuKGZ1bmN0aW9uIChyZXMpIHtcbiAgICByZXR1cm4gY2xvbmUocmVzKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGFsbFRhc2tzO1xufVxuXG5mdW5jdGlvbiBpc1JlZkxpa2UgKG9iaiwgdGhyb3dXaXRoRGV0YWlscykge1xuICB2YXIgcmVmTGlrZSA9IHRydWU7XG5cbiAgdHJ5IHtcbiAgICBpZiAoIWlzVHlwZShvYmosICdPYmplY3QnKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmogaXMgbm90IGFuIE9iamVjdCcpO1xuICAgIH0gZWxzZSBpZiAoIWlzVHlwZShvYmouJHJlZiwgJ1N0cmluZycpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iai4kcmVmIGlzIG5vdCBhIFN0cmluZycpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKHRocm93V2l0aERldGFpbHMpIHtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG5cbiAgICByZWZMaWtlID0gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gcmVmTGlrZTtcbn1cblxuZnVuY3Rpb24gaXNUeXBlIChvYmosIHR5cGUpIHtcbiAgLy8gQSBQaGFudG9tSlMgYnVnIChodHRwczovL2dpdGh1Yi5jb20vYXJpeWEvcGhhbnRvbWpzL2lzc3Vlcy8xMTcyMikgcHJvaGliaXRzIHVzIGZyb20gdXNpbmcgdGhlIHNhbWUgYXBwcm9hY2ggZm9yXG4gIC8vIHVuZGVmaW5lZCBjaGVja2luZyB0aGF0IHdlIHVzZSBmb3Igb3RoZXIgdHlwZXMuXG4gIGlmICh0eXBlID09PSAnVW5kZWZpbmVkJykge1xuICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSAndW5kZWZpbmVkJztcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaikgPT09ICdbb2JqZWN0ICcgKyB0eXBlICsgJ10nO1xuICB9XG59XG5cbmZ1bmN0aW9uIG1ha2VSZWZGaWx0ZXIgKG9wdGlvbnMpIHtcbiAgdmFyIHJlZkZpbHRlcjtcblxuICBpZiAoaXNUeXBlKG9wdGlvbnMuZmlsdGVyLCAnQXJyYXknKSB8fCBpc1R5cGUob3B0aW9ucy5maWx0ZXIsICdTdHJpbmcnKSkge1xuICAgIHJlZkZpbHRlciA9IGZ1bmN0aW9uIChyZWZEZXRhaWxzKSB7XG4gICAgICB2YXIgdmFsaWRUeXBlcyA9IGlzVHlwZShvcHRpb25zLmZpbHRlciwgJ1N0cmluZycpID8gW29wdGlvbnMuZmlsdGVyXSA6IG9wdGlvbnMuZmlsdGVyO1xuXG4gICAgICByZXR1cm4gdmFsaWRUeXBlcy5pbmRleE9mKHJlZkRldGFpbHMudHlwZSkgPiAtMTtcbiAgICB9O1xuICB9IGVsc2UgaWYgKGlzVHlwZShvcHRpb25zLmZpbHRlciwgJ0Z1bmN0aW9uJykpIHtcbiAgICByZWZGaWx0ZXIgPSBvcHRpb25zLmZpbHRlcjtcbiAgfSBlbHNlIHtcbiAgICByZWZGaWx0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHJlZkZpbHRlcjtcbn1cblxuZnVuY3Rpb24gbWFrZVN1YkRvY1BhdGggKG9wdGlvbnMpIHtcbiAgdmFyIGZyb21QYXRoID0gW107XG5cbiAgaWYgKGlzVHlwZShvcHRpb25zLnN1YkRvY1BhdGgsICdBcnJheScpKSB7XG4gICAgZnJvbVBhdGggPSBvcHRpb25zLnN1YkRvY1BhdGg7XG4gIH0gZWxzZSBpZiAoaXNUeXBlKG9wdGlvbnMuc3ViRG9jUGF0aCwgJ1N0cmluZycpKSB7XG4gICAgZnJvbVBhdGggPSBwYXRoRnJvbVB0cihvcHRpb25zLnN1YkRvY1BhdGgpO1xuICB9XG5cbiAgcmV0dXJuIGZyb21QYXRoO1xufVxuXG5mdW5jdGlvbiBzZXRWYWx1ZSAob2JqLCByZWZQYXRoLCB2YWx1ZSkge1xuICBmaW5kVmFsdWUob2JqLCByZWZQYXRoLnNsaWNlKDAsIHJlZlBhdGgubGVuZ3RoIC0gMSkpW3JlZlBhdGhbcmVmUGF0aC5sZW5ndGggLSAxXV0gPSB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gd2FsayAoYW5jZXN0b3JzLCBub2RlLCBwYXRoLCBmbikge1xuICB2YXIgcHJvY2Vzc0NoaWxkcmVuID0gdHJ1ZTtcblxuICBmdW5jdGlvbiB3YWxrSXRlbSAoaXRlbSwgc2VnbWVudCkge1xuICAgIHBhdGgucHVzaChzZWdtZW50KTtcbiAgICB3YWxrKGFuY2VzdG9ycywgaXRlbSwgcGF0aCwgZm4pO1xuICAgIHBhdGgucG9wKCk7XG4gIH1cblxuICAvLyBDYWxsIHRoZSBpdGVyYXRlZVxuICBpZiAoaXNUeXBlKGZuLCAnRnVuY3Rpb24nKSkge1xuICAgIHByb2Nlc3NDaGlsZHJlbiA9IGZuKGFuY2VzdG9ycywgbm9kZSwgcGF0aCk7XG4gIH1cblxuICAvLyBXZSBkbyBub3QgcHJvY2VzcyBjaXJjdWxhciBvYmplY3RzIGFnYWluXG4gIGlmIChhbmNlc3RvcnMuaW5kZXhPZihub2RlKSA9PT0gLTEpIHtcbiAgICBhbmNlc3RvcnMucHVzaChub2RlKTtcblxuICAgIGlmIChwcm9jZXNzQ2hpbGRyZW4gIT09IGZhbHNlKSB7XG4gICAgICBpZiAoaXNUeXBlKG5vZGUsICdBcnJheScpKSB7XG4gICAgICAgIG5vZGUuZm9yRWFjaChmdW5jdGlvbiAobWVtYmVyLCBpbmRleCkge1xuICAgICAgICAgIHdhbGtJdGVtKG1lbWJlciwgaW5kZXgudG9TdHJpbmcoKSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChpc1R5cGUobm9kZSwgJ09iamVjdCcpKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG5vZGUpLmZvckVhY2goZnVuY3Rpb24gKGtleSkge1xuICAgICAgICAgIHdhbGtJdGVtKG5vZGVba2V5XSwga2V5KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYW5jZXN0b3JzLnBvcCgpO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU9wdGlvbnMgKG9wdGlvbnMpIHtcbiAgaWYgKCFpc1R5cGUob3B0aW9ucywgJ1VuZGVmaW5lZCcpKSB7XG4gICAgaWYgKCFpc1R5cGUob3B0aW9ucywgJ09iamVjdCcpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zIG11c3QgYmUgYW4gT2JqZWN0Jyk7XG4gICAgfSBlbHNlIGlmICghaXNUeXBlKG9wdGlvbnMuZmlsdGVyLCAnVW5kZWZpbmVkJykgJiZcbiAgICAgICAgICAgICAgICFpc1R5cGUob3B0aW9ucy5maWx0ZXIsICdBcnJheScpICYmXG4gICAgICAgICAgICAgICAhaXNUeXBlKG9wdGlvbnMuZmlsdGVyLCAnRnVuY3Rpb24nKSAmJlxuICAgICAgICAgICAgICAgIWlzVHlwZShvcHRpb25zLmZpbHRlciwgJ1N0cmluZycpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zLmZpbHRlciBtdXN0IGJlIGFuIEFycmF5LCBhIEZ1bmN0aW9uIG9mIGEgU3RyaW5nJyk7XG4gICAgfSBlbHNlIGlmICghaXNUeXBlKG9wdGlvbnMuaW5jbHVkZUludmFsaWQsICdVbmRlZmluZWQnKSAmJlxuICAgICAgICAgICAgICAgIWlzVHlwZShvcHRpb25zLmluY2x1ZGVJbnZhbGlkLCAnQm9vbGVhbicpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zLmluY2x1ZGVJbnZhbGlkIG11c3QgYmUgYSBCb29sZWFuJyk7XG4gICAgfSBlbHNlIGlmICghaXNUeXBlKG9wdGlvbnMucmVmUHJlUHJvY2Vzc29yLCAnVW5kZWZpbmVkJykgJiZcbiAgICAgICAgICAgICAgICFpc1R5cGUob3B0aW9ucy5yZWZQcmVQcm9jZXNzb3IsICdGdW5jdGlvbicpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zLnJlZlByZVByb2Nlc3NvciBtdXN0IGJlIGEgRnVuY3Rpb24nKTtcbiAgICB9IGVsc2UgaWYgKCFpc1R5cGUob3B0aW9ucy5yZWZQb3N0UHJvY2Vzc29yLCAnVW5kZWZpbmVkJykgJiZcbiAgICAgICAgICAgICAgICFpc1R5cGUob3B0aW9ucy5yZWZQb3N0UHJvY2Vzc29yLCAnRnVuY3Rpb24nKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignb3B0aW9ucy5yZWZQb3N0UHJvY2Vzc29yIG11c3QgYmUgYSBGdW5jdGlvbicpO1xuICAgIH0gZWxzZSBpZiAoIWlzVHlwZShvcHRpb25zLnN1YkRvY1BhdGgsICdVbmRlZmluZWQnKSAmJlxuICAgICAgICAgICAgICAgIWlzVHlwZShvcHRpb25zLnN1YkRvY1BhdGgsICdBcnJheScpICYmXG4gICAgICAgICAgICAgICAhaXNQdHIob3B0aW9ucy5zdWJEb2NQYXRoKSkge1xuICAgICAgLy8gSWYgYSBwb2ludGVyIGlzIHByb3ZpZGVkLCB0aHJvdyBhbiBlcnJvciBpZiBpdCdzIG5vdCB0aGUgcHJvcGVyIHR5cGVcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMuc3ViRG9jUGF0aCBtdXN0IGJlIGFuIEFycmF5IG9mIHBhdGggc2VnbWVudHMgb3IgYSB2YWxpZCBKU09OIFBvaW50ZXInKTtcbiAgICB9XG4gIH1cbn1cblxuLyogTW9kdWxlIE1lbWJlcnMgKi9cblxuLypcbiAqIEVhY2ggb2YgdGhlIGZ1bmN0aW9ucyBiZWxvdyBhcmUgZGVmaW5lZCBhcyBmdW5jdGlvbiBzdGF0ZW1lbnRzIGFuZCAqdGhlbiogZXhwb3J0ZWQgaW4gdHdvIHN0ZXBzIGluc3RlYWQgb2Ygb25lIGR1ZVxuICogdG8gYSBidWcgaW4ganNkb2MgKGh0dHBzOi8vZ2l0aHViLmNvbS9qc2RvYzJtZC9qc2RvYy1wYXJzZS9pc3N1ZXMvMTgpIHRoYXQgY2F1c2VzIG91ciBkb2N1bWVudGF0aW9uIHRvIGJlXG4gKiBnZW5lcmF0ZWQgaW1wcm9wZXJseS4gIFRoZSBpbXBhY3QgdG8gdGhlIHVzZXIgaXMgc2lnbmlmaWNhbnQgZW5vdWdoIGZvciB1cyB0byB3YXJyYW50IHdvcmtpbmcgYXJvdW5kIGl0IHVudGlsIHRoaXNcbiAqIGlzIGZpeGVkLlxuICovXG5cbi8qKlxuICogVGhlIG9wdGlvbnMgdXNlZCBmb3IgdmFyaW91cyBKc29uUmVmcyBBUElzLlxuICpcbiAqIEB0eXBlZGVmIHtvYmplY3R9IEpzb25SZWZzT3B0aW9uc1xuICpcbiAqIEBwYXJhbSB7c3RyaW5nfHN0cmluZ1tdfGZ1bmN0aW9ufSBbZmlsdGVyPWZ1bmN0aW9uICgpIHtyZXR1cm4gdHJ1ZTt9XSAtIFRoZSBmaWx0ZXIgdG8gdXNlIHdoZW4gZ2F0aGVyaW5nIEpTT05cbiAqIFJlZmVyZW5jZXMgKihJZiB0aGlzIHZhbHVlIGlzIGEgc2luZ2xlIHN0cmluZyBvciBhbiBhcnJheSBvZiBzdHJpbmdzLCB0aGUgdmFsdWUocykgYXJlIGV4cGVjdGVkIHRvIGJlIHRoZSBgdHlwZShzKWBcbiAqIHlvdSBhcmUgaW50ZXJlc3RlZCBpbiBjb2xsZWN0aW5nIGFzIGRlc2NyaWJlZCBpbiB7QGxpbmsgbW9kdWxlOkpzb25SZWZzLmdldFJlZkRldGFpbHN9LiAgSWYgaXQgaXMgYSBmdW5jdGlvbiwgaXQgaXNcbiAqIGV4cGVjdGVkIHRoYXQgdGhlIGZ1bmN0aW9uIGJlaGF2ZXMgbGlrZSB7QGxpbmsgbW9kdWxlOkpzb25SZWZzflJlZkRldGFpbHNGaWx0ZXJ9LikqXG4gKiBAcGFyYW0ge2Jvb2xlYW59IFtpbmNsdWRlSW52YWxpZD1mYWxzZV0gLSBXaGV0aGVyIG9yIG5vdCB0byBpbmNsdWRlIGludmFsaWQgSlNPTiBSZWZlcmVuY2UgZGV0YWlscyAqKFRoaXMgd2lsbCBtYWtlXG4gKiBpdCBzbyB0aGF0IG9iamVjdHMgdGhhdCBhcmUgbGlrZSBKU09OIFJlZmVyZW5jZSBvYmplY3RzLCBhcyBpbiB0aGV5IGFyZSBhbiBgT2JqZWN0YCBhbmQgdGhlIGhhdmUgYSBgJHJlZmAgcHJvcGVydHksXG4gKiBidXQgZmFpbCB2YWxpZGF0aW9uIHdpbGwgYmUgaW5jbHVkZWQuICBUaGlzIGlzIHZlcnkgdXNlZnVsIGZvciB3aGVuIHlvdSB3YW50IHRvIGtub3cgaWYgeW91IGhhdmUgaW52YWxpZCBKU09OXG4gKiBSZWZlcmVuY2UgZGVmaW5pdGlvbnMuICBUaGlzIHdpbGwgbm90IG1lYW4gdGhhdCBBUElzIHdpbGwgcHJvY2VzcyBpbnZhbGlkIEpTT04gUmVmZXJlbmNlcyBidXQgdGhlIHJlYXNvbnMgYXMgdG8gd2h5XG4gKiB0aGUgSlNPTiBSZWZlcmVuY2VzIGFyZSBpbnZhbGlkIHdpbGwgYmUgaW5jbHVkZWQgaW4gdGhlIHJldHVybmVkIG1ldGFkYXRhLikqXG4gKiBAcGFyYW0ge29iamVjdH0gW2xvYWRlck9wdGlvbnNdIC0gVGhlIG9wdGlvbnMgdG8gcGFzcyB0b1xuICoge0BsaW5rIGh0dHBzOi8vZ2l0aHViLmNvbS93aGl0bG9ja2pjL3BhdGgtbG9hZGVyL2Jsb2IvbWFzdGVyL2RvY3MvQVBJLm1kI21vZHVsZV9QYXRoTG9hZGVyLmxvYWR8UGF0aExvYWRlcn5sb2FkfVxuICogQHBhcmFtIHtSZWZQcmVQcm9jZXNzb3J9IFtyZWZQcmVQcm9jZXNzb3JdIC0gVGhlIGNhbGxiYWNrIHVzZWQgdG8gcHJlLXByb2Nlc3MgYSBKU09OIFJlZmVyZW5jZSBsaWtlXG4gKiBvYmplY3QgKihUaGlzIGlzIGNhbGxlZCBwcmlvciB0byB2YWxpZGF0aW5nIHRoZSBKU09OIFJlZmVyZW5jZSBsaWtlIG9iamVjdCBhbmQgZ2V0dGluZyBpdHMgZGV0YWlscykqXG4gKiBAcGFyYW0ge1JlZlBvc3RQcm9jZXNzb3J9IFtyZWZQb3N0UHJvY2Vzc29yXSAtIFRoZSBjYWxsYmFjayB1c2VkIHRvIHBvc3QtcHJvY2VzcyB0aGUgSlNPTiBSZWZlcmVuY2VcbiAqIG1ldGFkYXRhICooVGhpcyBpcyBjYWxsZWQgcHJpb3IgZmlsdGVyaW5nIHRoZSByZWZlcmVuY2VzKSpcbiAqIEBwYXJhbSB7c3RyaW5nfSBbb3B0aW9ucy5yZWxhdGl2ZUJhc2VdIC0gVGhlIGJhc2UgbG9jYXRpb24gdG8gdXNlIHdoZW4gcmVzb2x2aW5nIHJlbGF0aXZlIHJlZmVyZW5jZXMgKihPbmx5IHVzZWZ1bFxuICogZm9yIEFQSXMgdGhhdCBkbyByZW1vdGUgcmVmZXJlbmNlIHJlc29sdXRpb24uICBJZiB0aGlzIHZhbHVlIGlzIG5vdCBkZWZpbmVkLFxuICoge0BsaW5rIGh0dHBzOi8vZ2l0aHViLmNvbS93aGl0bG9ja2pjL3BhdGgtbG9hZGVyfHBhdGgtbG9hZGVyfSB3aWxsIHVzZSBgd2luZG93LmxvY2F0aW9uLmhyZWZgIGZvciB0aGUgYnJvd3NlciBhbmRcbiAqIGBwcm9jZXNzLmN3ZCgpYCBmb3IgTm9kZS5qcy4pKlxuICogQHBhcmFtIHtzdHJpbmd8c3RyaW5nW119IFtvcHRpb25zLnN1YkRvY1BhdGg9W11dIC0gVGhlIEpTT04gUG9pbnRlciBvciBhcnJheSBvZiBwYXRoIHNlZ21lbnRzIHRvIHRoZSBzdWIgZG9jdW1lbnRcbiAqIGxvY2F0aW9uIHRvIHNlYXJjaCBmcm9tXG4gKi9cblxuLyoqXG4gKiBTaW1wbGUgZnVuY3Rpb24gdXNlZCB0byBmaWx0ZXIgb3V0IEpTT04gUmVmZXJlbmNlcy5cbiAqXG4gKiBAdHlwZWRlZiB7ZnVuY3Rpb259IFJlZkRldGFpbHNGaWx0ZXJcbiAqXG4gKiBAcGFyYW0ge1VucmVzb2x2ZWRSZWZEZXRhaWxzfSByZWZEZXRhaWxzIC0gVGhlIEpTT04gUmVmZXJlbmNlIGRldGFpbHMgdG8gdGVzdFxuICogQHBhcmFtIHtzdHJpbmdbXX0gcGF0aCAtIFRoZSBwYXRoIHRvIHRoZSBKU09OIFJlZmVyZW5jZVxuICpcbiAqIEByZXR1cm5zIHtib29sZWFufSB3aGV0aGVyIHRoZSBKU09OIFJlZmVyZW5jZSBzaG91bGQgYmUgZmlsdGVyZWQgKihvdXQpKiBvciBub3RcbiAqL1xuXG4vKipcbiAqIFNpbXBsZSBmdW5jdGlvbiB1c2VkIHRvIHByZS1wcm9jZXNzIGEgSlNPTiBSZWZlcmVuY2UgbGlrZSBvYmplY3QuXG4gKlxuICogQHR5cGVkZWYge2Z1bmN0aW9ufSBSZWZQcmVQcm9jZXNzb3JcbiAqXG4gKiBAcGFyYW0ge29iamVjdH0gb2JqIC0gVGhlIEpTT04gUmVmZXJlbmNlIGxpa2Ugb2JqZWN0XG4gKiBAcGFyYW0ge3N0cmluZ1tdfSBwYXRoIC0gVGhlIHBhdGggdG8gdGhlIEpTT04gUmVmZXJlbmNlIGxpa2Ugb2JqZWN0XG4gKlxuICogQHJldHVybnMge29iamVjdH0gdGhlIHByb2Nlc3NlZCBKU09OIFJlZmVyZW5jZSBsaWtlIG9iamVjdFxuICovXG5cbi8qKlxuICogU2ltcGxlIGZ1bmN0aW9uIHVzZWQgdG8gcG9zdC1wcm9jZXNzIGEgSlNPTiBSZWZlcmVuY2UgZGV0YWlscy5cbiAqXG4gKiBAdHlwZWRlZiB7ZnVuY3Rpb259IFJlZlBvc3RQcm9jZXNzb3JcbiAqXG4gKiBAcGFyYW0ge1VucmVzb2x2ZWRSZWZEZXRhaWxzfSByZWZEZXRhaWxzIC0gVGhlIEpTT04gUmVmZXJlbmNlIGRldGFpbHMgdG8gdGVzdFxuICogQHBhcmFtIHtzdHJpbmdbXX0gcGF0aCAtIFRoZSBwYXRoIHRvIHRoZSBKU09OIFJlZmVyZW5jZVxuICpcbiAqIEByZXR1cm5zIHtvYmplY3R9IHRoZSBwcm9jZXNzZWQgSlNPTiBSZWZlcmVuY2UgZGV0YWlscyBvYmplY3RcbiAqL1xuXG4vKipcbiAqIERldGFpbGVkIGluZm9ybWF0aW9uIGFib3V0IHJlc29sdmVkIEpTT04gUmVmZXJlbmNlcy5cbiAqXG4gKiBAdHlwZWRlZiB7VW5yZXNvbHZlZFJlZkRldGFpbHN9IFJlc29sdmVkUmVmRGV0YWlsc1xuICpcbiAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW2NpcmN1bGFyXSAtIFdoZXRoZXIgb3Igbm90IHRoZSBKU09OIFJlZmVyZW5jZSBpcyBjaXJjdWxhciAqKFdpbGwgbm90IGJlIHNldCBpZiB0aGUgSlNPTlxuICogUmVmZXJlbmNlIGlzIG5vdCBjaXJjdWxhcikqXG4gKiBAcHJvcGVydHkge2Jvb2xlYW59IFttaXNzaW5nXSAtIFdoZXRoZXIgb3Igbm90IHRoZSByZWZlcmVuY2VkIHZhbHVlIHdhcyBtaXNzaW5nIG9yIG5vdCAqKFdpbGwgbm90IGJlIHNldCBpZiB0aGVcbiAqIHJlZmVyZW5jZWQgdmFsdWUgaXMgbm90IG1pc3NpbmcpKlxuICogQHByb3BlcnR5IHsqfSBbdmFsdWVdIC0gVGhlIHJlZmVyZW5jZWQgdmFsdWUgKihXaWxsIG5vdCBiZSBzZXQgaWYgdGhlIHJlZmVyZW5jZWQgdmFsdWUgaXMgbWlzc2luZykqXG4gKi9cblxuLyoqXG4gKiBUaGUgcmVzdWx0cyBvZiByZXNvbHZpbmcgdGhlIEpTT04gUmVmZXJlbmNlcyBvZiBhbiBhcnJheS9vYmplY3QuXG4gKlxuICogQHR5cGVkZWYge29iamVjdH0gUmVzb2x2ZWRSZWZzUmVzdWx0c1xuICpcbiAqIEBwcm9wZXJ0eSB7UmVzb2x2ZWRSZWZEZXRhaWxzfSByZWZzIC0gQW4gb2JqZWN0IHdob3NlIGtleXMgYXJlIEpTT04gUG9pbnRlcnMgKihmcmFnbWVudCB2ZXJzaW9uKSpcbiAqIHRvIHdoZXJlIHRoZSBKU09OIFJlZmVyZW5jZSBpcyBkZWZpbmVkIGFuZCB3aG9zZSB2YWx1ZXMgYXJlIHtAbGluayBtb2R1bGU6SnNvblJlZnN+UmVzb2x2ZWRSZWZEZXRhaWxzfVxuICogQHByb3BlcnR5IHtvYmplY3R9IHZhbHVlIC0gVGhlIGFycmF5L29iamVjdCB3aXRoIGl0cyBKU09OIFJlZmVyZW5jZXMgZnVsbHkgcmVzb2x2ZWRcbiAqL1xuXG4vKipcbiAqIEFuIG9iamVjdCBjb250YWluaW5nIHRoZSByZXRyaWV2ZWQgZG9jdW1lbnQgYW5kIGRldGFpbGVkIGluZm9ybWF0aW9uIGFib3V0IGl0cyBKU09OIFJlZmVyZW5jZXMuXG4gKlxuICogQHR5cGVkZWYge29iamVjdH0gUmV0cmlldmVkUmVmc1Jlc3VsdHNcbiAqXG4gKiBAcHJvcGVydHkge1VucmVzb2x2ZWRSZWZEZXRhaWxzfSByZWZzIC0gQW4gb2JqZWN0IHdob3NlIGtleXMgYXJlIEpTT04gUG9pbnRlcnMgKihmcmFnbWVudCB2ZXJzaW9uKSpcbiAqIHRvIHdoZXJlIHRoZSBKU09OIFJlZmVyZW5jZSBpcyBkZWZpbmVkIGFuZCB3aG9zZSB2YWx1ZXMgYXJlIHtAbGluayBtb2R1bGU6SnNvblJlZnN+VW5yZXNvbHZlZFJlZkRldGFpbHN9XG4gKiBAcHJvcGVydHkge29iamVjdH0gdmFsdWUgLSBUaGUgcmV0cmlldmVkIGRvY3VtZW50XG4gKi9cblxuLyoqXG4gKiBBbiBvYmplY3QgY29udGFpbmluZyB0aGUgcmV0cmlldmVkIGRvY3VtZW50LCB0aGUgZG9jdW1lbnQgd2l0aCBpdHMgcmVmZXJlbmNlcyByZXNvbHZlZCBhbmQgIGRldGFpbGVkIGluZm9ybWF0aW9uXG4gKiBhYm91dCBpdHMgSlNPTiBSZWZlcmVuY2VzLlxuICpcbiAqIEB0eXBlZGVmIHtvYmplY3R9IFJldHJpZXZlZFJlc29sdmVkUmVmc1Jlc3VsdHNcbiAqXG4gKiBAcHJvcGVydHkge1VucmVzb2x2ZWRSZWZEZXRhaWxzfSByZWZzIC0gQW4gb2JqZWN0IHdob3NlIGtleXMgYXJlIEpTT04gUG9pbnRlcnMgKihmcmFnbWVudCB2ZXJzaW9uKSpcbiAqIHRvIHdoZXJlIHRoZSBKU09OIFJlZmVyZW5jZSBpcyBkZWZpbmVkIGFuZCB3aG9zZSB2YWx1ZXMgYXJlIHtAbGluayBtb2R1bGU6SnNvblJlZnN+VW5yZXNvbHZlZFJlZkRldGFpbHN9XG4gKiBAcHJvcGVydHkge1Jlc29sdmVkUmVmc1Jlc3VsdHN9IC0gQW4gb2JqZWN0IHdob3NlIGtleXMgYXJlIEpTT04gUG9pbnRlcnMgKihmcmFnbWVudCB2ZXJzaW9uKSpcbiAqIHRvIHdoZXJlIHRoZSBKU09OIFJlZmVyZW5jZSBpcyBkZWZpbmVkIGFuZCB3aG9zZSB2YWx1ZXMgYXJlIHtAbGluayBtb2R1bGU6SnNvblJlZnN+UmVzb2x2ZWRSZWZEZXRhaWxzfVxuICogQHByb3BlcnR5IHtvYmplY3R9IHZhbHVlIC0gVGhlIHJldHJpZXZlZCBkb2N1bWVudFxuICovXG5cbi8qKlxuICogRGV0YWlsZWQgaW5mb3JtYXRpb24gYWJvdXQgdW5yZXNvbHZlZCBKU09OIFJlZmVyZW5jZXMuXG4gKlxuICogQHR5cGVkZWYge29iamVjdH0gVW5yZXNvbHZlZFJlZkRldGFpbHNcbiAqXG4gKiBAcHJvcGVydHkge29iamVjdH0gZGVmIC0gVGhlIEpTT04gUmVmZXJlbmNlIGRlZmluaXRpb25cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbZXJyb3JdIC0gVGhlIGVycm9yIGluZm9ybWF0aW9uIGZvciBpbnZhbGlkIEpTT04gUmVmZXJlbmNlIGRlZmluaXRpb24gKihPbmx5IHByZXNlbnQgd2hlbiB0aGVcbiAqIEpTT04gUmVmZXJlbmNlIGRlZmluaXRpb24gaXMgaW52YWxpZCBvciB0aGVyZSB3YXMgYSBwcm9ibGVtIHJldHJpZXZpbmcgYSByZW1vdGUgcmVmZXJlbmNlIGR1cmluZyByZXNvbHV0aW9uKSpcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB1cmkgLSBUaGUgVVJJIHBvcnRpb24gb2YgdGhlIEpTT04gUmVmZXJlbmNlXG4gKiBAcHJvcGVydHkge29iamVjdH0gdXJpRGV0YWlscyAtIERldGFpbGVkIGluZm9ybWF0aW9uIGFib3V0IHRoZSBVUkkgYXMgcHJvdmlkZWQgYnlcbiAqIHtAbGluayBodHRwczovL2dpdGh1Yi5jb20vZ2FyeWNvdXJ0L3VyaS1qc3xVUkkucGFyc2V9LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IHR5cGUgLSBUaGUgSlNPTiBSZWZlcmVuY2UgdHlwZSAqKFRoaXMgdmFsdWUgY2FuIGJlIG9uZSBvZiB0aGUgZm9sbG93aW5nOiBgaW52YWxpZGAsIGBsb2NhbGAsXG4gKiBgcmVsYXRpdmVgIG9yIGByZW1vdGVgLikqXG4gKiBAcHJvcGVydHkge3N0cmluZ30gW3dhcm5pbmddIC0gVGhlIHdhcm5pbmcgaW5mb3JtYXRpb24gKihPbmx5IHByZXNlbnQgd2hlbiB0aGUgSlNPTiBSZWZlcmVuY2UgZGVmaW5pdGlvbiBwcm9kdWNlcyBhXG4gKiB3YXJuaW5nKSpcbiAqL1xuXG4vKipcbiAqIENsZWFycyB0aGUgaW50ZXJuYWwgY2FjaGUgb2YgcmVtb3RlIGRvY3VtZW50cywgcmVmZXJlbmNlIGRldGFpbHMsIGV0Yy5cbiAqXG4gKiBAYWxpYXMgbW9kdWxlOkpzb25SZWZzLmNsZWFyQ2FjaGVcbiAqL1xuZnVuY3Rpb24gY2xlYXJDYWNoZSAoKSB7XG4gIHJlbW90ZUNhY2hlID0ge307XG59XG5cbi8qKlxuICogVGFrZXMgYW4gYXJyYXkgb2YgcGF0aCBzZWdtZW50cyBhbmQgZGVjb2RlcyB0aGUgSlNPTiBQb2ludGVyIHRva2VucyBpbiB0aGVtLlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nW119IHBhdGggLSBUaGUgYXJyYXkgb2YgcGF0aCBzZWdtZW50c1xuICpcbiAqIEByZXR1cm5zIHtzdHJpbmd9IHRoZSBhcnJheSBvZiBwYXRoIHNlZ21lbnRzIHdpdGggdGhlaXIgSlNPTiBQb2ludGVyIHRva2VucyBkZWNvZGVkXG4gKlxuICogQHRocm93cyB7RXJyb3J9IGlmIHRoZSBwYXRoIGlzIG5vdCBhbiBgQXJyYXlgXG4gKlxuICogQHNlZSB7QGxpbmsgaHR0cHM6Ly90b29scy5pZXRmLm9yZy9odG1sL3JmYzY5MDEjc2VjdGlvbi0zfVxuICpcbiAqIEBhbGlhcyBtb2R1bGU6SnNvblJlZnMuZGVjb2RlUGF0aFxuICovXG5mdW5jdGlvbiBkZWNvZGVQYXRoIChwYXRoKSB7XG4gIGlmICghaXNUeXBlKHBhdGgsICdBcnJheScpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncGF0aCBtdXN0IGJlIGFuIGFycmF5Jyk7XG4gIH1cblxuICByZXR1cm4gcGF0aC5tYXAoZnVuY3Rpb24gKHNlZykge1xuICAgIGlmICghaXNUeXBlKHNlZywgJ1N0cmluZycpKSB7XG4gICAgICBzZWcgPSBKU09OLnN0cmluZ2lmeShzZWcpO1xuICAgIH1cblxuICAgIHJldHVybiBzZWcucmVwbGFjZSgvfjEvZywgJy8nKS5yZXBsYWNlKC9+MC9nLCAnficpO1xuICB9KTtcbn1cblxuLyoqXG4gKiBUYWtlcyBhbiBhcnJheSBvZiBwYXRoIHNlZ21lbnRzIGFuZCBlbmNvZGVzIHRoZSBzcGVjaWFsIEpTT04gUG9pbnRlciBjaGFyYWN0ZXJzIGluIHRoZW0uXG4gKlxuICogQHBhcmFtIHtzdHJpbmdbXX0gcGF0aCAtIFRoZSBhcnJheSBvZiBwYXRoIHNlZ21lbnRzXG4gKlxuICogQHJldHVybnMge3N0cmluZ30gdGhlIGFycmF5IG9mIHBhdGggc2VnbWVudHMgd2l0aCB0aGVpciBKU09OIFBvaW50ZXIgdG9rZW5zIGVuY29kZWRcbiAqXG4gKiBAdGhyb3dzIHtFcnJvcn0gaWYgdGhlIHBhdGggaXMgbm90IGFuIGBBcnJheWBcbiAqXG4gKiBAc2VlIHtAbGluayBodHRwczovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjNjkwMSNzZWN0aW9uLTN9XG4gKlxuICogQGFsaWFzIG1vZHVsZTpKc29uUmVmcy5lbmNvZGVQYXRoXG4gKi9cbmZ1bmN0aW9uIGVuY29kZVBhdGggKHBhdGgpIHtcbiAgaWYgKCFpc1R5cGUocGF0aCwgJ0FycmF5JykpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdwYXRoIG11c3QgYmUgYW4gYXJyYXknKTtcbiAgfVxuXG4gIHJldHVybiBwYXRoLm1hcChmdW5jdGlvbiAoc2VnKSB7XG4gICAgaWYgKCFpc1R5cGUoc2VnLCAnU3RyaW5nJykpIHtcbiAgICAgIHNlZyA9IEpTT04uc3RyaW5naWZ5KHNlZyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHNlZy5yZXBsYWNlKC9+L2csICd+MCcpLnJlcGxhY2UoL1xcLy9nLCAnfjEnKTtcbiAgfSk7XG59XG5cbi8qKlxuICogRmluZHMgSlNPTiBSZWZlcmVuY2VzIGRlZmluZWQgd2l0aGluIHRoZSBwcm92aWRlZCBhcnJheS9vYmplY3QuXG4gKlxuICogQHBhcmFtIHthcnJheXxvYmplY3R9IG9iaiAtIFRoZSBzdHJ1Y3R1cmUgdG8gZmluZCBKU09OIFJlZmVyZW5jZXMgd2l0aGluXG4gKiBAcGFyYW0ge0pzb25SZWZzT3B0aW9uc30gW29wdGlvbnNdIC0gVGhlIEpzb25SZWZzIG9wdGlvbnNcbiAqXG4gKiBAcmV0dXJucyB7b2JqZWN0fSBhbiBvYmplY3Qgd2hvc2Uga2V5cyBhcmUgSlNPTiBQb2ludGVycyAqKGZyYWdtZW50IHZlcnNpb24pKiB0byB3aGVyZSB0aGUgSlNPTiBSZWZlcmVuY2UgaXMgZGVmaW5lZFxuICogYW5kIHdob3NlIHZhbHVlcyBhcmUge0BsaW5rIG1vZHVsZTpKc29uUmVmc35VbnJlc29sdmVkUmVmRGV0YWlsc30uXG4gKlxuICogQHRocm93cyB7RXJyb3J9IHdoZW4gdGhlIGlucHV0IGFyZ3VtZW50cyBmYWlsIHZhbGlkYXRpb24gb3IgaWYgYG9wdGlvbnMuc3ViRG9jUGF0aGAgcG9pbnRzIHRvIGFuIGludmFsaWQgbG9jYXRpb25cbiAqXG4gKiBAYWxpYXMgbW9kdWxlOkpzb25SZWZzLmZpbmRSZWZzXG4gKlxuICogQGV4YW1wbGVcbiAqIC8vIEZpbmRpbmcgYWxsIHZhbGlkIHJlZmVyZW5jZXNcbiAqIHZhciBhbGxSZWZzID0gSnNvblJlZnMuZmluZFJlZnMob2JqKTtcbiAqIC8vIEZpbmRpbmcgYWxsIHJlbW90ZSByZWZlcmVuY2VzXG4gKiB2YXIgcmVtb3RlUmVmcyA9IEpzb25SZWZzLmZpbmRSZWZzKG9iaiwge2ZpbHRlcjogWydyZWxhdGl2ZScsICdyZW1vdGUnXX0pO1xuICogLy8gRmluZGluZyBhbGwgaW52YWxpZCByZWZlcmVuY2VzXG4gKiB2YXIgaW52YWxpZFJlZnMgPSBKc29uUmVmcy5maW5kUmVmcyhvYmosIHtmaWx0ZXI6ICdpbnZhbGlkJywgaW5jbHVkZUludmFsaWQ6IHRydWV9KTtcbiAqL1xuZnVuY3Rpb24gZmluZFJlZnMgKG9iaiwgb3B0aW9ucykge1xuICB2YXIgYW5jZXN0b3JzID0gW107XG4gIHZhciBmcm9tT2JqID0gb2JqO1xuICB2YXIgZnJvbVBhdGg7XG4gIHZhciByZWZzID0ge307XG4gIHZhciByZWZGaWx0ZXI7XG5cbiAgLy8gVmFsaWRhdGUgdGhlIHByb3ZpZGVkIGRvY3VtZW50XG4gIGlmICghaXNUeXBlKG9iaiwgJ0FycmF5JykgJiYgIWlzVHlwZShvYmosICdPYmplY3QnKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29iaiBtdXN0IGJlIGFuIEFycmF5IG9yIGFuIE9iamVjdCcpO1xuICB9XG5cbiAgLy8gU2V0IGRlZmF1bHQgZm9yIG9wdGlvbnNcbiAgaWYgKGlzVHlwZShvcHRpb25zLCAnVW5kZWZpbmVkJykpIHtcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICAvLyBWYWxpZGF0ZSBvcHRpb25zXG4gIHZhbGlkYXRlT3B0aW9ucyhvcHRpb25zKTtcblxuICAvLyBDb252ZXJ0IGZyb20gdG8gYSBwb2ludGVyXG4gIGZyb21QYXRoID0gbWFrZVN1YkRvY1BhdGgob3B0aW9ucyk7XG5cbiAgLy8gQ29udmVydCBvcHRpb25zLmZpbHRlciBmcm9tIGFuIEFycmF5L1N0cmluZyB0byBhIEZ1bmN0aW9uXG4gIHJlZkZpbHRlciA9IG1ha2VSZWZGaWx0ZXIob3B0aW9ucyk7XG5cbiAgaWYgKGZyb21QYXRoLmxlbmd0aCA+IDApIHtcbiAgICBhbmNlc3RvcnMgPSBmaW5kQW5jZXN0b3JzKG9iaiwgZnJvbVBhdGgpO1xuICAgIGZyb21PYmogPSBmaW5kVmFsdWUob2JqLCBmcm9tUGF0aCk7XG4gIH1cblxuICAvLyBXYWxrIHRoZSBkb2N1bWVudCAob3Igc3ViIGRvY3VtZW50KSBhbmQgZmluZCBhbGwgSlNPTiBSZWZlcmVuY2VzXG4gIHdhbGsoYW5jZXN0b3JzLCBmcm9tT2JqLCBmcm9tUGF0aCwgZnVuY3Rpb24gKGFuY2VzdG9ycywgbm9kZSwgcGF0aCkge1xuICAgIHZhciBwcm9jZXNzQ2hpbGRyZW4gPSB0cnVlO1xuICAgIHZhciByZWZEZXRhaWxzO1xuXG4gICAgaWYgKGlzUmVmTGlrZShub2RlKSkge1xuICAgICAgLy8gUHJlLXByb2Nlc3MgdGhlIG5vZGUgd2hlbiBuZWNlc3NhcnlcbiAgICAgIGlmICghaXNUeXBlKG9wdGlvbnMucmVmUHJlUHJvY2Vzc29yLCAnVW5kZWZpbmVkJykpIHtcbiAgICAgICAgbm9kZSA9IG9wdGlvbnMucmVmUHJlUHJvY2Vzc29yKG5vZGUsIHBhdGgpO1xuICAgICAgfVxuXG4gICAgICByZWZEZXRhaWxzID0gZ2V0UmVmRGV0YWlscyhub2RlKTtcblxuICAgICAgaWYgKHJlZkRldGFpbHMudHlwZSAhPT0gJ2ludmFsaWQnIHx8IG9wdGlvbnMuaW5jbHVkZUludmFsaWQgPT09IHRydWUpIHtcbiAgICAgICAgaWYgKHJlZkZpbHRlcihyZWZEZXRhaWxzLCBwYXRoKSA9PT0gdHJ1ZSkge1xuICAgICAgICAgIC8vIFBvc3QtcHJvY2VzcyB0aGUgcmVmZXJlbmNlIGRldGFpbHMgd2hlbiBuZWNlc3NhcnlcbiAgICAgICAgICBpZiAoIWlzVHlwZShvcHRpb25zLnJlZlBvc3RQcm9jZXNzb3IsICdVbmRlZmluZWQnKSkge1xuICAgICAgICAgICAgcmVmRGV0YWlscyA9IG9wdGlvbnMucmVmUG9zdFByb2Nlc3NvcihyZWZEZXRhaWxzLCBwYXRoKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZWZzW3BhdGhUb1B0cihwYXRoKV0gPSByZWZEZXRhaWxzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV2hlbmV2ZXIgYSBKU09OIFJlZmVyZW5jZSBoYXMgZXh0cmEgY2hpbGRyZW4sIGl0cyBjaGlsZHJlbiBzaG91bGQgYmUgaWdub3JlZCBzbyB3ZSB3YW50IHRvIHN0b3AgcHJvY2Vzc2luZy5cbiAgICAgICAgLy8gICBTZWU6IGh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL2RyYWZ0LXBicnlhbi16eXAtanNvbi1yZWYtMDMjc2VjdGlvbi0zXG4gICAgICAgIGlmIChnZXRFeHRyYVJlZktleXMobm9kZSkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHByb2Nlc3NDaGlsZHJlbiA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHByb2Nlc3NDaGlsZHJlbjtcbiAgfSk7XG5cbiAgcmV0dXJuIHJlZnM7XG59XG5cbi8qKlxuICogRmluZHMgSlNPTiBSZWZlcmVuY2VzIGRlZmluZWQgd2l0aGluIHRoZSBkb2N1bWVudCBhdCB0aGUgcHJvdmlkZWQgbG9jYXRpb24uXG4gKlxuICogVGhpcyBBUEkgaXMgaWRlbnRpY2FsIHRvIHtAbGluayBtb2R1bGU6SnNvblJlZnMuZmluZFJlZnN9IGV4Y2VwdCB0aGlzIEFQSSB3aWxsIHJldHJpZXZlIGEgcmVtb3RlIGRvY3VtZW50IGFuZCB0aGVuXG4gKiByZXR1cm4gdGhlIHJlc3VsdCBvZiB7QGxpbmsgbW9kdWxlOkpzb25SZWZzLmZpbmRSZWZzfSBvbiB0aGUgcmV0cmlldmVkIGRvY3VtZW50LlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBsb2NhdGlvbiAtIFRoZSBsb2NhdGlvbiB0byByZXRyaWV2ZSAqKENhbiBiZSByZWxhdGl2ZSBvciBhYnNvbHV0ZSwganVzdCBtYWtlIHN1cmUgeW91IGxvb2sgYXQgdGhlXG4gKiB7QGxpbmsgbW9kdWxlOkpzb25SZWZzfkpzb25SZWZzT3B0aW9uc3xvcHRpb25zIGRvY3VtZW50YXRpb259IHRvIHNlZSBob3cgcmVsYXRpdmUgcmVmZXJlbmNlcyBhcmUgaGFuZGxlZC4pKlxuICogQHBhcmFtIHtKc29uUmVmc09wdGlvbnN9IFtvcHRpb25zXSAtIFRoZSBKc29uUmVmcyBvcHRpb25zXG4gKlxuICogQHJldHVybnMge1Byb21pc2V9IGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIGEge0BsaW5rIG1vZHVsZTpKc29uUmVmc35SZXRyaWV2ZWRSZWZzUmVzdWx0c30gYW5kIHJlamVjdHMgd2l0aCBhblxuICogYEVycm9yYCB3aGVuIHRoZSBpbnB1dCBhcmd1bWVudHMgZmFpbCB2YWxpZGF0aW9uLCB3aGVuIGBvcHRpb25zLnN1YkRvY1BhdGhgIHBvaW50cyB0byBhbiBpbnZhbGlkIGxvY2F0aW9uIG9yIHdoZW5cbiAqICB0aGUgbG9jYXRpb24gYXJndW1lbnQgcG9pbnRzIHRvIGFuIHVubG9hZGFibGUgcmVzb3VyY2VcbiAqXG4gKiBAYWxpYXMgbW9kdWxlOkpzb25SZWZzLmZpbmRSZWZzQXRcbiAqXG4gKiBAZXhhbXBsZVxuICogLy8gRXhhbXBsZSB0aGF0IG9ubHkgcmVzb2x2ZXMgcmVmZXJlbmNlcyB3aXRoaW4gYSBzdWIgZG9jdW1lbnRcbiAqIEpzb25SZWZzLmZpbmRSZWZzQXQoJ2h0dHA6Ly9wZXRzdG9yZS5zd2FnZ2VyLmlvL3YyL3N3YWdnZXIuanNvbicsIHtcbiAqICAgICBzdWJEb2NQYXRoOiAnIy9kZWZpbml0aW9ucydcbiAqICAgfSlcbiAqICAgLnRoZW4oZnVuY3Rpb24gKHJlcykge1xuICogICAgICAvLyBEbyBzb21ldGhpbmcgd2l0aCB0aGUgcmVzcG9uc2VcbiAqICAgICAgLy9cbiAqICAgICAgLy8gcmVzLnJlZnM6IEpTT04gUmVmZXJlbmNlIGxvY2F0aW9ucyBhbmQgZGV0YWlsc1xuICogICAgICAvLyByZXMudmFsdWU6IFRoZSByZXRyaWV2ZWQgZG9jdW1lbnRcbiAqICAgfSwgZnVuY3Rpb24gKGVycikge1xuICogICAgIGNvbnNvbGUubG9nKGVyci5zdGFjayk7XG4gKiAgIH0pO1xuICovXG5mdW5jdGlvbiBmaW5kUmVmc0F0IChsb2NhdGlvbiwgb3B0aW9ucykge1xuICB2YXIgYWxsVGFza3MgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBhbGxUYXNrcyA9IGFsbFRhc2tzXG4gICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVmFsaWRhdGUgdGhlIHByb3ZpZGVkIGxvY2F0aW9uXG4gICAgICBpZiAoIWlzVHlwZShsb2NhdGlvbiwgJ1N0cmluZycpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xvY2F0aW9uIG11c3QgYmUgYSBzdHJpbmcnKTtcbiAgICAgIH1cblxuICAgICAgLy8gU2V0IGRlZmF1bHQgZm9yIG9wdGlvbnNcbiAgICAgIGlmIChpc1R5cGUob3B0aW9ucywgJ1VuZGVmaW5lZCcpKSB7XG4gICAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgb3B0aW9ucyAoRG9pbmcgdGhpcyBoZXJlIGZvciBhIHF1aWNrKVxuICAgICAgdmFsaWRhdGVPcHRpb25zKG9wdGlvbnMpO1xuXG4gICAgICAvLyBDb21iaW5lIHRoZSBsb2NhdGlvbiBhbmQgdGhlIG9wdGlvbmFsIHJlbGF0aXZlIGJhc2VcbiAgICAgIGxvY2F0aW9uID0gY29tYmluZVVSSXMob3B0aW9ucy5yZWxhdGl2ZUJhc2UsIGxvY2F0aW9uKTtcblxuICAgICAgcmV0dXJuIGdldFJlbW90ZURvY3VtZW50KGxvY2F0aW9uLCBvcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKGZ1bmN0aW9uIChyZXMpIHtcbiAgICAgIHZhciBjYWNoZUVudHJ5ID0gY2xvbmUocmVtb3RlQ2FjaGVbbG9jYXRpb25dKTtcbiAgICAgIHZhciBjT3B0aW9ucztcblxuICAgICAgaWYgKGlzVHlwZShjYWNoZUVudHJ5LnJlZnMsICdVbmRlZmluZWQnKSkge1xuICAgICAgICBjT3B0aW9ucyA9IGNsb25lKG9wdGlvbnMpO1xuXG4gICAgICAgIC8vIERvIG5vdCBmaWx0ZXIgYW55IHJlZmVyZW5jZXMgc28gdGhlIGNhY2hlIGlzIGNvbXBsZXRlXG4gICAgICAgIGRlbGV0ZSBjT3B0aW9ucy5maWx0ZXI7XG4gICAgICAgIGRlbGV0ZSBjT3B0aW9ucy5zdWJEb2NQYXRoO1xuXG4gICAgICAgIGNPcHRpb25zLmluY2x1ZGVJbnZhbGlkID0gdHJ1ZTtcblxuICAgICAgICByZW1vdGVDYWNoZVtsb2NhdGlvbl0ucmVmcyA9IGZpbmRSZWZzKHJlcywgY09wdGlvbnMpO1xuXG4gICAgICAgIC8vIEZpbHRlciBvdXQgdGhlIHJlZmVyZW5jZXMgYmFzZWQgb24gb3B0aW9ucy5maWx0ZXIgYW5kIG9wdGlvbnMuc3ViRG9jUGF0aFxuICAgICAgICBjYWNoZUVudHJ5LnJlZnMgPSBmaWx0ZXJSZWZzKG9wdGlvbnMsIHJlbW90ZUNhY2hlW2xvY2F0aW9uXS5yZWZzKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGNhY2hlRW50cnk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIGFsbFRhc2tzO1xufVxuXG4vKipcbiAqIFJldHVybnMgZGV0YWlsZWQgaW5mb3JtYXRpb24gYWJvdXQgdGhlIEpTT04gUmVmZXJlbmNlLlxuICpcbiAqIEBwYXJhbSB7b2JqZWN0fSBvYmogLSBUaGUgSlNPTiBSZWZlcmVuY2UgZGVmaW5pdGlvblxuICpcbiAqIEByZXR1cm5zIHtVbnJlc29sdmVkUmVmRGV0YWlsc30gdGhlIGRldGFpbGVkIGluZm9ybWF0aW9uXG4gKlxuICogQGFsaWFzIG1vZHVsZTpKc29uUmVmcy5nZXRSZWZEZXRhaWxzXG4gKi9cbmZ1bmN0aW9uIGdldFJlZkRldGFpbHMgKG9iaikge1xuICB2YXIgZGV0YWlscyA9IHtcbiAgICBkZWY6IG9ialxuICB9O1xuICB2YXIgY2FjaGVLZXk7XG4gIHZhciBleHRyYUtleXM7XG4gIHZhciB1cmlEZXRhaWxzO1xuXG4gIHRyeSB7XG4gICAgaWYgKGlzUmVmTGlrZShvYmosIHRydWUpKSB7XG4gICAgICBjYWNoZUtleSA9IG9iai4kcmVmO1xuICAgICAgdXJpRGV0YWlscyA9IHVyaURldGFpbHNDYWNoZVtjYWNoZUtleV07XG5cbiAgICAgIGlmIChpc1R5cGUodXJpRGV0YWlscywgJ1VuZGVmaW5lZCcpKSB7XG4gICAgICAgIHVyaURldGFpbHMgPSB1cmlEZXRhaWxzQ2FjaGVbY2FjaGVLZXldID0gVVJJLnBhcnNlKGNhY2hlS2V5KTtcbiAgICAgIH1cblxuICAgICAgZGV0YWlscy51cmkgPSBjYWNoZUtleTtcbiAgICAgIGRldGFpbHMudXJpRGV0YWlscyA9IHVyaURldGFpbHM7XG5cbiAgICAgIGlmIChpc1R5cGUodXJpRGV0YWlscy5lcnJvciwgJ1VuZGVmaW5lZCcpKSB7XG4gICAgICAgIC8vIENvbnZlcnQgdGhlIFVSSSByZWZlcmVuY2UgdG8gb25lIG9mIG91ciB0eXBlc1xuICAgICAgICBzd2l0Y2ggKHVyaURldGFpbHMucmVmZXJlbmNlKSB7XG4gICAgICAgIGNhc2UgJ2Fic29sdXRlJzpcbiAgICAgICAgY2FzZSAndXJpJzpcbiAgICAgICAgICBkZXRhaWxzLnR5cGUgPSAncmVtb3RlJztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnc2FtZS1kb2N1bWVudCc6XG4gICAgICAgICAgZGV0YWlscy50eXBlID0gJ2xvY2FsJztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBkZXRhaWxzLnR5cGUgPSB1cmlEZXRhaWxzLnJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGV0YWlscy5lcnJvciA9IGRldGFpbHMudXJpRGV0YWlscy5lcnJvcjtcbiAgICAgICAgZGV0YWlscy50eXBlID0gJ2ludmFsaWQnO1xuICAgICAgfVxuXG4gICAgICAvLyBJZGVudGlmeSB3YXJuaW5nXG4gICAgICBleHRyYUtleXMgPSBnZXRFeHRyYVJlZktleXMob2JqKTtcblxuICAgICAgaWYgKGV4dHJhS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGRldGFpbHMud2FybmluZyA9ICdFeHRyYSBKU09OIFJlZmVyZW5jZSBwcm9wZXJ0aWVzIHdpbGwgYmUgaWdub3JlZDogJyArIGV4dHJhS2V5cy5qb2luKCcsICcpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBkZXRhaWxzLnR5cGUgPSAnaW52YWxpZCc7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBkZXRhaWxzLmVycm9yID0gZXJyLm1lc3NhZ2U7XG4gICAgZGV0YWlscy50eXBlID0gJ2ludmFsaWQnO1xuICB9XG5cbiAgcmV0dXJuIGRldGFpbHM7XG59XG5cbi8qKlxuICogUmV0dXJucyB3aGV0aGVyIHRoZSBhcmd1bWVudCByZXByZXNlbnRzIGEgSlNPTiBQb2ludGVyLlxuICpcbiAqIEEgc3RyaW5nIGlzIGEgSlNPTiBQb2ludGVyIGlmIHRoZSBmb2xsb3dpbmcgYXJlIGFsbCB0cnVlOlxuICpcbiAqICAgKiBUaGUgc3RyaW5nIGlzIG9mIHR5cGUgYFN0cmluZ2BcbiAqICAgKiBUaGUgc3RyaW5nIG11c3QgYmUgZW1wdHksIGAjYCBvciBzdGFydCB3aXRoIGEgYC9gIG9yIGAjL2BcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gcHRyIC0gVGhlIHN0cmluZyB0byBjaGVja1xuICogQHBhcmFtIHtib29sZWFufSBbdGhyb3dXaXRoRGV0YWlscz1mYWxzZV0gLSBXaGV0aGVyIG9yIG5vdCB0byB0aHJvdyBhbiBgRXJyb3JgIHdpdGggdGhlIGRldGFpbHMgYXMgdG8gd2h5IHRoZSB2YWx1ZVxuICogcHJvdmlkZWQgaXMgaW52YWxpZFxuICpcbiAqIEByZXR1cm5zIHtib29sZWFufSB0aGUgcmVzdWx0IG9mIHRoZSBjaGVja1xuICpcbiAqIEB0aHJvd3Mge2Vycm9yfSB3aGVuIHRoZSBwcm92aWRlZCB2YWx1ZSBpcyBpbnZhbGlkIGFuZCB0aGUgYHRocm93V2l0aERldGFpbHNgIGFyZ3VtZW50IGlzIGB0cnVlYFxuICpcbiAqIEBhbGlhcyBtb2R1bGU6SnNvblJlZnMuaXNQdHJcbiAqXG4gKiBAc2VlIHtAbGluayBodHRwczovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjNjkwMSNzZWN0aW9uLTN9XG4gKlxuICogQGV4YW1wbGVcbiAqIC8vIFNlcGFyYXRpbmcgdGhlIGRpZmZlcmVudCB3YXlzIHRvIGludm9rZSBpc1B0ciBmb3IgZGVtb25zdHJhdGlvbiBwdXJwb3Nlc1xuICogaWYgKGlzUHRyKHN0cikpIHtcbiAqICAgLy8gSGFuZGxlIGEgdmFsaWQgSlNPTiBQb2ludGVyXG4gKiB9IGVsc2Uge1xuICogICAvLyBHZXQgdGhlIHJlYXNvbiBhcyB0byB3aHkgdGhlIHZhbHVlIGlzIG5vdCBhIEpTT04gUG9pbnRlciBzbyB5b3UgY2FuIGZpeC9yZXBvcnQgaXRcbiAqICAgdHJ5IHtcbiAqICAgICBpc1B0cihzdHIsIHRydWUpO1xuICogICB9IGNhdGNoIChlcnIpIHtcbiAqICAgICAvLyBUaGUgZXJyb3IgbWVzc2FnZSBjb250YWlucyB0aGUgZGV0YWlscyBhcyB0byB3aHkgdGhlIHByb3ZpZGVkIHZhbHVlIGlzIG5vdCBhIEpTT04gUG9pbnRlclxuICogICB9XG4gKiB9XG4gKi9cbmZ1bmN0aW9uIGlzUHRyIChwdHIsIHRocm93V2l0aERldGFpbHMpIHtcbiAgdmFyIHZhbGlkID0gdHJ1ZTtcbiAgdmFyIGZpcnN0Q2hhcjtcblxuICB0cnkge1xuICAgIGlmIChpc1R5cGUocHRyLCAnU3RyaW5nJykpIHtcbiAgICAgIGlmIChwdHIgIT09ICcnKSB7XG4gICAgICAgIGZpcnN0Q2hhciA9IHB0ci5jaGFyQXQoMCk7XG5cbiAgICAgICAgaWYgKFsnIycsICcvJ10uaW5kZXhPZihmaXJzdENoYXIpID09PSAtMSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncHRyIG11c3Qgc3RhcnQgd2l0aCBhIC8gb3IgIy8nKTtcbiAgICAgICAgfSBlbHNlIGlmIChmaXJzdENoYXIgPT09ICcjJyAmJiBwdHIgIT09ICcjJyAmJiBwdHIuY2hhckF0KDEpICE9PSAnLycpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3B0ciBtdXN0IHN0YXJ0IHdpdGggYSAvIG9yICMvJyk7XG4gICAgICAgIH0gZWxzZSBpZiAocHRyLm1hdGNoKGJhZFB0clRva2VuUmVnZXgpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdwdHIgaGFzIGludmFsaWQgdG9rZW4ocyknKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3B0ciBpcyBub3QgYSBTdHJpbmcnKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICh0aHJvd1dpdGhEZXRhaWxzID09PSB0cnVlKSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuXG4gICAgdmFsaWQgPSBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiB2YWxpZDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHdoZXRoZXIgdGhlIGFyZ3VtZW50IHJlcHJlc2VudHMgYSBKU09OIFJlZmVyZW5jZS5cbiAqXG4gKiBBbiBvYmplY3QgaXMgYSBKU09OIFJlZmVyZW5jZSBvbmx5IGlmIHRoZSBmb2xsb3dpbmcgYXJlIGFsbCB0cnVlOlxuICpcbiAqICAgKiBUaGUgb2JqZWN0IGlzIG9mIHR5cGUgYE9iamVjdGBcbiAqICAgKiBUaGUgb2JqZWN0IGhhcyBhIGAkcmVmYCBwcm9wZXJ0eVxuICogICAqIFRoZSBgJHJlZmAgcHJvcGVydHkgaXMgYSB2YWxpZCBVUklcbiAqXG4gKiBAcGFyYW0ge29iamVjdH0gb2JqIC0gVGhlIG9iamVjdCB0byBjaGVja1xuICogQHBhcmFtIHtib29sZWFufSBbdGhyb3dXaXRoRGV0YWlscz1mYWxzZV0gLSBXaGV0aGVyIG9yIG5vdCB0byB0aHJvdyBhbiBgRXJyb3JgIHdpdGggdGhlIGRldGFpbHMgYXMgdG8gd2h5IHRoZSB2YWx1ZVxuICogcHJvdmlkZWQgaXMgaW52YWxpZFxuICpcbiAqIEByZXR1cm5zIHtib29sZWFufSB0aGUgcmVzdWx0IG9mIHRoZSBjaGVja1xuICpcbiAqIEB0aHJvd3Mge2Vycm9yfSB3aGVuIHRoZSBwcm92aWRlZCB2YWx1ZSBpcyBpbnZhbGlkIGFuZCB0aGUgYHRocm93V2l0aERldGFpbHNgIGFyZ3VtZW50IGlzIGB0cnVlYFxuICpcbiAqIEBhbGlhcyBtb2R1bGU6SnNvblJlZnMuaXNSZWZcbiAqXG4gKiBAc2VlIHtAbGluayBodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1wYnJ5YW4tenlwLWpzb24tcmVmLTAzI3NlY3Rpb24tM31cbiAqXG4gKiBAZXhhbXBsZVxuICogLy8gU2VwYXJhdGluZyB0aGUgZGlmZmVyZW50IHdheXMgdG8gaW52b2tlIGlzUmVmIGZvciBkZW1vbnN0cmF0aW9uIHB1cnBvc2VzXG4gKiBpZiAoaXNSZWYob2JqKSkge1xuICogICAvLyBIYW5kbGUgYSB2YWxpZCBKU09OIFJlZmVyZW5jZVxuICogfSBlbHNlIHtcbiAqICAgLy8gR2V0IHRoZSByZWFzb24gYXMgdG8gd2h5IHRoZSB2YWx1ZSBpcyBub3QgYSBKU09OIFJlZmVyZW5jZSBzbyB5b3UgY2FuIGZpeC9yZXBvcnQgaXRcbiAqICAgdHJ5IHtcbiAqICAgICBpc1JlZihzdHIsIHRydWUpO1xuICogICB9IGNhdGNoIChlcnIpIHtcbiAqICAgICAvLyBUaGUgZXJyb3IgbWVzc2FnZSBjb250YWlucyB0aGUgZGV0YWlscyBhcyB0byB3aHkgdGhlIHByb3ZpZGVkIHZhbHVlIGlzIG5vdCBhIEpTT04gUmVmZXJlbmNlXG4gKiAgIH1cbiAqIH1cbiAqL1xuZnVuY3Rpb24gaXNSZWYgKG9iaiwgdGhyb3dXaXRoRGV0YWlscykge1xuICByZXR1cm4gaXNSZWZMaWtlKG9iaiwgdGhyb3dXaXRoRGV0YWlscykgJiYgZ2V0UmVmRGV0YWlscyhvYmosIHRocm93V2l0aERldGFpbHMpLnR5cGUgIT09ICdpbnZhbGlkJztcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGFuIGFycmF5IG9mIHBhdGggc2VnbWVudHMgZm9yIHRoZSBwcm92aWRlZCBKU09OIFBvaW50ZXIuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHB0ciAtIFRoZSBKU09OIFBvaW50ZXJcbiAqXG4gKiBAcmV0dXJucyB7c3RyaW5nW119IHRoZSBwYXRoIHNlZ21lbnRzXG4gKlxuICogQHRocm93cyB7RXJyb3J9IGlmIHRoZSBwcm92aWRlZCBgcHRyYCBhcmd1bWVudCBpcyBub3QgYSBKU09OIFBvaW50ZXJcbiAqXG4gKiBAYWxpYXMgbW9kdWxlOkpzb25SZWZzLnBhdGhGcm9tUHRyXG4gKi9cbmZ1bmN0aW9uIHBhdGhGcm9tUHRyIChwdHIpIHtcbiAgaWYgKCFpc1B0cihwdHIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwdHIgbXVzdCBiZSBhIEpTT04gUG9pbnRlcicpO1xuICB9XG5cbiAgdmFyIHNlZ21lbnRzID0gcHRyLnNwbGl0KCcvJyk7XG5cbiAgLy8gUmVtb3ZlIHRoZSBmaXJzdCBzZWdtZW50XG4gIHNlZ21lbnRzLnNoaWZ0KCk7XG5cbiAgcmV0dXJuIGRlY29kZVBhdGgoc2VnbWVudHMpO1xufVxuXG4vKipcbiAqIFJldHVybnMgYSBKU09OIFBvaW50ZXIgZm9yIHRoZSBwcm92aWRlZCBhcnJheSBvZiBwYXRoIHNlZ21lbnRzLlxuICpcbiAqICoqTm90ZToqKiBJZiBhIHBhdGggc2VnbWVudCBpbiBgcGF0aGAgaXMgbm90IGEgYFN0cmluZ2AsIGl0IHdpbGwgYmUgY29udmVydGVkIHRvIG9uZSB1c2luZyBgSlNPTi5zdHJpbmdpZnlgLlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nW119IHBhdGggLSBUaGUgYXJyYXkgb2YgcGF0aCBzZWdtZW50c1xuICogQHBhcmFtIHtib29sZWFufSBbaGFzaFByZWZpeD10cnVlXSAtIFdoZXRoZXIgb3Igbm90IGNyZWF0ZSBhIGhhc2gtcHJlZml4ZWQgSlNPTiBQb2ludGVyXG4gKlxuICogQHJldHVybnMge3N0cmluZ30gdGhlIGNvcnJlc3BvbmRpbmcgSlNPTiBQb2ludGVyXG4gKlxuICogQHRocm93cyB7RXJyb3J9IGlmIHRoZSBgcGF0aGAgYXJndW1lbnQgaXMgbm90IGFuIGFycmF5XG4gKlxuICogQGFsaWFzIG1vZHVsZTpKc29uUmVmcy5wYXRoVG9QdHJcbiAqL1xuZnVuY3Rpb24gcGF0aFRvUHRyIChwYXRoLCBoYXNoUHJlZml4KSB7XG4gIGlmICghaXNUeXBlKHBhdGgsICdBcnJheScpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwYXRoIG11c3QgYmUgYW4gQXJyYXknKTtcbiAgfVxuXG4gIC8vIEVuY29kZSBlYWNoIHNlZ21lbnQgYW5kIHJldHVyblxuICByZXR1cm4gKGhhc2hQcmVmaXggIT09IGZhbHNlID8gJyMnIDogJycpICsgKHBhdGgubGVuZ3RoID4gMCA/ICcvJyA6ICcnKSArIGVuY29kZVBhdGgocGF0aCkuam9pbignLycpO1xufVxuXG4vKipcbiAqIEZpbmRzIEpTT04gUmVmZXJlbmNlcyBkZWZpbmVkIHdpdGhpbiB0aGUgcHJvdmlkZWQgYXJyYXkvb2JqZWN0IGFuZCByZXNvbHZlcyB0aGVtLlxuICpcbiAqIEBwYXJhbSB7YXJyYXl8b2JqZWN0fSBvYmogLSBUaGUgc3RydWN0dXJlIHRvIGZpbmQgSlNPTiBSZWZlcmVuY2VzIHdpdGhpblxuICogQHBhcmFtIHtKc29uUmVmc09wdGlvbnN9IFtvcHRpb25zXSAtIFRoZSBKc29uUmVmcyBvcHRpb25zXG4gKlxuICogQHJldHVybnMge1Byb21pc2V9IGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIGEge0BsaW5rIG1vZHVsZTpKc29uUmVmc35SZXNvbHZlZFJlZnNSZXN1bHRzfSBhbmQgcmVqZWN0cyB3aXRoIGFuXG4gKiBgRXJyb3JgIHdoZW4gdGhlIGlucHV0IGFyZ3VtZW50cyBmYWlsIHZhbGlkYXRpb24sIHdoZW4gYG9wdGlvbnMuc3ViRG9jUGF0aGAgcG9pbnRzIHRvIGFuIGludmFsaWQgbG9jYXRpb24gb3Igd2hlblxuICogIHRoZSBsb2NhdGlvbiBhcmd1bWVudCBwb2ludHMgdG8gYW4gdW5sb2FkYWJsZSByZXNvdXJjZVxuICpcbiAqIEBhbGlhcyBtb2R1bGU6SnNvblJlZnMucmVzb2x2ZVJlZnNcbiAqXG4gKiBAZXhhbXBsZVxuICogLy8gRXhhbXBsZSB0aGF0IG9ubHkgcmVzb2x2ZXMgcmVsYXRpdmUgYW5kIHJlbW90ZSByZWZlcmVuY2VzXG4gKiBKc29uUmVmcy5yZXNvbHZlUmVmcyhzd2FnZ2VyT2JqLCB7XG4gKiAgICAgZmlsdGVyOiBbJ3JlbGF0aXZlJywgJ3JlbW90ZSddXG4gKiAgIH0pXG4gKiAgIC50aGVuKGZ1bmN0aW9uIChyZXMpIHtcbiAqICAgICAgLy8gRG8gc29tZXRoaW5nIHdpdGggdGhlIHJlc3BvbnNlXG4gKiAgICAgIC8vXG4gKiAgICAgIC8vIHJlcy5yZWZzOiBKU09OIFJlZmVyZW5jZSBsb2NhdGlvbnMgYW5kIGRldGFpbHNcbiAqICAgICAgLy8gcmVzLnJlc29sdmVkOiBUaGUgZG9jdW1lbnQgd2l0aCB0aGUgYXBwcm9wcmlhdGUgSlNPTiBSZWZlcmVuY2VzIHJlc29sdmVkXG4gKiAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAqICAgICBjb25zb2xlLmxvZyhlcnIuc3RhY2spO1xuICogICB9KTtcbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVJlZnMgKG9iaiwgb3B0aW9ucykge1xuICB2YXIgYWxsVGFza3MgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBhbGxUYXNrcyA9IGFsbFRhc2tzXG4gICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVmFsaWRhdGUgdGhlIHByb3ZpZGVkIGRvY3VtZW50XG4gICAgICBpZiAoIWlzVHlwZShvYmosICdBcnJheScpICYmICFpc1R5cGUob2JqLCAnT2JqZWN0JykpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignb2JqIG11c3QgYmUgYW4gQXJyYXkgb3IgYW4gT2JqZWN0Jyk7XG4gICAgICB9XG5cbiAgICAgIC8vIFNldCBkZWZhdWx0IGZvciBvcHRpb25zXG4gICAgICBpZiAoaXNUeXBlKG9wdGlvbnMsICdVbmRlZmluZWQnKSkge1xuICAgICAgICBvcHRpb25zID0ge307XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIG9wdGlvbnNcbiAgICAgIHZhbGlkYXRlT3B0aW9ucyhvcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgIC8vIEZpbmQgYWxsIHJlZmVyZW5jZXMgcmVjdXJzaXZlbHlcbiAgICAgIHJldHVybiBmaW5kQWxsUmVmcyhvYmosIG9wdGlvbnMsIFtdLCBbXSwge30pO1xuICAgIH0pXG4gICAgLnRoZW4oZnVuY3Rpb24gKGFSZWZzKSB7XG4gICAgICB2YXIgY2xvbmVkID0gY2xvbmUob2JqKTtcbiAgICAgIHZhciBwYXJlbnRMb2NhdGlvbnMgPSBbXTtcblxuICAgICAgLy8gUmVwbGFjZSByZW1vdGUgcmVmZXJlbmNlcyBmaXJzdFxuICAgICAgT2JqZWN0LmtleXMoYVJlZnMpLmZvckVhY2goZnVuY3Rpb24gKHJlZlB0cikge1xuICAgICAgICB2YXIgcmVmRGV0YWlscyA9IGFSZWZzW3JlZlB0cl07XG4gICAgICAgIHZhciB2YWx1ZTtcblxuICAgICAgICBpZiAocmVtb3RlVHlwZXMuaW5kZXhPZihyZWZEZXRhaWxzLnR5cGUpID4gLTEpIHtcbiAgICAgICAgICBpZiAoaXNUeXBlKHJlZkRldGFpbHMuZXJyb3IsICdVbmRlZmluZWQnKSAmJiByZWZEZXRhaWxzLnR5cGUgIT09ICdpbnZhbGlkJykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgdmFsdWUgPSBmaW5kVmFsdWUocmVmRGV0YWlscy52YWx1ZSB8fCB7fSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmRGV0YWlscy51cmlEZXRhaWxzLmZyYWdtZW50ID9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF0aEZyb21QdHIocmVmRGV0YWlscy51cmlEZXRhaWxzLmZyYWdtZW50KSA6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW10pO1xuICAgICAgICAgICAgICBzZXRWYWx1ZShjbG9uZWQsIHBhdGhGcm9tUHRyKHJlZlB0ciksIHZhbHVlKTtcblxuICAgICAgICAgICAgICAvLyBUaGUgcmVmZXJlbmNlIGluY2x1ZGVzIGEgZnJhZ21lbnQgc28gdXBkYXRlIHRoZSByZWZlcmVuY2UgZGV0YWlsc1xuICAgICAgICAgICAgICBpZiAoIWlzVHlwZShyZWZEZXRhaWxzLnZhbHVlLCAnVW5kZWZpbmVkJykpIHtcbiAgICAgICAgICAgICAgICByZWZEZXRhaWxzLnZhbHVlID0gdmFsdWU7XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVmRGV0YWlscy5jaXJjdWxhcikge1xuICAgICAgICAgICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIHZhbHVlIGFuZCBpdCdzIGNpcmN1bGFyLCBzZXQgaXRzIHZhbHVlIHRvIGFuIGVtcHR5IHZhbHVlXG4gICAgICAgICAgICAgICAgcmVmRGV0YWlscy52YWx1ZSA9IHt9O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgcmVmRGV0YWlscy5lcnJvciA9IGVyci5tZXNzYWdlO1xuICAgICAgICAgICAgICByZWZEZXRhaWxzLm1pc3NpbmcgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZWZEZXRhaWxzLm1pc3NpbmcgPSB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIC8vIFJlcGxhY2UgbG9jYWwgcmVmZXJlbmNlc1xuICAgICAgT2JqZWN0LmtleXMoYVJlZnMpLmZvckVhY2goZnVuY3Rpb24gKHJlZlB0cikge1xuICAgICAgICB2YXIgcmVmRGV0YWlscyA9IGFSZWZzW3JlZlB0cl07XG4gICAgICAgIHZhciBwYXJlbnRMb2NhdGlvbiA9IHJlZkRldGFpbHMucGFyZW50TG9jYXRpb247XG4gICAgICAgIHZhciB2YWx1ZTtcblxuICAgICAgICAvLyBSZWNvcmQgdGhhdCB0aGlzIHJlZmVyZW5jZSBoYXMgcGFyZW50IGxvY2F0aW9uIGRldGFpbHMgc28gd2UgY2FuIGNsZWFuIGl0IHVwIGxhdGVyXG4gICAgICAgIGlmICghaXNUeXBlKHBhcmVudExvY2F0aW9uLCAnVW5kZWZpbmVkJykgJiYgcGFyZW50TG9jYXRpb25zLmluZGV4T2YocmVmUHRyKSA9PT0gLTEpIHtcbiAgICAgICAgICBwYXJlbnRMb2NhdGlvbnMucHVzaChyZWZQdHIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlbW90ZVR5cGVzLmluZGV4T2YocmVmRGV0YWlscy50eXBlKSA9PT0gLTEgJiYgcmVmRGV0YWlscy50eXBlICE9PSAnaW52YWxpZCcpIHtcbiAgICAgICAgICBpZiAoaXNUeXBlKHJlZkRldGFpbHMuZXJyb3IsICdVbmRlZmluZWQnKSkge1xuICAgICAgICAgICAgaWYgKHJlZlB0ci5pbmRleE9mKHJlZkRldGFpbHMudXJpKSA+IC0xKSB7XG4gICAgICAgICAgICAgIHJlZkRldGFpbHMuY2lyY3VsYXIgPSB0cnVlO1xuICAgICAgICAgICAgICB2YWx1ZSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgaWYgKCFpc1R5cGUocGFyZW50TG9jYXRpb24sICdVbmRlZmluZWQnKSkge1xuICAgICAgICAgICAgICAgIC8vIEF0dGVtcHQgdG8gZ2V0IHRoZSByZWZlcmVuY2VkIHZhbHVlIGZyb20gdGhlIHJlbW90ZSBkb2N1bWVudCBmaXJzdFxuICAgICAgICAgICAgICAgIHZhbHVlID0gZmluZFZhbHVlKGZpbmRWYWx1ZShjbG9uZWQsIHBhdGhGcm9tUHRyKHBhcmVudExvY2F0aW9uKSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmRGV0YWlscy51cmlEZXRhaWxzLmZyYWdtZW50ID9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhGcm9tUHRyKHJlZkRldGFpbHMudXJpRGV0YWlscy5mcmFnbWVudCkgOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW10sIHRydWUpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGlmIChpc1R5cGUodmFsdWUsICdVbmRlZmluZWQnKSkge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gZmluZFZhbHVlKGNsb25lZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZEZXRhaWxzLnVyaURldGFpbHMuZnJhZ21lbnQgP1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhGcm9tUHRyKHJlZkRldGFpbHMudXJpRGV0YWlscy5mcmFnbWVudCkgOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW10pO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgc2V0VmFsdWUoY2xvbmVkLCBwYXRoRnJvbVB0cihyZWZQdHIpLCB2YWx1ZSk7XG5cbiAgICAgICAgICAgICAgcmVmRGV0YWlscy52YWx1ZSA9IHZhbHVlO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgIHJlZkRldGFpbHMuZXJyb3IgPSBlcnIubWVzc2FnZTtcbiAgICAgICAgICAgICAgcmVmRGV0YWlscy5taXNzaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVmRGV0YWlscy5taXNzaW5nID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBSZW1vdmUgYWxsIHBhcmVudExvY2F0aW9uIHZhbHVlc1xuICAgICAgcGFyZW50TG9jYXRpb25zLmZvckVhY2goZnVuY3Rpb24gKHJlZlB0cikge1xuICAgICAgICBkZWxldGUgYVJlZnNbcmVmUHRyXS5wYXJlbnRMb2NhdGlvbjtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWZzOiBhUmVmcyxcbiAgICAgICAgcmVzb2x2ZWQ6IGNsb25lZFxuICAgICAgfTtcbiAgICB9KTtcblxuICByZXR1cm4gYWxsVGFza3M7XG59XG5cbi8qKlxuICogUmVzb2x2ZXMgSlNPTiBSZWZlcmVuY2VzIGRlZmluZWQgd2l0aGluIHRoZSBkb2N1bWVudCBhdCB0aGUgcHJvdmlkZWQgbG9jYXRpb24uXG4gKlxuICogVGhpcyBBUEkgaXMgaWRlbnRpY2FsIHRvIHtAbGluayBtb2R1bGU6SnNvblJlZnMucmVzb2x2ZVJlZnN9IGV4Y2VwdCB0aGlzIEFQSSB3aWxsIHJldHJpZXZlIGEgcmVtb3RlIGRvY3VtZW50IGFuZCB0aGVuXG4gKiByZXR1cm4gdGhlIHJlc3VsdCBvZiB7QGxpbmsgbW9kdWxlOkpzb25SZWZzLnJlc29sdmVSZWZzfSBvbiB0aGUgcmV0cmlldmVkIGRvY3VtZW50LlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBsb2NhdGlvbiAtIFRoZSBsb2NhdGlvbiB0byByZXRyaWV2ZSAqKENhbiBiZSByZWxhdGl2ZSBvciBhYnNvbHV0ZSwganVzdCBtYWtlIHN1cmUgeW91IGxvb2sgYXQgdGhlXG4gKiB7QGxpbmsgbW9kdWxlOkpzb25SZWZzfkpzb25SZWZzT3B0aW9uc3xvcHRpb25zIGRvY3VtZW50YXRpb259IHRvIHNlZSBob3cgcmVsYXRpdmUgcmVmZXJlbmNlcyBhcmUgaGFuZGxlZC4pKlxuICogQHBhcmFtIHtKc29uUmVmc09wdGlvbnN9IFtvcHRpb25zXSAtIFRoZSBKc29uUmVmcyBvcHRpb25zXG4gKlxuICogQHJldHVybnMge1Byb21pc2V9IGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIGEge0BsaW5rIG1vZHVsZTpKc29uUmVmc35SZXRyaWV2ZWRSZXNvbHZlZFJlZnNSZXN1bHRzfSBhbmQgcmVqZWN0cyB3aXRoIGFuXG4gKiBgRXJyb3JgIHdoZW4gdGhlIGlucHV0IGFyZ3VtZW50cyBmYWlsIHZhbGlkYXRpb24sIHdoZW4gYG9wdGlvbnMuc3ViRG9jUGF0aGAgcG9pbnRzIHRvIGFuIGludmFsaWQgbG9jYXRpb24gb3Igd2hlblxuICogIHRoZSBsb2NhdGlvbiBhcmd1bWVudCBwb2ludHMgdG8gYW4gdW5sb2FkYWJsZSByZXNvdXJjZVxuICpcbiAqIEBhbGlhcyBtb2R1bGU6SnNvblJlZnMucmVzb2x2ZVJlZnNBdFxuICpcbiAqIEBleGFtcGxlXG4gKiAvLyBFeGFtcGxlIHRoYXQgbG9hZHMgYSBKU09OIGRvY3VtZW50IChObyBvcHRpb25zLmxvYWRlck9wdGlvbnMucHJvY2Vzc0NvbnRlbnQgcmVxdWlyZWQpIGFuZCByZXNvbHZlcyBhbGwgcmVmZXJlbmNlc1xuICogSnNvblJlZnMucmVzb2x2ZVJlZnNBdCgnLi9zd2FnZ2VyLmpzb24nKVxuICogICAudGhlbihmdW5jdGlvbiAocmVzKSB7XG4gKiAgICAgIC8vIERvIHNvbWV0aGluZyB3aXRoIHRoZSByZXNwb25zZVxuICogICAgICAvL1xuICogICAgICAvLyByZXMucmVmczogSlNPTiBSZWZlcmVuY2UgbG9jYXRpb25zIGFuZCBkZXRhaWxzXG4gKiAgICAgIC8vIHJlcy5yZXNvbHZlZDogVGhlIGRvY3VtZW50IHdpdGggdGhlIGFwcHJvcHJpYXRlIEpTT04gUmVmZXJlbmNlcyByZXNvbHZlZFxuICogICAgICAvLyByZXMudmFsdWU6IFRoZSByZXRyaWV2ZWQgZG9jdW1lbnRcbiAqICAgfSwgZnVuY3Rpb24gKGVycikge1xuICogICAgIGNvbnNvbGUubG9nKGVyci5zdGFjayk7XG4gKiAgIH0pO1xuICovXG5mdW5jdGlvbiByZXNvbHZlUmVmc0F0IChsb2NhdGlvbiwgb3B0aW9ucykge1xuICB2YXIgYWxsVGFza3MgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBhbGxUYXNrcyA9IGFsbFRhc2tzXG4gICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVmFsaWRhdGUgdGhlIHByb3ZpZGVkIGxvY2F0aW9uXG4gICAgICBpZiAoIWlzVHlwZShsb2NhdGlvbiwgJ1N0cmluZycpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xvY2F0aW9uIG11c3QgYmUgYSBzdHJpbmcnKTtcbiAgICAgIH1cblxuICAgICAgLy8gU2V0IGRlZmF1bHQgZm9yIG9wdGlvbnNcbiAgICAgIGlmIChpc1R5cGUob3B0aW9ucywgJ1VuZGVmaW5lZCcpKSB7XG4gICAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgb3B0aW9ucyAoRG9pbmcgdGhpcyBoZXJlIGZvciBhIHF1aWNrKVxuICAgICAgdmFsaWRhdGVPcHRpb25zKG9wdGlvbnMpO1xuXG4gICAgICAvLyBDb21iaW5lIHRoZSBsb2NhdGlvbiBhbmQgdGhlIG9wdGlvbmFsIHJlbGF0aXZlIGJhc2VcbiAgICAgIGxvY2F0aW9uID0gY29tYmluZVVSSXMob3B0aW9ucy5yZWxhdGl2ZUJhc2UsIGxvY2F0aW9uKTtcblxuICAgICAgcmV0dXJuIGdldFJlbW90ZURvY3VtZW50KGxvY2F0aW9uLCBvcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKGZ1bmN0aW9uIChyZXMpIHtcbiAgICAgIHZhciBjT3B0aW9ucyA9IGNsb25lKG9wdGlvbnMpO1xuXG4gICAgICAvLyBVcGRhdGUgdGhlIHJlbGF0aXZlIGJhc2UgYmFzZWQgb24gdGhlIHJldHJpZXZlZCBsb2NhdGlvblxuICAgICAgY09wdGlvbnMucmVsYXRpdmVCYXNlID0gZGlybmFtZShsb2NhdGlvbik7XG5cbiAgICAgIHJldHVybiByZXNvbHZlUmVmcyhyZXMsIGNPcHRpb25zKVxuICAgICAgICAudGhlbihmdW5jdGlvbiAocmVzMikge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICByZWZzOiByZXMyLnJlZnMsXG4gICAgICAgICAgICByZXNvbHZlZDogcmVzMi5yZXNvbHZlZCxcbiAgICAgICAgICAgIHZhbHVlOiByZXNcbiAgICAgICAgICB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcblxuICByZXR1cm4gYWxsVGFza3M7XG59XG5cbi8qIEV4cG9ydCB0aGUgbW9kdWxlIG1lbWJlcnMgKi9cbm1vZHVsZS5leHBvcnRzLmNsZWFyQ2FjaGUgPSBjbGVhckNhY2hlO1xubW9kdWxlLmV4cG9ydHMuZGVjb2RlUGF0aCA9IGRlY29kZVBhdGg7XG5tb2R1bGUuZXhwb3J0cy5lbmNvZGVQYXRoID0gZW5jb2RlUGF0aDtcbm1vZHVsZS5leHBvcnRzLmZpbmRSZWZzID0gZmluZFJlZnM7XG5tb2R1bGUuZXhwb3J0cy5maW5kUmVmc0F0ID0gZmluZFJlZnNBdDtcbm1vZHVsZS5leHBvcnRzLmdldFJlZkRldGFpbHMgPSBnZXRSZWZEZXRhaWxzO1xubW9kdWxlLmV4cG9ydHMuaXNQdHIgPSBpc1B0cjtcbm1vZHVsZS5leHBvcnRzLmlzUmVmID0gaXNSZWY7XG5tb2R1bGUuZXhwb3J0cy5wYXRoRnJvbVB0ciA9IHBhdGhGcm9tUHRyO1xubW9kdWxlLmV4cG9ydHMucGF0aFRvUHRyID0gcGF0aFRvUHRyO1xubW9kdWxlLmV4cG9ydHMucmVzb2x2ZVJlZnMgPSByZXNvbHZlUmVmcztcbm1vZHVsZS5leHBvcnRzLnJlc29sdmVSZWZzQXQgPSByZXNvbHZlUmVmc0F0O1xuIiwiLyohIE5hdGl2ZSBQcm9taXNlIE9ubHlcbiAgICB2MC44LjEgKGMpIEt5bGUgU2ltcHNvblxuICAgIE1JVCBMaWNlbnNlOiBodHRwOi8vZ2V0aWZ5Lm1pdC1saWNlbnNlLm9yZ1xuKi9cblxuKGZ1bmN0aW9uIFVNRChuYW1lLGNvbnRleHQsZGVmaW5pdGlvbil7XG5cdC8vIHNwZWNpYWwgZm9ybSBvZiBVTUQgZm9yIHBvbHlmaWxsaW5nIGFjcm9zcyBldmlyb25tZW50c1xuXHRjb250ZXh0W25hbWVdID0gY29udGV4dFtuYW1lXSB8fCBkZWZpbml0aW9uKCk7XG5cdGlmICh0eXBlb2YgbW9kdWxlICE9IFwidW5kZWZpbmVkXCIgJiYgbW9kdWxlLmV4cG9ydHMpIHsgbW9kdWxlLmV4cG9ydHMgPSBjb250ZXh0W25hbWVdOyB9XG5cdGVsc2UgaWYgKHR5cGVvZiBkZWZpbmUgPT0gXCJmdW5jdGlvblwiICYmIGRlZmluZS5hbWQpIHsgZGVmaW5lKGZ1bmN0aW9uICRBTUQkKCl7IHJldHVybiBjb250ZXh0W25hbWVdOyB9KTsgfVxufSkoXCJQcm9taXNlXCIsdHlwZW9mIGdsb2JhbCAhPSBcInVuZGVmaW5lZFwiID8gZ2xvYmFsIDogdGhpcyxmdW5jdGlvbiBERUYoKXtcblx0Lypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cblx0XCJ1c2Ugc3RyaWN0XCI7XG5cblx0dmFyIGJ1aWx0SW5Qcm9wLCBjeWNsZSwgc2NoZWR1bGluZ19xdWV1ZSxcblx0XHRUb1N0cmluZyA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcsXG5cdFx0dGltZXIgPSAodHlwZW9mIHNldEltbWVkaWF0ZSAhPSBcInVuZGVmaW5lZFwiKSA/XG5cdFx0XHRmdW5jdGlvbiB0aW1lcihmbikgeyByZXR1cm4gc2V0SW1tZWRpYXRlKGZuKTsgfSA6XG5cdFx0XHRzZXRUaW1lb3V0XG5cdDtcblxuXHQvLyBkYW1taXQsIElFOC5cblx0dHJ5IHtcblx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkoe30sXCJ4XCIse30pO1xuXHRcdGJ1aWx0SW5Qcm9wID0gZnVuY3Rpb24gYnVpbHRJblByb3Aob2JqLG5hbWUsdmFsLGNvbmZpZykge1xuXHRcdFx0cmV0dXJuIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShvYmosbmFtZSx7XG5cdFx0XHRcdHZhbHVlOiB2YWwsXG5cdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxuXHRcdFx0XHRjb25maWd1cmFibGU6IGNvbmZpZyAhPT0gZmFsc2Vcblx0XHRcdH0pO1xuXHRcdH07XG5cdH1cblx0Y2F0Y2ggKGVycikge1xuXHRcdGJ1aWx0SW5Qcm9wID0gZnVuY3Rpb24gYnVpbHRJblByb3Aob2JqLG5hbWUsdmFsKSB7XG5cdFx0XHRvYmpbbmFtZV0gPSB2YWw7XG5cdFx0XHRyZXR1cm4gb2JqO1xuXHRcdH07XG5cdH1cblxuXHQvLyBOb3RlOiB1c2luZyBhIHF1ZXVlIGluc3RlYWQgb2YgYXJyYXkgZm9yIGVmZmljaWVuY3lcblx0c2NoZWR1bGluZ19xdWV1ZSA9IChmdW5jdGlvbiBRdWV1ZSgpIHtcblx0XHR2YXIgZmlyc3QsIGxhc3QsIGl0ZW07XG5cblx0XHRmdW5jdGlvbiBJdGVtKGZuLHNlbGYpIHtcblx0XHRcdHRoaXMuZm4gPSBmbjtcblx0XHRcdHRoaXMuc2VsZiA9IHNlbGY7XG5cdFx0XHR0aGlzLm5leHQgPSB2b2lkIDA7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdGFkZDogZnVuY3Rpb24gYWRkKGZuLHNlbGYpIHtcblx0XHRcdFx0aXRlbSA9IG5ldyBJdGVtKGZuLHNlbGYpO1xuXHRcdFx0XHRpZiAobGFzdCkge1xuXHRcdFx0XHRcdGxhc3QubmV4dCA9IGl0ZW07XG5cdFx0XHRcdH1cblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0Zmlyc3QgPSBpdGVtO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGxhc3QgPSBpdGVtO1xuXHRcdFx0XHRpdGVtID0gdm9pZCAwO1xuXHRcdFx0fSxcblx0XHRcdGRyYWluOiBmdW5jdGlvbiBkcmFpbigpIHtcblx0XHRcdFx0dmFyIGYgPSBmaXJzdDtcblx0XHRcdFx0Zmlyc3QgPSBsYXN0ID0gY3ljbGUgPSB2b2lkIDA7XG5cblx0XHRcdFx0d2hpbGUgKGYpIHtcblx0XHRcdFx0XHRmLmZuLmNhbGwoZi5zZWxmKTtcblx0XHRcdFx0XHRmID0gZi5uZXh0O1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fTtcblx0fSkoKTtcblxuXHRmdW5jdGlvbiBzY2hlZHVsZShmbixzZWxmKSB7XG5cdFx0c2NoZWR1bGluZ19xdWV1ZS5hZGQoZm4sc2VsZik7XG5cdFx0aWYgKCFjeWNsZSkge1xuXHRcdFx0Y3ljbGUgPSB0aW1lcihzY2hlZHVsaW5nX3F1ZXVlLmRyYWluKTtcblx0XHR9XG5cdH1cblxuXHQvLyBwcm9taXNlIGR1Y2sgdHlwaW5nXG5cdGZ1bmN0aW9uIGlzVGhlbmFibGUobykge1xuXHRcdHZhciBfdGhlbiwgb190eXBlID0gdHlwZW9mIG87XG5cblx0XHRpZiAobyAhPSBudWxsICYmXG5cdFx0XHQoXG5cdFx0XHRcdG9fdHlwZSA9PSBcIm9iamVjdFwiIHx8IG9fdHlwZSA9PSBcImZ1bmN0aW9uXCJcblx0XHRcdClcblx0XHQpIHtcblx0XHRcdF90aGVuID0gby50aGVuO1xuXHRcdH1cblx0XHRyZXR1cm4gdHlwZW9mIF90aGVuID09IFwiZnVuY3Rpb25cIiA/IF90aGVuIDogZmFsc2U7XG5cdH1cblxuXHRmdW5jdGlvbiBub3RpZnkoKSB7XG5cdFx0Zm9yICh2YXIgaT0wOyBpPHRoaXMuY2hhaW4ubGVuZ3RoOyBpKyspIHtcblx0XHRcdG5vdGlmeUlzb2xhdGVkKFxuXHRcdFx0XHR0aGlzLFxuXHRcdFx0XHQodGhpcy5zdGF0ZSA9PT0gMSkgPyB0aGlzLmNoYWluW2ldLnN1Y2Nlc3MgOiB0aGlzLmNoYWluW2ldLmZhaWx1cmUsXG5cdFx0XHRcdHRoaXMuY2hhaW5baV1cblx0XHRcdCk7XG5cdFx0fVxuXHRcdHRoaXMuY2hhaW4ubGVuZ3RoID0gMDtcblx0fVxuXG5cdC8vIE5PVEU6IFRoaXMgaXMgYSBzZXBhcmF0ZSBmdW5jdGlvbiB0byBpc29sYXRlXG5cdC8vIHRoZSBgdHJ5Li5jYXRjaGAgc28gdGhhdCBvdGhlciBjb2RlIGNhbiBiZVxuXHQvLyBvcHRpbWl6ZWQgYmV0dGVyXG5cdGZ1bmN0aW9uIG5vdGlmeUlzb2xhdGVkKHNlbGYsY2IsY2hhaW4pIHtcblx0XHR2YXIgcmV0LCBfdGhlbjtcblx0XHR0cnkge1xuXHRcdFx0aWYgKGNiID09PSBmYWxzZSkge1xuXHRcdFx0XHRjaGFpbi5yZWplY3Qoc2VsZi5tc2cpO1xuXHRcdFx0fVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGlmIChjYiA9PT0gdHJ1ZSkge1xuXHRcdFx0XHRcdHJldCA9IHNlbGYubXNnO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdHJldCA9IGNiLmNhbGwodm9pZCAwLHNlbGYubXNnKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChyZXQgPT09IGNoYWluLnByb21pc2UpIHtcblx0XHRcdFx0XHRjaGFpbi5yZWplY3QoVHlwZUVycm9yKFwiUHJvbWlzZS1jaGFpbiBjeWNsZVwiKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0ZWxzZSBpZiAoX3RoZW4gPSBpc1RoZW5hYmxlKHJldCkpIHtcblx0XHRcdFx0XHRfdGhlbi5jYWxsKHJldCxjaGFpbi5yZXNvbHZlLGNoYWluLnJlamVjdCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0Y2hhaW4ucmVzb2x2ZShyZXQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGNhdGNoIChlcnIpIHtcblx0XHRcdGNoYWluLnJlamVjdChlcnIpO1xuXHRcdH1cblx0fVxuXG5cdGZ1bmN0aW9uIHJlc29sdmUobXNnKSB7XG5cdFx0dmFyIF90aGVuLCBzZWxmID0gdGhpcztcblxuXHRcdC8vIGFscmVhZHkgdHJpZ2dlcmVkP1xuXHRcdGlmIChzZWxmLnRyaWdnZXJlZCkgeyByZXR1cm47IH1cblxuXHRcdHNlbGYudHJpZ2dlcmVkID0gdHJ1ZTtcblxuXHRcdC8vIHVud3JhcFxuXHRcdGlmIChzZWxmLmRlZikge1xuXHRcdFx0c2VsZiA9IHNlbGYuZGVmO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRpZiAoX3RoZW4gPSBpc1RoZW5hYmxlKG1zZykpIHtcblx0XHRcdFx0c2NoZWR1bGUoZnVuY3Rpb24oKXtcblx0XHRcdFx0XHR2YXIgZGVmX3dyYXBwZXIgPSBuZXcgTWFrZURlZldyYXBwZXIoc2VsZik7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdF90aGVuLmNhbGwobXNnLFxuXHRcdFx0XHRcdFx0XHRmdW5jdGlvbiAkcmVzb2x2ZSQoKXsgcmVzb2x2ZS5hcHBseShkZWZfd3JhcHBlcixhcmd1bWVudHMpOyB9LFxuXHRcdFx0XHRcdFx0XHRmdW5jdGlvbiAkcmVqZWN0JCgpeyByZWplY3QuYXBwbHkoZGVmX3dyYXBwZXIsYXJndW1lbnRzKTsgfVxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdFx0cmVqZWN0LmNhbGwoZGVmX3dyYXBwZXIsZXJyKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pXG5cdFx0XHR9XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0c2VsZi5tc2cgPSBtc2c7XG5cdFx0XHRcdHNlbGYuc3RhdGUgPSAxO1xuXHRcdFx0XHRpZiAoc2VsZi5jaGFpbi5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0c2NoZWR1bGUobm90aWZ5LHNlbGYpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGNhdGNoIChlcnIpIHtcblx0XHRcdHJlamVjdC5jYWxsKG5ldyBNYWtlRGVmV3JhcHBlcihzZWxmKSxlcnIpO1xuXHRcdH1cblx0fVxuXG5cdGZ1bmN0aW9uIHJlamVjdChtc2cpIHtcblx0XHR2YXIgc2VsZiA9IHRoaXM7XG5cblx0XHQvLyBhbHJlYWR5IHRyaWdnZXJlZD9cblx0XHRpZiAoc2VsZi50cmlnZ2VyZWQpIHsgcmV0dXJuOyB9XG5cblx0XHRzZWxmLnRyaWdnZXJlZCA9IHRydWU7XG5cblx0XHQvLyB1bndyYXBcblx0XHRpZiAoc2VsZi5kZWYpIHtcblx0XHRcdHNlbGYgPSBzZWxmLmRlZjtcblx0XHR9XG5cblx0XHRzZWxmLm1zZyA9IG1zZztcblx0XHRzZWxmLnN0YXRlID0gMjtcblx0XHRpZiAoc2VsZi5jaGFpbi5sZW5ndGggPiAwKSB7XG5cdFx0XHRzY2hlZHVsZShub3RpZnksc2VsZik7XG5cdFx0fVxuXHR9XG5cblx0ZnVuY3Rpb24gaXRlcmF0ZVByb21pc2VzKENvbnN0cnVjdG9yLGFycixyZXNvbHZlcixyZWplY3Rlcikge1xuXHRcdGZvciAodmFyIGlkeD0wOyBpZHg8YXJyLmxlbmd0aDsgaWR4KyspIHtcblx0XHRcdChmdW5jdGlvbiBJSUZFKGlkeCl7XG5cdFx0XHRcdENvbnN0cnVjdG9yLnJlc29sdmUoYXJyW2lkeF0pXG5cdFx0XHRcdC50aGVuKFxuXHRcdFx0XHRcdGZ1bmN0aW9uICRyZXNvbHZlciQobXNnKXtcblx0XHRcdFx0XHRcdHJlc29sdmVyKGlkeCxtc2cpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0cmVqZWN0ZXJcblx0XHRcdFx0KTtcblx0XHRcdH0pKGlkeCk7XG5cdFx0fVxuXHR9XG5cblx0ZnVuY3Rpb24gTWFrZURlZldyYXBwZXIoc2VsZikge1xuXHRcdHRoaXMuZGVmID0gc2VsZjtcblx0XHR0aGlzLnRyaWdnZXJlZCA9IGZhbHNlO1xuXHR9XG5cblx0ZnVuY3Rpb24gTWFrZURlZihzZWxmKSB7XG5cdFx0dGhpcy5wcm9taXNlID0gc2VsZjtcblx0XHR0aGlzLnN0YXRlID0gMDtcblx0XHR0aGlzLnRyaWdnZXJlZCA9IGZhbHNlO1xuXHRcdHRoaXMuY2hhaW4gPSBbXTtcblx0XHR0aGlzLm1zZyA9IHZvaWQgMDtcblx0fVxuXG5cdGZ1bmN0aW9uIFByb21pc2UoZXhlY3V0b3IpIHtcblx0XHRpZiAodHlwZW9mIGV4ZWN1dG9yICE9IFwiZnVuY3Rpb25cIikge1xuXHRcdFx0dGhyb3cgVHlwZUVycm9yKFwiTm90IGEgZnVuY3Rpb25cIik7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuX19OUE9fXyAhPT0gMCkge1xuXHRcdFx0dGhyb3cgVHlwZUVycm9yKFwiTm90IGEgcHJvbWlzZVwiKTtcblx0XHR9XG5cblx0XHQvLyBpbnN0YW5jZSBzaGFkb3dpbmcgdGhlIGluaGVyaXRlZCBcImJyYW5kXCJcblx0XHQvLyB0byBzaWduYWwgYW4gYWxyZWFkeSBcImluaXRpYWxpemVkXCIgcHJvbWlzZVxuXHRcdHRoaXMuX19OUE9fXyA9IDE7XG5cblx0XHR2YXIgZGVmID0gbmV3IE1ha2VEZWYodGhpcyk7XG5cblx0XHR0aGlzW1widGhlblwiXSA9IGZ1bmN0aW9uIHRoZW4oc3VjY2VzcyxmYWlsdXJlKSB7XG5cdFx0XHR2YXIgbyA9IHtcblx0XHRcdFx0c3VjY2VzczogdHlwZW9mIHN1Y2Nlc3MgPT0gXCJmdW5jdGlvblwiID8gc3VjY2VzcyA6IHRydWUsXG5cdFx0XHRcdGZhaWx1cmU6IHR5cGVvZiBmYWlsdXJlID09IFwiZnVuY3Rpb25cIiA/IGZhaWx1cmUgOiBmYWxzZVxuXHRcdFx0fTtcblx0XHRcdC8vIE5vdGU6IGB0aGVuKC4uKWAgaXRzZWxmIGNhbiBiZSBib3Jyb3dlZCB0byBiZSB1c2VkIGFnYWluc3Rcblx0XHRcdC8vIGEgZGlmZmVyZW50IHByb21pc2UgY29uc3RydWN0b3IgZm9yIG1ha2luZyB0aGUgY2hhaW5lZCBwcm9taXNlLFxuXHRcdFx0Ly8gYnkgc3Vic3RpdHV0aW5nIGEgZGlmZmVyZW50IGB0aGlzYCBiaW5kaW5nLlxuXHRcdFx0by5wcm9taXNlID0gbmV3IHRoaXMuY29uc3RydWN0b3IoZnVuY3Rpb24gZXh0cmFjdENoYWluKHJlc29sdmUscmVqZWN0KSB7XG5cdFx0XHRcdGlmICh0eXBlb2YgcmVzb2x2ZSAhPSBcImZ1bmN0aW9uXCIgfHwgdHlwZW9mIHJlamVjdCAhPSBcImZ1bmN0aW9uXCIpIHtcblx0XHRcdFx0XHR0aHJvdyBUeXBlRXJyb3IoXCJOb3QgYSBmdW5jdGlvblwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdG8ucmVzb2x2ZSA9IHJlc29sdmU7XG5cdFx0XHRcdG8ucmVqZWN0ID0gcmVqZWN0O1xuXHRcdFx0fSk7XG5cdFx0XHRkZWYuY2hhaW4ucHVzaChvKTtcblxuXHRcdFx0aWYgKGRlZi5zdGF0ZSAhPT0gMCkge1xuXHRcdFx0XHRzY2hlZHVsZShub3RpZnksZGVmKTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG8ucHJvbWlzZTtcblx0XHR9O1xuXHRcdHRoaXNbXCJjYXRjaFwiXSA9IGZ1bmN0aW9uICRjYXRjaCQoZmFpbHVyZSkge1xuXHRcdFx0cmV0dXJuIHRoaXMudGhlbih2b2lkIDAsZmFpbHVyZSk7XG5cdFx0fTtcblxuXHRcdHRyeSB7XG5cdFx0XHRleGVjdXRvci5jYWxsKFxuXHRcdFx0XHR2b2lkIDAsXG5cdFx0XHRcdGZ1bmN0aW9uIHB1YmxpY1Jlc29sdmUobXNnKXtcblx0XHRcdFx0XHRyZXNvbHZlLmNhbGwoZGVmLG1zZyk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdGZ1bmN0aW9uIHB1YmxpY1JlamVjdChtc2cpIHtcblx0XHRcdFx0XHRyZWplY3QuY2FsbChkZWYsbXNnKTtcblx0XHRcdFx0fVxuXHRcdFx0KTtcblx0XHR9XG5cdFx0Y2F0Y2ggKGVycikge1xuXHRcdFx0cmVqZWN0LmNhbGwoZGVmLGVycik7XG5cdFx0fVxuXHR9XG5cblx0dmFyIFByb21pc2VQcm90b3R5cGUgPSBidWlsdEluUHJvcCh7fSxcImNvbnN0cnVjdG9yXCIsUHJvbWlzZSxcblx0XHQvKmNvbmZpZ3VyYWJsZT0qL2ZhbHNlXG5cdCk7XG5cblx0Ly8gTm90ZTogQW5kcm9pZCA0IGNhbm5vdCB1c2UgYE9iamVjdC5kZWZpbmVQcm9wZXJ0eSguLilgIGhlcmVcblx0UHJvbWlzZS5wcm90b3R5cGUgPSBQcm9taXNlUHJvdG90eXBlO1xuXG5cdC8vIGJ1aWx0LWluIFwiYnJhbmRcIiB0byBzaWduYWwgYW4gXCJ1bmluaXRpYWxpemVkXCIgcHJvbWlzZVxuXHRidWlsdEluUHJvcChQcm9taXNlUHJvdG90eXBlLFwiX19OUE9fX1wiLDAsXG5cdFx0Lypjb25maWd1cmFibGU9Ki9mYWxzZVxuXHQpO1xuXG5cdGJ1aWx0SW5Qcm9wKFByb21pc2UsXCJyZXNvbHZlXCIsZnVuY3Rpb24gUHJvbWlzZSRyZXNvbHZlKG1zZykge1xuXHRcdHZhciBDb25zdHJ1Y3RvciA9IHRoaXM7XG5cblx0XHQvLyBzcGVjIG1hbmRhdGVkIGNoZWNrc1xuXHRcdC8vIG5vdGU6IGJlc3QgXCJpc1Byb21pc2VcIiBjaGVjayB0aGF0J3MgcHJhY3RpY2FsIGZvciBub3dcblx0XHRpZiAobXNnICYmIHR5cGVvZiBtc2cgPT0gXCJvYmplY3RcIiAmJiBtc2cuX19OUE9fXyA9PT0gMSkge1xuXHRcdFx0cmV0dXJuIG1zZztcblx0XHR9XG5cblx0XHRyZXR1cm4gbmV3IENvbnN0cnVjdG9yKGZ1bmN0aW9uIGV4ZWN1dG9yKHJlc29sdmUscmVqZWN0KXtcblx0XHRcdGlmICh0eXBlb2YgcmVzb2x2ZSAhPSBcImZ1bmN0aW9uXCIgfHwgdHlwZW9mIHJlamVjdCAhPSBcImZ1bmN0aW9uXCIpIHtcblx0XHRcdFx0dGhyb3cgVHlwZUVycm9yKFwiTm90IGEgZnVuY3Rpb25cIik7XG5cdFx0XHR9XG5cblx0XHRcdHJlc29sdmUobXNnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0YnVpbHRJblByb3AoUHJvbWlzZSxcInJlamVjdFwiLGZ1bmN0aW9uIFByb21pc2UkcmVqZWN0KG1zZykge1xuXHRcdHJldHVybiBuZXcgdGhpcyhmdW5jdGlvbiBleGVjdXRvcihyZXNvbHZlLHJlamVjdCl7XG5cdFx0XHRpZiAodHlwZW9mIHJlc29sdmUgIT0gXCJmdW5jdGlvblwiIHx8IHR5cGVvZiByZWplY3QgIT0gXCJmdW5jdGlvblwiKSB7XG5cdFx0XHRcdHRocm93IFR5cGVFcnJvcihcIk5vdCBhIGZ1bmN0aW9uXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRyZWplY3QobXNnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0YnVpbHRJblByb3AoUHJvbWlzZSxcImFsbFwiLGZ1bmN0aW9uIFByb21pc2UkYWxsKGFycikge1xuXHRcdHZhciBDb25zdHJ1Y3RvciA9IHRoaXM7XG5cblx0XHQvLyBzcGVjIG1hbmRhdGVkIGNoZWNrc1xuXHRcdGlmIChUb1N0cmluZy5jYWxsKGFycikgIT0gXCJbb2JqZWN0IEFycmF5XVwiKSB7XG5cdFx0XHRyZXR1cm4gQ29uc3RydWN0b3IucmVqZWN0KFR5cGVFcnJvcihcIk5vdCBhbiBhcnJheVwiKSk7XG5cdFx0fVxuXHRcdGlmIChhcnIubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRyZXR1cm4gQ29uc3RydWN0b3IucmVzb2x2ZShbXSk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG5ldyBDb25zdHJ1Y3RvcihmdW5jdGlvbiBleGVjdXRvcihyZXNvbHZlLHJlamVjdCl7XG5cdFx0XHRpZiAodHlwZW9mIHJlc29sdmUgIT0gXCJmdW5jdGlvblwiIHx8IHR5cGVvZiByZWplY3QgIT0gXCJmdW5jdGlvblwiKSB7XG5cdFx0XHRcdHRocm93IFR5cGVFcnJvcihcIk5vdCBhIGZ1bmN0aW9uXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHR2YXIgbGVuID0gYXJyLmxlbmd0aCwgbXNncyA9IEFycmF5KGxlbiksIGNvdW50ID0gMDtcblxuXHRcdFx0aXRlcmF0ZVByb21pc2VzKENvbnN0cnVjdG9yLGFycixmdW5jdGlvbiByZXNvbHZlcihpZHgsbXNnKSB7XG5cdFx0XHRcdG1zZ3NbaWR4XSA9IG1zZztcblx0XHRcdFx0aWYgKCsrY291bnQgPT09IGxlbikge1xuXHRcdFx0XHRcdHJlc29sdmUobXNncyk7XG5cdFx0XHRcdH1cblx0XHRcdH0scmVqZWN0KTtcblx0XHR9KTtcblx0fSk7XG5cblx0YnVpbHRJblByb3AoUHJvbWlzZSxcInJhY2VcIixmdW5jdGlvbiBQcm9taXNlJHJhY2UoYXJyKSB7XG5cdFx0dmFyIENvbnN0cnVjdG9yID0gdGhpcztcblxuXHRcdC8vIHNwZWMgbWFuZGF0ZWQgY2hlY2tzXG5cdFx0aWYgKFRvU3RyaW5nLmNhbGwoYXJyKSAhPSBcIltvYmplY3QgQXJyYXldXCIpIHtcblx0XHRcdHJldHVybiBDb25zdHJ1Y3Rvci5yZWplY3QoVHlwZUVycm9yKFwiTm90IGFuIGFycmF5XCIpKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gbmV3IENvbnN0cnVjdG9yKGZ1bmN0aW9uIGV4ZWN1dG9yKHJlc29sdmUscmVqZWN0KXtcblx0XHRcdGlmICh0eXBlb2YgcmVzb2x2ZSAhPSBcImZ1bmN0aW9uXCIgfHwgdHlwZW9mIHJlamVjdCAhPSBcImZ1bmN0aW9uXCIpIHtcblx0XHRcdFx0dGhyb3cgVHlwZUVycm9yKFwiTm90IGEgZnVuY3Rpb25cIik7XG5cdFx0XHR9XG5cblx0XHRcdGl0ZXJhdGVQcm9taXNlcyhDb25zdHJ1Y3RvcixhcnIsZnVuY3Rpb24gcmVzb2x2ZXIoaWR4LG1zZyl7XG5cdFx0XHRcdHJlc29sdmUobXNnKTtcblx0XHRcdH0scmVqZWN0KTtcblx0XHR9KTtcblx0fSk7XG5cblx0cmV0dXJuIFByb21pc2U7XG59KTtcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyByZXNvbHZlcyAuIGFuZCAuLiBlbGVtZW50cyBpbiBhIHBhdGggYXJyYXkgd2l0aCBkaXJlY3RvcnkgbmFtZXMgdGhlcmVcbi8vIG11c3QgYmUgbm8gc2xhc2hlcywgZW1wdHkgZWxlbWVudHMsIG9yIGRldmljZSBuYW1lcyAoYzpcXCkgaW4gdGhlIGFycmF5XG4vLyAoc28gYWxzbyBubyBsZWFkaW5nIGFuZCB0cmFpbGluZyBzbGFzaGVzIC0gaXQgZG9lcyBub3QgZGlzdGluZ3Vpc2hcbi8vIHJlbGF0aXZlIGFuZCBhYnNvbHV0ZSBwYXRocylcbmZ1bmN0aW9uIG5vcm1hbGl6ZUFycmF5KHBhcnRzLCBhbGxvd0Fib3ZlUm9vdCkge1xuICAvLyBpZiB0aGUgcGF0aCB0cmllcyB0byBnbyBhYm92ZSB0aGUgcm9vdCwgYHVwYCBlbmRzIHVwID4gMFxuICB2YXIgdXAgPSAwO1xuICBmb3IgKHZhciBpID0gcGFydHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICB2YXIgbGFzdCA9IHBhcnRzW2ldO1xuICAgIGlmIChsYXN0ID09PSAnLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICB9IGVsc2UgaWYgKGxhc3QgPT09ICcuLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICAgIHVwKys7XG4gICAgfSBlbHNlIGlmICh1cCkge1xuICAgICAgcGFydHMuc3BsaWNlKGksIDEpO1xuICAgICAgdXAtLTtcbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgcGF0aCBpcyBhbGxvd2VkIHRvIGdvIGFib3ZlIHRoZSByb290LCByZXN0b3JlIGxlYWRpbmcgLi5zXG4gIGlmIChhbGxvd0Fib3ZlUm9vdCkge1xuICAgIGZvciAoOyB1cC0tOyB1cCkge1xuICAgICAgcGFydHMudW5zaGlmdCgnLi4nKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcGFydHM7XG59XG5cbi8vIFNwbGl0IGEgZmlsZW5hbWUgaW50byBbcm9vdCwgZGlyLCBiYXNlbmFtZSwgZXh0XSwgdW5peCB2ZXJzaW9uXG4vLyAncm9vdCcgaXMganVzdCBhIHNsYXNoLCBvciBub3RoaW5nLlxudmFyIHNwbGl0UGF0aFJlID1cbiAgICAvXihcXC8/fCkoW1xcc1xcU10qPykoKD86XFwuezEsMn18W15cXC9dKz98KShcXC5bXi5cXC9dKnwpKSg/OltcXC9dKikkLztcbnZhciBzcGxpdFBhdGggPSBmdW5jdGlvbihmaWxlbmFtZSkge1xuICByZXR1cm4gc3BsaXRQYXRoUmUuZXhlYyhmaWxlbmFtZSkuc2xpY2UoMSk7XG59O1xuXG4vLyBwYXRoLnJlc29sdmUoW2Zyb20gLi4uXSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlc29sdmUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHJlc29sdmVkUGF0aCA9ICcnLFxuICAgICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IGZhbHNlO1xuXG4gIGZvciAodmFyIGkgPSBhcmd1bWVudHMubGVuZ3RoIC0gMTsgaSA+PSAtMSAmJiAhcmVzb2x2ZWRBYnNvbHV0ZTsgaS0tKSB7XG4gICAgdmFyIHBhdGggPSAoaSA+PSAwKSA/IGFyZ3VtZW50c1tpXSA6IHByb2Nlc3MuY3dkKCk7XG5cbiAgICAvLyBTa2lwIGVtcHR5IGFuZCBpbnZhbGlkIGVudHJpZXNcbiAgICBpZiAodHlwZW9mIHBhdGggIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmd1bWVudHMgdG8gcGF0aC5yZXNvbHZlIG11c3QgYmUgc3RyaW5ncycpO1xuICAgIH0gZWxzZSBpZiAoIXBhdGgpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHJlc29sdmVkUGF0aCA9IHBhdGggKyAnLycgKyByZXNvbHZlZFBhdGg7XG4gICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IHBhdGguY2hhckF0KDApID09PSAnLyc7XG4gIH1cblxuICAvLyBBdCB0aGlzIHBvaW50IHRoZSBwYXRoIHNob3VsZCBiZSByZXNvbHZlZCB0byBhIGZ1bGwgYWJzb2x1dGUgcGF0aCwgYnV0XG4gIC8vIGhhbmRsZSByZWxhdGl2ZSBwYXRocyB0byBiZSBzYWZlIChtaWdodCBoYXBwZW4gd2hlbiBwcm9jZXNzLmN3ZCgpIGZhaWxzKVxuXG4gIC8vIE5vcm1hbGl6ZSB0aGUgcGF0aFxuICByZXNvbHZlZFBhdGggPSBub3JtYWxpemVBcnJheShmaWx0ZXIocmVzb2x2ZWRQYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIXJlc29sdmVkQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICByZXR1cm4gKChyZXNvbHZlZEFic29sdXRlID8gJy8nIDogJycpICsgcmVzb2x2ZWRQYXRoKSB8fCAnLic7XG59O1xuXG4vLyBwYXRoLm5vcm1hbGl6ZShwYXRoKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5ub3JtYWxpemUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciBpc0Fic29sdXRlID0gZXhwb3J0cy5pc0Fic29sdXRlKHBhdGgpLFxuICAgICAgdHJhaWxpbmdTbGFzaCA9IHN1YnN0cihwYXRoLCAtMSkgPT09ICcvJztcblxuICAvLyBOb3JtYWxpemUgdGhlIHBhdGhcbiAgcGF0aCA9IG5vcm1hbGl6ZUFycmF5KGZpbHRlcihwYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIWlzQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICBpZiAoIXBhdGggJiYgIWlzQWJzb2x1dGUpIHtcbiAgICBwYXRoID0gJy4nO1xuICB9XG4gIGlmIChwYXRoICYmIHRyYWlsaW5nU2xhc2gpIHtcbiAgICBwYXRoICs9ICcvJztcbiAgfVxuXG4gIHJldHVybiAoaXNBYnNvbHV0ZSA/ICcvJyA6ICcnKSArIHBhdGg7XG59O1xuXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLmlzQWJzb2x1dGUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHJldHVybiBwYXRoLmNoYXJBdCgwKSA9PT0gJy8nO1xufTtcblxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5qb2luID0gZnVuY3Rpb24oKSB7XG4gIHZhciBwYXRocyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMCk7XG4gIHJldHVybiBleHBvcnRzLm5vcm1hbGl6ZShmaWx0ZXIocGF0aHMsIGZ1bmN0aW9uKHAsIGluZGV4KSB7XG4gICAgaWYgKHR5cGVvZiBwICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIHRvIHBhdGguam9pbiBtdXN0IGJlIHN0cmluZ3MnKTtcbiAgICB9XG4gICAgcmV0dXJuIHA7XG4gIH0pLmpvaW4oJy8nKSk7XG59O1xuXG5cbi8vIHBhdGgucmVsYXRpdmUoZnJvbSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlbGF0aXZlID0gZnVuY3Rpb24oZnJvbSwgdG8pIHtcbiAgZnJvbSA9IGV4cG9ydHMucmVzb2x2ZShmcm9tKS5zdWJzdHIoMSk7XG4gIHRvID0gZXhwb3J0cy5yZXNvbHZlKHRvKS5zdWJzdHIoMSk7XG5cbiAgZnVuY3Rpb24gdHJpbShhcnIpIHtcbiAgICB2YXIgc3RhcnQgPSAwO1xuICAgIGZvciAoOyBzdGFydCA8IGFyci5sZW5ndGg7IHN0YXJ0KyspIHtcbiAgICAgIGlmIChhcnJbc3RhcnRdICE9PSAnJykgYnJlYWs7XG4gICAgfVxuXG4gICAgdmFyIGVuZCA9IGFyci5sZW5ndGggLSAxO1xuICAgIGZvciAoOyBlbmQgPj0gMDsgZW5kLS0pIHtcbiAgICAgIGlmIChhcnJbZW5kXSAhPT0gJycpIGJyZWFrO1xuICAgIH1cblxuICAgIGlmIChzdGFydCA+IGVuZCkgcmV0dXJuIFtdO1xuICAgIHJldHVybiBhcnIuc2xpY2Uoc3RhcnQsIGVuZCAtIHN0YXJ0ICsgMSk7XG4gIH1cblxuICB2YXIgZnJvbVBhcnRzID0gdHJpbShmcm9tLnNwbGl0KCcvJykpO1xuICB2YXIgdG9QYXJ0cyA9IHRyaW0odG8uc3BsaXQoJy8nKSk7XG5cbiAgdmFyIGxlbmd0aCA9IE1hdGgubWluKGZyb21QYXJ0cy5sZW5ndGgsIHRvUGFydHMubGVuZ3RoKTtcbiAgdmFyIHNhbWVQYXJ0c0xlbmd0aCA9IGxlbmd0aDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIGlmIChmcm9tUGFydHNbaV0gIT09IHRvUGFydHNbaV0pIHtcbiAgICAgIHNhbWVQYXJ0c0xlbmd0aCA9IGk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICB2YXIgb3V0cHV0UGFydHMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IHNhbWVQYXJ0c0xlbmd0aDsgaSA8IGZyb21QYXJ0cy5sZW5ndGg7IGkrKykge1xuICAgIG91dHB1dFBhcnRzLnB1c2goJy4uJyk7XG4gIH1cblxuICBvdXRwdXRQYXJ0cyA9IG91dHB1dFBhcnRzLmNvbmNhdCh0b1BhcnRzLnNsaWNlKHNhbWVQYXJ0c0xlbmd0aCkpO1xuXG4gIHJldHVybiBvdXRwdXRQYXJ0cy5qb2luKCcvJyk7XG59O1xuXG5leHBvcnRzLnNlcCA9ICcvJztcbmV4cG9ydHMuZGVsaW1pdGVyID0gJzonO1xuXG5leHBvcnRzLmRpcm5hbWUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciByZXN1bHQgPSBzcGxpdFBhdGgocGF0aCksXG4gICAgICByb290ID0gcmVzdWx0WzBdLFxuICAgICAgZGlyID0gcmVzdWx0WzFdO1xuXG4gIGlmICghcm9vdCAmJiAhZGlyKSB7XG4gICAgLy8gTm8gZGlybmFtZSB3aGF0c29ldmVyXG4gICAgcmV0dXJuICcuJztcbiAgfVxuXG4gIGlmIChkaXIpIHtcbiAgICAvLyBJdCBoYXMgYSBkaXJuYW1lLCBzdHJpcCB0cmFpbGluZyBzbGFzaFxuICAgIGRpciA9IGRpci5zdWJzdHIoMCwgZGlyLmxlbmd0aCAtIDEpO1xuICB9XG5cbiAgcmV0dXJuIHJvb3QgKyBkaXI7XG59O1xuXG5cbmV4cG9ydHMuYmFzZW5hbWUgPSBmdW5jdGlvbihwYXRoLCBleHQpIHtcbiAgdmFyIGYgPSBzcGxpdFBhdGgocGF0aClbMl07XG4gIC8vIFRPRE86IG1ha2UgdGhpcyBjb21wYXJpc29uIGNhc2UtaW5zZW5zaXRpdmUgb24gd2luZG93cz9cbiAgaWYgKGV4dCAmJiBmLnN1YnN0cigtMSAqIGV4dC5sZW5ndGgpID09PSBleHQpIHtcbiAgICBmID0gZi5zdWJzdHIoMCwgZi5sZW5ndGggLSBleHQubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZjtcbn07XG5cblxuZXhwb3J0cy5leHRuYW1lID0gZnVuY3Rpb24ocGF0aCkge1xuICByZXR1cm4gc3BsaXRQYXRoKHBhdGgpWzNdO1xufTtcblxuZnVuY3Rpb24gZmlsdGVyICh4cywgZikge1xuICAgIGlmICh4cy5maWx0ZXIpIHJldHVybiB4cy5maWx0ZXIoZik7XG4gICAgdmFyIHJlcyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgeHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGYoeHNbaV0sIGksIHhzKSkgcmVzLnB1c2goeHNbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmVzO1xufVxuXG4vLyBTdHJpbmcucHJvdG90eXBlLnN1YnN0ciAtIG5lZ2F0aXZlIGluZGV4IGRvbid0IHdvcmsgaW4gSUU4XG52YXIgc3Vic3RyID0gJ2FiJy5zdWJzdHIoLTEpID09PSAnYidcbiAgICA/IGZ1bmN0aW9uIChzdHIsIHN0YXJ0LCBsZW4pIHsgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbikgfVxuICAgIDogZnVuY3Rpb24gKHN0ciwgc3RhcnQsIGxlbikge1xuICAgICAgICBpZiAoc3RhcnQgPCAwKSBzdGFydCA9IHN0ci5sZW5ndGggKyBzdGFydDtcbiAgICAgICAgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbik7XG4gICAgfVxuO1xuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHNldFRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZHJhaW5RdWV1ZSwgMCk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuJ3VzZSBzdHJpY3QnO1xuXG4vLyBJZiBvYmouaGFzT3duUHJvcGVydHkgaGFzIGJlZW4gb3ZlcnJpZGRlbiwgdGhlbiBjYWxsaW5nXG4vLyBvYmouaGFzT3duUHJvcGVydHkocHJvcCkgd2lsbCBicmVhay5cbi8vIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2pveWVudC9ub2RlL2lzc3Vlcy8xNzA3XG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHFzLCBzZXAsIGVxLCBvcHRpb25zKSB7XG4gIHNlcCA9IHNlcCB8fCAnJic7XG4gIGVxID0gZXEgfHwgJz0nO1xuICB2YXIgb2JqID0ge307XG5cbiAgaWYgKHR5cGVvZiBxcyAhPT0gJ3N0cmluZycgfHwgcXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG9iajtcbiAgfVxuXG4gIHZhciByZWdleHAgPSAvXFwrL2c7XG4gIHFzID0gcXMuc3BsaXQoc2VwKTtcblxuICB2YXIgbWF4S2V5cyA9IDEwMDA7XG4gIGlmIChvcHRpb25zICYmIHR5cGVvZiBvcHRpb25zLm1heEtleXMgPT09ICdudW1iZXInKSB7XG4gICAgbWF4S2V5cyA9IG9wdGlvbnMubWF4S2V5cztcbiAgfVxuXG4gIHZhciBsZW4gPSBxcy5sZW5ndGg7XG4gIC8vIG1heEtleXMgPD0gMCBtZWFucyB0aGF0IHdlIHNob3VsZCBub3QgbGltaXQga2V5cyBjb3VudFxuICBpZiAobWF4S2V5cyA+IDAgJiYgbGVuID4gbWF4S2V5cykge1xuICAgIGxlbiA9IG1heEtleXM7XG4gIH1cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgdmFyIHggPSBxc1tpXS5yZXBsYWNlKHJlZ2V4cCwgJyUyMCcpLFxuICAgICAgICBpZHggPSB4LmluZGV4T2YoZXEpLFxuICAgICAgICBrc3RyLCB2c3RyLCBrLCB2O1xuXG4gICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICBrc3RyID0geC5zdWJzdHIoMCwgaWR4KTtcbiAgICAgIHZzdHIgPSB4LnN1YnN0cihpZHggKyAxKTtcbiAgICB9IGVsc2Uge1xuICAgICAga3N0ciA9IHg7XG4gICAgICB2c3RyID0gJyc7XG4gICAgfVxuXG4gICAgayA9IGRlY29kZVVSSUNvbXBvbmVudChrc3RyKTtcbiAgICB2ID0gZGVjb2RlVVJJQ29tcG9uZW50KHZzdHIpO1xuXG4gICAgaWYgKCFoYXNPd25Qcm9wZXJ0eShvYmosIGspKSB7XG4gICAgICBvYmpba10gPSB2O1xuICAgIH0gZWxzZSBpZiAoaXNBcnJheShvYmpba10pKSB7XG4gICAgICBvYmpba10ucHVzaCh2KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb2JqW2tdID0gW29ialtrXSwgdl07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG9iajtcbn07XG5cbnZhciBpc0FycmF5ID0gQXJyYXkuaXNBcnJheSB8fCBmdW5jdGlvbiAoeHMpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh4cykgPT09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbid1c2Ugc3RyaWN0JztcblxudmFyIHN0cmluZ2lmeVByaW1pdGl2ZSA9IGZ1bmN0aW9uKHYpIHtcbiAgc3dpdGNoICh0eXBlb2Ygdikge1xuICAgIGNhc2UgJ3N0cmluZyc6XG4gICAgICByZXR1cm4gdjtcblxuICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgcmV0dXJuIHYgPyAndHJ1ZScgOiAnZmFsc2UnO1xuXG4gICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgIHJldHVybiBpc0Zpbml0ZSh2KSA/IHYgOiAnJztcblxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gJyc7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ob2JqLCBzZXAsIGVxLCBuYW1lKSB7XG4gIHNlcCA9IHNlcCB8fCAnJic7XG4gIGVxID0gZXEgfHwgJz0nO1xuICBpZiAob2JqID09PSBudWxsKSB7XG4gICAgb2JqID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIG1hcChvYmplY3RLZXlzKG9iaiksIGZ1bmN0aW9uKGspIHtcbiAgICAgIHZhciBrcyA9IGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUoaykpICsgZXE7XG4gICAgICBpZiAoaXNBcnJheShvYmpba10pKSB7XG4gICAgICAgIHJldHVybiBtYXAob2JqW2tdLCBmdW5jdGlvbih2KSB7XG4gICAgICAgICAgcmV0dXJuIGtzICsgZW5jb2RlVVJJQ29tcG9uZW50KHN0cmluZ2lmeVByaW1pdGl2ZSh2KSk7XG4gICAgICAgIH0pLmpvaW4oc2VwKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBrcyArIGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUob2JqW2tdKSk7XG4gICAgICB9XG4gICAgfSkuam9pbihzZXApO1xuXG4gIH1cblxuICBpZiAoIW5hbWUpIHJldHVybiAnJztcbiAgcmV0dXJuIGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUobmFtZSkpICsgZXEgK1xuICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0cmluZ2lmeVByaW1pdGl2ZShvYmopKTtcbn07XG5cbnZhciBpc0FycmF5ID0gQXJyYXkuaXNBcnJheSB8fCBmdW5jdGlvbiAoeHMpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh4cykgPT09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuXG5mdW5jdGlvbiBtYXAgKHhzLCBmKSB7XG4gIGlmICh4cy5tYXApIHJldHVybiB4cy5tYXAoZik7XG4gIHZhciByZXMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB4cy5sZW5ndGg7IGkrKykge1xuICAgIHJlcy5wdXNoKGYoeHNbaV0sIGkpKTtcbiAgfVxuICByZXR1cm4gcmVzO1xufVxuXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIHJlcyA9IFtdO1xuICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIHJlcy5wdXNoKGtleSk7XG4gIH1cbiAgcmV0dXJuIHJlcztcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuZGVjb2RlID0gZXhwb3J0cy5wYXJzZSA9IHJlcXVpcmUoJy4vZGVjb2RlJyk7XG5leHBvcnRzLmVuY29kZSA9IGV4cG9ydHMuc3RyaW5naWZ5ID0gcmVxdWlyZSgnLi9lbmNvZGUnKTtcbiIsIid1c2Ugc3RyaWN0Jztcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHN0cikge1xuXHR2YXIgaXNFeHRlbmRlZExlbmd0aFBhdGggPSAvXlxcXFxcXFxcXFw/XFxcXC8udGVzdChzdHIpO1xuXHR2YXIgaGFzTm9uQXNjaWkgPSAvW15cXHgwMC1cXHg4MF0rLy50ZXN0KHN0cik7XG5cblx0aWYgKGlzRXh0ZW5kZWRMZW5ndGhQYXRoIHx8IGhhc05vbkFzY2lpKSB7XG5cdFx0cmV0dXJuIHN0cjtcblx0fVxuXG5cdHJldHVybiBzdHIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xufTtcbiIsIi8qISBodHRwczovL210aHMuYmUvcHVueWNvZGUgdjEuMy4yIGJ5IEBtYXRoaWFzLCBtb2RpZmllZCBmb3IgVVJJLmpzICovXHJcblxyXG52YXIgcHVueWNvZGUgPSAoZnVuY3Rpb24gKCkge1xyXG5cclxuXHQvKipcclxuXHQgKiBUaGUgYHB1bnljb2RlYCBvYmplY3QuXHJcblx0ICogQG5hbWUgcHVueWNvZGVcclxuXHQgKiBAdHlwZSBPYmplY3RcclxuXHQgKi9cclxuXHR2YXIgcHVueWNvZGUsXHJcblxyXG5cdC8qKiBIaWdoZXN0IHBvc2l0aXZlIHNpZ25lZCAzMi1iaXQgZmxvYXQgdmFsdWUgKi9cclxuXHRtYXhJbnQgPSAyMTQ3NDgzNjQ3LCAvLyBha2EuIDB4N0ZGRkZGRkYgb3IgMl4zMS0xXHJcblxyXG5cdC8qKiBCb290c3RyaW5nIHBhcmFtZXRlcnMgKi9cclxuXHRiYXNlID0gMzYsXHJcblx0dE1pbiA9IDEsXHJcblx0dE1heCA9IDI2LFxyXG5cdHNrZXcgPSAzOCxcclxuXHRkYW1wID0gNzAwLFxyXG5cdGluaXRpYWxCaWFzID0gNzIsXHJcblx0aW5pdGlhbE4gPSAxMjgsIC8vIDB4ODBcclxuXHRkZWxpbWl0ZXIgPSAnLScsIC8vICdcXHgyRCdcclxuXHJcblx0LyoqIFJlZ3VsYXIgZXhwcmVzc2lvbnMgKi9cclxuXHRyZWdleFB1bnljb2RlID0gL154bi0tLyxcclxuXHRyZWdleE5vbkFTQ0lJID0gL1teXFx4MjAtXFx4N0VdLywgLy8gdW5wcmludGFibGUgQVNDSUkgY2hhcnMgKyBub24tQVNDSUkgY2hhcnNcclxuXHRyZWdleFNlcGFyYXRvcnMgPSAvW1xceDJFXFx1MzAwMlxcdUZGMEVcXHVGRjYxXS9nLCAvLyBSRkMgMzQ5MCBzZXBhcmF0b3JzXHJcblxyXG5cdC8qKiBFcnJvciBtZXNzYWdlcyAqL1xyXG5cdGVycm9ycyA9IHtcclxuXHRcdCdvdmVyZmxvdyc6ICdPdmVyZmxvdzogaW5wdXQgbmVlZHMgd2lkZXIgaW50ZWdlcnMgdG8gcHJvY2VzcycsXHJcblx0XHQnbm90LWJhc2ljJzogJ0lsbGVnYWwgaW5wdXQgPj0gMHg4MCAobm90IGEgYmFzaWMgY29kZSBwb2ludCknLFxyXG5cdFx0J2ludmFsaWQtaW5wdXQnOiAnSW52YWxpZCBpbnB1dCdcclxuXHR9LFxyXG5cclxuXHQvKiogQ29udmVuaWVuY2Ugc2hvcnRjdXRzICovXHJcblx0YmFzZU1pbnVzVE1pbiA9IGJhc2UgLSB0TWluLFxyXG5cdGZsb29yID0gTWF0aC5mbG9vcixcclxuXHRzdHJpbmdGcm9tQ2hhckNvZGUgPSBTdHJpbmcuZnJvbUNoYXJDb2RlLFxyXG5cclxuXHQvKiogVGVtcG9yYXJ5IHZhcmlhYmxlICovXHJcblx0a2V5O1xyXG5cclxuXHQvKi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKi9cclxuXHJcblx0LyoqXHJcblx0ICogQSBnZW5lcmljIGVycm9yIHV0aWxpdHkgZnVuY3Rpb24uXHJcblx0ICogQHByaXZhdGVcclxuXHQgKiBAcGFyYW0ge1N0cmluZ30gdHlwZSBUaGUgZXJyb3IgdHlwZS5cclxuXHQgKiBAcmV0dXJucyB7RXJyb3J9IFRocm93cyBhIGBSYW5nZUVycm9yYCB3aXRoIHRoZSBhcHBsaWNhYmxlIGVycm9yIG1lc3NhZ2UuXHJcblx0ICovXHJcblx0ZnVuY3Rpb24gZXJyb3IodHlwZSkge1xyXG5cdFx0dGhyb3cgbmV3IFJhbmdlRXJyb3IoZXJyb3JzW3R5cGVdKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIEEgZ2VuZXJpYyBgQXJyYXkjbWFwYCB1dGlsaXR5IGZ1bmN0aW9uLlxyXG5cdCAqIEBwcml2YXRlXHJcblx0ICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIGl0ZXJhdGUgb3Zlci5cclxuXHQgKiBAcGFyYW0ge0Z1bmN0aW9ufSBjYWxsYmFjayBUaGUgZnVuY3Rpb24gdGhhdCBnZXRzIGNhbGxlZCBmb3IgZXZlcnkgYXJyYXlcclxuXHQgKiBpdGVtLlxyXG5cdCAqIEByZXR1cm5zIHtBcnJheX0gQSBuZXcgYXJyYXkgb2YgdmFsdWVzIHJldHVybmVkIGJ5IHRoZSBjYWxsYmFjayBmdW5jdGlvbi5cclxuXHQgKi9cclxuXHRmdW5jdGlvbiBtYXAoYXJyYXksIGZuKSB7XHJcblx0XHR2YXIgbGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xyXG5cdFx0dmFyIHJlc3VsdCA9IFtdO1xyXG5cdFx0d2hpbGUgKGxlbmd0aC0tKSB7XHJcblx0XHRcdHJlc3VsdFtsZW5ndGhdID0gZm4oYXJyYXlbbGVuZ3RoXSk7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gcmVzdWx0O1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQSBzaW1wbGUgYEFycmF5I21hcGAtbGlrZSB3cmFwcGVyIHRvIHdvcmsgd2l0aCBkb21haW4gbmFtZSBzdHJpbmdzIG9yIGVtYWlsXHJcblx0ICogYWRkcmVzc2VzLlxyXG5cdCAqIEBwcml2YXRlXHJcblx0ICogQHBhcmFtIHtTdHJpbmd9IGRvbWFpbiBUaGUgZG9tYWluIG5hbWUgb3IgZW1haWwgYWRkcmVzcy5cclxuXHQgKiBAcGFyYW0ge0Z1bmN0aW9ufSBjYWxsYmFjayBUaGUgZnVuY3Rpb24gdGhhdCBnZXRzIGNhbGxlZCBmb3IgZXZlcnlcclxuXHQgKiBjaGFyYWN0ZXIuXHJcblx0ICogQHJldHVybnMge0FycmF5fSBBIG5ldyBzdHJpbmcgb2YgY2hhcmFjdGVycyByZXR1cm5lZCBieSB0aGUgY2FsbGJhY2tcclxuXHQgKiBmdW5jdGlvbi5cclxuXHQgKi9cclxuXHRmdW5jdGlvbiBtYXBEb21haW4oc3RyaW5nLCBmbikge1xyXG5cdFx0dmFyIHBhcnRzID0gc3RyaW5nLnNwbGl0KCdAJyk7XHJcblx0XHR2YXIgcmVzdWx0ID0gJyc7XHJcblx0XHRpZiAocGFydHMubGVuZ3RoID4gMSkge1xyXG5cdFx0XHQvLyBJbiBlbWFpbCBhZGRyZXNzZXMsIG9ubHkgdGhlIGRvbWFpbiBuYW1lIHNob3VsZCBiZSBwdW55Y29kZWQuIExlYXZlXHJcblx0XHRcdC8vIHRoZSBsb2NhbCBwYXJ0IChpLmUuIGV2ZXJ5dGhpbmcgdXAgdG8gYEBgKSBpbnRhY3QuXHJcblx0XHRcdHJlc3VsdCA9IHBhcnRzWzBdICsgJ0AnO1xyXG5cdFx0XHRzdHJpbmcgPSBwYXJ0c1sxXTtcclxuXHRcdH1cclxuXHRcdC8vIEF2b2lkIGBzcGxpdChyZWdleClgIGZvciBJRTggY29tcGF0aWJpbGl0eS4gU2VlICMxNy5cclxuXHRcdHN0cmluZyA9IHN0cmluZy5yZXBsYWNlKHJlZ2V4U2VwYXJhdG9ycywgJ1xceDJFJyk7XHJcblx0XHR2YXIgbGFiZWxzID0gc3RyaW5nLnNwbGl0KCcuJyk7XHJcblx0XHR2YXIgZW5jb2RlZCA9IG1hcChsYWJlbHMsIGZuKS5qb2luKCcuJyk7XHJcblx0XHRyZXR1cm4gcmVzdWx0ICsgZW5jb2RlZDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENyZWF0ZXMgYW4gYXJyYXkgY29udGFpbmluZyB0aGUgbnVtZXJpYyBjb2RlIHBvaW50cyBvZiBlYWNoIFVuaWNvZGVcclxuXHQgKiBjaGFyYWN0ZXIgaW4gdGhlIHN0cmluZy4gV2hpbGUgSmF2YVNjcmlwdCB1c2VzIFVDUy0yIGludGVybmFsbHksXHJcblx0ICogdGhpcyBmdW5jdGlvbiB3aWxsIGNvbnZlcnQgYSBwYWlyIG9mIHN1cnJvZ2F0ZSBoYWx2ZXMgKGVhY2ggb2Ygd2hpY2hcclxuXHQgKiBVQ1MtMiBleHBvc2VzIGFzIHNlcGFyYXRlIGNoYXJhY3RlcnMpIGludG8gYSBzaW5nbGUgY29kZSBwb2ludCxcclxuXHQgKiBtYXRjaGluZyBVVEYtMTYuXHJcblx0ICogQHNlZSBgcHVueWNvZGUudWNzMi5lbmNvZGVgXHJcblx0ICogQHNlZSA8aHR0cHM6Ly9tYXRoaWFzYnluZW5zLmJlL25vdGVzL2phdmFzY3JpcHQtZW5jb2Rpbmc+XHJcblx0ICogQG1lbWJlck9mIHB1bnljb2RlLnVjczJcclxuXHQgKiBAbmFtZSBkZWNvZGVcclxuXHQgKiBAcGFyYW0ge1N0cmluZ30gc3RyaW5nIFRoZSBVbmljb2RlIGlucHV0IHN0cmluZyAoVUNTLTIpLlxyXG5cdCAqIEByZXR1cm5zIHtBcnJheX0gVGhlIG5ldyBhcnJheSBvZiBjb2RlIHBvaW50cy5cclxuXHQgKi9cclxuXHRmdW5jdGlvbiB1Y3MyZGVjb2RlKHN0cmluZykge1xyXG5cdFx0dmFyIG91dHB1dCA9IFtdLFxyXG5cdFx0ICAgIGNvdW50ZXIgPSAwLFxyXG5cdFx0ICAgIGxlbmd0aCA9IHN0cmluZy5sZW5ndGgsXHJcblx0XHQgICAgdmFsdWUsXHJcblx0XHQgICAgZXh0cmE7XHJcblx0XHR3aGlsZSAoY291bnRlciA8IGxlbmd0aCkge1xyXG5cdFx0XHR2YWx1ZSA9IHN0cmluZy5jaGFyQ29kZUF0KGNvdW50ZXIrKyk7XHJcblx0XHRcdGlmICh2YWx1ZSA+PSAweEQ4MDAgJiYgdmFsdWUgPD0gMHhEQkZGICYmIGNvdW50ZXIgPCBsZW5ndGgpIHtcclxuXHRcdFx0XHQvLyBoaWdoIHN1cnJvZ2F0ZSwgYW5kIHRoZXJlIGlzIGEgbmV4dCBjaGFyYWN0ZXJcclxuXHRcdFx0XHRleHRyYSA9IHN0cmluZy5jaGFyQ29kZUF0KGNvdW50ZXIrKyk7XHJcblx0XHRcdFx0aWYgKChleHRyYSAmIDB4RkMwMCkgPT0gMHhEQzAwKSB7IC8vIGxvdyBzdXJyb2dhdGVcclxuXHRcdFx0XHRcdG91dHB1dC5wdXNoKCgodmFsdWUgJiAweDNGRikgPDwgMTApICsgKGV4dHJhICYgMHgzRkYpICsgMHgxMDAwMCk7XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdC8vIHVubWF0Y2hlZCBzdXJyb2dhdGU7IG9ubHkgYXBwZW5kIHRoaXMgY29kZSB1bml0LCBpbiBjYXNlIHRoZSBuZXh0XHJcblx0XHRcdFx0XHQvLyBjb2RlIHVuaXQgaXMgdGhlIGhpZ2ggc3Vycm9nYXRlIG9mIGEgc3Vycm9nYXRlIHBhaXJcclxuXHRcdFx0XHRcdG91dHB1dC5wdXNoKHZhbHVlKTtcclxuXHRcdFx0XHRcdGNvdW50ZXItLTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0b3V0cHV0LnB1c2godmFsdWUpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gb3V0cHV0O1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ3JlYXRlcyBhIHN0cmluZyBiYXNlZCBvbiBhbiBhcnJheSBvZiBudW1lcmljIGNvZGUgcG9pbnRzLlxyXG5cdCAqIEBzZWUgYHB1bnljb2RlLnVjczIuZGVjb2RlYFxyXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZS51Y3MyXHJcblx0ICogQG5hbWUgZW5jb2RlXHJcblx0ICogQHBhcmFtIHtBcnJheX0gY29kZVBvaW50cyBUaGUgYXJyYXkgb2YgbnVtZXJpYyBjb2RlIHBvaW50cy5cclxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgbmV3IFVuaWNvZGUgc3RyaW5nIChVQ1MtMikuXHJcblx0ICovXHJcblx0ZnVuY3Rpb24gdWNzMmVuY29kZShhcnJheSkge1xyXG5cdFx0cmV0dXJuIG1hcChhcnJheSwgZnVuY3Rpb24odmFsdWUpIHtcclxuXHRcdFx0dmFyIG91dHB1dCA9ICcnO1xyXG5cdFx0XHRpZiAodmFsdWUgPiAweEZGRkYpIHtcclxuXHRcdFx0XHR2YWx1ZSAtPSAweDEwMDAwO1xyXG5cdFx0XHRcdG91dHB1dCArPSBzdHJpbmdGcm9tQ2hhckNvZGUodmFsdWUgPj4+IDEwICYgMHgzRkYgfCAweEQ4MDApO1xyXG5cdFx0XHRcdHZhbHVlID0gMHhEQzAwIHwgdmFsdWUgJiAweDNGRjtcclxuXHRcdFx0fVxyXG5cdFx0XHRvdXRwdXQgKz0gc3RyaW5nRnJvbUNoYXJDb2RlKHZhbHVlKTtcclxuXHRcdFx0cmV0dXJuIG91dHB1dDtcclxuXHRcdH0pLmpvaW4oJycpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ29udmVydHMgYSBiYXNpYyBjb2RlIHBvaW50IGludG8gYSBkaWdpdC9pbnRlZ2VyLlxyXG5cdCAqIEBzZWUgYGRpZ2l0VG9CYXNpYygpYFxyXG5cdCAqIEBwcml2YXRlXHJcblx0ICogQHBhcmFtIHtOdW1iZXJ9IGNvZGVQb2ludCBUaGUgYmFzaWMgbnVtZXJpYyBjb2RlIHBvaW50IHZhbHVlLlxyXG5cdCAqIEByZXR1cm5zIHtOdW1iZXJ9IFRoZSBudW1lcmljIHZhbHVlIG9mIGEgYmFzaWMgY29kZSBwb2ludCAoZm9yIHVzZSBpblxyXG5cdCAqIHJlcHJlc2VudGluZyBpbnRlZ2VycykgaW4gdGhlIHJhbmdlIGAwYCB0byBgYmFzZSAtIDFgLCBvciBgYmFzZWAgaWZcclxuXHQgKiB0aGUgY29kZSBwb2ludCBkb2VzIG5vdCByZXByZXNlbnQgYSB2YWx1ZS5cclxuXHQgKi9cclxuXHRmdW5jdGlvbiBiYXNpY1RvRGlnaXQoY29kZVBvaW50KSB7XHJcblx0XHRpZiAoY29kZVBvaW50IC0gNDggPCAxMCkge1xyXG5cdFx0XHRyZXR1cm4gY29kZVBvaW50IC0gMjI7XHJcblx0XHR9XHJcblx0XHRpZiAoY29kZVBvaW50IC0gNjUgPCAyNikge1xyXG5cdFx0XHRyZXR1cm4gY29kZVBvaW50IC0gNjU7XHJcblx0XHR9XHJcblx0XHRpZiAoY29kZVBvaW50IC0gOTcgPCAyNikge1xyXG5cdFx0XHRyZXR1cm4gY29kZVBvaW50IC0gOTc7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gYmFzZTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENvbnZlcnRzIGEgZGlnaXQvaW50ZWdlciBpbnRvIGEgYmFzaWMgY29kZSBwb2ludC5cclxuXHQgKiBAc2VlIGBiYXNpY1RvRGlnaXQoKWBcclxuXHQgKiBAcHJpdmF0ZVxyXG5cdCAqIEBwYXJhbSB7TnVtYmVyfSBkaWdpdCBUaGUgbnVtZXJpYyB2YWx1ZSBvZiBhIGJhc2ljIGNvZGUgcG9pbnQuXHJcblx0ICogQHJldHVybnMge051bWJlcn0gVGhlIGJhc2ljIGNvZGUgcG9pbnQgd2hvc2UgdmFsdWUgKHdoZW4gdXNlZCBmb3JcclxuXHQgKiByZXByZXNlbnRpbmcgaW50ZWdlcnMpIGlzIGBkaWdpdGAsIHdoaWNoIG5lZWRzIHRvIGJlIGluIHRoZSByYW5nZVxyXG5cdCAqIGAwYCB0byBgYmFzZSAtIDFgLiBJZiBgZmxhZ2AgaXMgbm9uLXplcm8sIHRoZSB1cHBlcmNhc2UgZm9ybSBpc1xyXG5cdCAqIHVzZWQ7IGVsc2UsIHRoZSBsb3dlcmNhc2UgZm9ybSBpcyB1c2VkLiBUaGUgYmVoYXZpb3IgaXMgdW5kZWZpbmVkXHJcblx0ICogaWYgYGZsYWdgIGlzIG5vbi16ZXJvIGFuZCBgZGlnaXRgIGhhcyBubyB1cHBlcmNhc2UgZm9ybS5cclxuXHQgKi9cclxuXHRmdW5jdGlvbiBkaWdpdFRvQmFzaWMoZGlnaXQsIGZsYWcpIHtcclxuXHRcdC8vICAwLi4yNSBtYXAgdG8gQVNDSUkgYS4ueiBvciBBLi5aXHJcblx0XHQvLyAyNi4uMzUgbWFwIHRvIEFTQ0lJIDAuLjlcclxuXHRcdHJldHVybiBkaWdpdCArIDIyICsgNzUgKiAoZGlnaXQgPCAyNikgLSAoKGZsYWcgIT0gMCkgPDwgNSk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBCaWFzIGFkYXB0YXRpb24gZnVuY3Rpb24gYXMgcGVyIHNlY3Rpb24gMy40IG9mIFJGQyAzNDkyLlxyXG5cdCAqIGh0dHBzOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmMzNDkyI3NlY3Rpb24tMy40XHJcblx0ICogQHByaXZhdGVcclxuXHQgKi9cclxuXHRmdW5jdGlvbiBhZGFwdChkZWx0YSwgbnVtUG9pbnRzLCBmaXJzdFRpbWUpIHtcclxuXHRcdHZhciBrID0gMDtcclxuXHRcdGRlbHRhID0gZmlyc3RUaW1lID8gZmxvb3IoZGVsdGEgLyBkYW1wKSA6IGRlbHRhID4+IDE7XHJcblx0XHRkZWx0YSArPSBmbG9vcihkZWx0YSAvIG51bVBvaW50cyk7XHJcblx0XHRmb3IgKC8qIG5vIGluaXRpYWxpemF0aW9uICovOyBkZWx0YSA+IGJhc2VNaW51c1RNaW4gKiB0TWF4ID4+IDE7IGsgKz0gYmFzZSkge1xyXG5cdFx0XHRkZWx0YSA9IGZsb29yKGRlbHRhIC8gYmFzZU1pbnVzVE1pbik7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gZmxvb3IoayArIChiYXNlTWludXNUTWluICsgMSkgKiBkZWx0YSAvIChkZWx0YSArIHNrZXcpKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENvbnZlcnRzIGEgUHVueWNvZGUgc3RyaW5nIG9mIEFTQ0lJLW9ubHkgc3ltYm9scyB0byBhIHN0cmluZyBvZiBVbmljb2RlXHJcblx0ICogc3ltYm9scy5cclxuXHQgKiBAbWVtYmVyT2YgcHVueWNvZGVcclxuXHQgKiBAcGFyYW0ge1N0cmluZ30gaW5wdXQgVGhlIFB1bnljb2RlIHN0cmluZyBvZiBBU0NJSS1vbmx5IHN5bWJvbHMuXHJcblx0ICogQHJldHVybnMge1N0cmluZ30gVGhlIHJlc3VsdGluZyBzdHJpbmcgb2YgVW5pY29kZSBzeW1ib2xzLlxyXG5cdCAqL1xyXG5cdGZ1bmN0aW9uIGRlY29kZShpbnB1dCkge1xyXG5cdFx0Ly8gRG9uJ3QgdXNlIFVDUy0yXHJcblx0XHR2YXIgb3V0cHV0ID0gW10sXHJcblx0XHQgICAgaW5wdXRMZW5ndGggPSBpbnB1dC5sZW5ndGgsXHJcblx0XHQgICAgb3V0LFxyXG5cdFx0ICAgIGkgPSAwLFxyXG5cdFx0ICAgIG4gPSBpbml0aWFsTixcclxuXHRcdCAgICBiaWFzID0gaW5pdGlhbEJpYXMsXHJcblx0XHQgICAgYmFzaWMsXHJcblx0XHQgICAgaixcclxuXHRcdCAgICBpbmRleCxcclxuXHRcdCAgICBvbGRpLFxyXG5cdFx0ICAgIHcsXHJcblx0XHQgICAgayxcclxuXHRcdCAgICBkaWdpdCxcclxuXHRcdCAgICB0LFxyXG5cdFx0ICAgIC8qKiBDYWNoZWQgY2FsY3VsYXRpb24gcmVzdWx0cyAqL1xyXG5cdFx0ICAgIGJhc2VNaW51c1Q7XHJcblxyXG5cdFx0Ly8gSGFuZGxlIHRoZSBiYXNpYyBjb2RlIHBvaW50czogbGV0IGBiYXNpY2AgYmUgdGhlIG51bWJlciBvZiBpbnB1dCBjb2RlXHJcblx0XHQvLyBwb2ludHMgYmVmb3JlIHRoZSBsYXN0IGRlbGltaXRlciwgb3IgYDBgIGlmIHRoZXJlIGlzIG5vbmUsIHRoZW4gY29weVxyXG5cdFx0Ly8gdGhlIGZpcnN0IGJhc2ljIGNvZGUgcG9pbnRzIHRvIHRoZSBvdXRwdXQuXHJcblxyXG5cdFx0YmFzaWMgPSBpbnB1dC5sYXN0SW5kZXhPZihkZWxpbWl0ZXIpO1xyXG5cdFx0aWYgKGJhc2ljIDwgMCkge1xyXG5cdFx0XHRiYXNpYyA9IDA7XHJcblx0XHR9XHJcblxyXG5cdFx0Zm9yIChqID0gMDsgaiA8IGJhc2ljOyArK2opIHtcclxuXHRcdFx0Ly8gaWYgaXQncyBub3QgYSBiYXNpYyBjb2RlIHBvaW50XHJcblx0XHRcdGlmIChpbnB1dC5jaGFyQ29kZUF0KGopID49IDB4ODApIHtcclxuXHRcdFx0XHRlcnJvcignbm90LWJhc2ljJyk7XHJcblx0XHRcdH1cclxuXHRcdFx0b3V0cHV0LnB1c2goaW5wdXQuY2hhckNvZGVBdChqKSk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gTWFpbiBkZWNvZGluZyBsb29wOiBzdGFydCBqdXN0IGFmdGVyIHRoZSBsYXN0IGRlbGltaXRlciBpZiBhbnkgYmFzaWMgY29kZVxyXG5cdFx0Ly8gcG9pbnRzIHdlcmUgY29waWVkOyBzdGFydCBhdCB0aGUgYmVnaW5uaW5nIG90aGVyd2lzZS5cclxuXHJcblx0XHRmb3IgKGluZGV4ID0gYmFzaWMgPiAwID8gYmFzaWMgKyAxIDogMDsgaW5kZXggPCBpbnB1dExlbmd0aDsgLyogbm8gZmluYWwgZXhwcmVzc2lvbiAqLykge1xyXG5cclxuXHRcdFx0Ly8gYGluZGV4YCBpcyB0aGUgaW5kZXggb2YgdGhlIG5leHQgY2hhcmFjdGVyIHRvIGJlIGNvbnN1bWVkLlxyXG5cdFx0XHQvLyBEZWNvZGUgYSBnZW5lcmFsaXplZCB2YXJpYWJsZS1sZW5ndGggaW50ZWdlciBpbnRvIGBkZWx0YWAsXHJcblx0XHRcdC8vIHdoaWNoIGdldHMgYWRkZWQgdG8gYGlgLiBUaGUgb3ZlcmZsb3cgY2hlY2tpbmcgaXMgZWFzaWVyXHJcblx0XHRcdC8vIGlmIHdlIGluY3JlYXNlIGBpYCBhcyB3ZSBnbywgdGhlbiBzdWJ0cmFjdCBvZmYgaXRzIHN0YXJ0aW5nXHJcblx0XHRcdC8vIHZhbHVlIGF0IHRoZSBlbmQgdG8gb2J0YWluIGBkZWx0YWAuXHJcblx0XHRcdGZvciAob2xkaSA9IGksIHcgPSAxLCBrID0gYmFzZTsgLyogbm8gY29uZGl0aW9uICovOyBrICs9IGJhc2UpIHtcclxuXHJcblx0XHRcdFx0aWYgKGluZGV4ID49IGlucHV0TGVuZ3RoKSB7XHJcblx0XHRcdFx0XHRlcnJvcignaW52YWxpZC1pbnB1dCcpO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0ZGlnaXQgPSBiYXNpY1RvRGlnaXQoaW5wdXQuY2hhckNvZGVBdChpbmRleCsrKSk7XHJcblxyXG5cdFx0XHRcdGlmIChkaWdpdCA+PSBiYXNlIHx8IGRpZ2l0ID4gZmxvb3IoKG1heEludCAtIGkpIC8gdykpIHtcclxuXHRcdFx0XHRcdGVycm9yKCdvdmVyZmxvdycpO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0aSArPSBkaWdpdCAqIHc7XHJcblx0XHRcdFx0dCA9IGsgPD0gYmlhcyA/IHRNaW4gOiAoayA+PSBiaWFzICsgdE1heCA/IHRNYXggOiBrIC0gYmlhcyk7XHJcblxyXG5cdFx0XHRcdGlmIChkaWdpdCA8IHQpIHtcclxuXHRcdFx0XHRcdGJyZWFrO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0YmFzZU1pbnVzVCA9IGJhc2UgLSB0O1xyXG5cdFx0XHRcdGlmICh3ID4gZmxvb3IobWF4SW50IC8gYmFzZU1pbnVzVCkpIHtcclxuXHRcdFx0XHRcdGVycm9yKCdvdmVyZmxvdycpO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0dyAqPSBiYXNlTWludXNUO1xyXG5cclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0b3V0ID0gb3V0cHV0Lmxlbmd0aCArIDE7XHJcblx0XHRcdGJpYXMgPSBhZGFwdChpIC0gb2xkaSwgb3V0LCBvbGRpID09IDApO1xyXG5cclxuXHRcdFx0Ly8gYGlgIHdhcyBzdXBwb3NlZCB0byB3cmFwIGFyb3VuZCBmcm9tIGBvdXRgIHRvIGAwYCxcclxuXHRcdFx0Ly8gaW5jcmVtZW50aW5nIGBuYCBlYWNoIHRpbWUsIHNvIHdlJ2xsIGZpeCB0aGF0IG5vdzpcclxuXHRcdFx0aWYgKGZsb29yKGkgLyBvdXQpID4gbWF4SW50IC0gbikge1xyXG5cdFx0XHRcdGVycm9yKCdvdmVyZmxvdycpO1xyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHRuICs9IGZsb29yKGkgLyBvdXQpO1xyXG5cdFx0XHRpICU9IG91dDtcclxuXHJcblx0XHRcdC8vIEluc2VydCBgbmAgYXQgcG9zaXRpb24gYGlgIG9mIHRoZSBvdXRwdXRcclxuXHRcdFx0b3V0cHV0LnNwbGljZShpKyssIDAsIG4pO1xyXG5cclxuXHRcdH1cclxuXHJcblx0XHRyZXR1cm4gdWNzMmVuY29kZShvdXRwdXQpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ29udmVydHMgYSBzdHJpbmcgb2YgVW5pY29kZSBzeW1ib2xzIChlLmcuIGEgZG9tYWluIG5hbWUgbGFiZWwpIHRvIGFcclxuXHQgKiBQdW55Y29kZSBzdHJpbmcgb2YgQVNDSUktb25seSBzeW1ib2xzLlxyXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxyXG5cdCAqIEBwYXJhbSB7U3RyaW5nfSBpbnB1dCBUaGUgc3RyaW5nIG9mIFVuaWNvZGUgc3ltYm9scy5cclxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgcmVzdWx0aW5nIFB1bnljb2RlIHN0cmluZyBvZiBBU0NJSS1vbmx5IHN5bWJvbHMuXHJcblx0ICovXHJcblx0ZnVuY3Rpb24gZW5jb2RlKGlucHV0KSB7XHJcblx0XHR2YXIgbixcclxuXHRcdCAgICBkZWx0YSxcclxuXHRcdCAgICBoYW5kbGVkQ1BDb3VudCxcclxuXHRcdCAgICBiYXNpY0xlbmd0aCxcclxuXHRcdCAgICBiaWFzLFxyXG5cdFx0ICAgIGosXHJcblx0XHQgICAgbSxcclxuXHRcdCAgICBxLFxyXG5cdFx0ICAgIGssXHJcblx0XHQgICAgdCxcclxuXHRcdCAgICBjdXJyZW50VmFsdWUsXHJcblx0XHQgICAgb3V0cHV0ID0gW10sXHJcblx0XHQgICAgLyoqIGBpbnB1dExlbmd0aGAgd2lsbCBob2xkIHRoZSBudW1iZXIgb2YgY29kZSBwb2ludHMgaW4gYGlucHV0YC4gKi9cclxuXHRcdCAgICBpbnB1dExlbmd0aCxcclxuXHRcdCAgICAvKiogQ2FjaGVkIGNhbGN1bGF0aW9uIHJlc3VsdHMgKi9cclxuXHRcdCAgICBoYW5kbGVkQ1BDb3VudFBsdXNPbmUsXHJcblx0XHQgICAgYmFzZU1pbnVzVCxcclxuXHRcdCAgICBxTWludXNUO1xyXG5cclxuXHRcdC8vIENvbnZlcnQgdGhlIGlucHV0IGluIFVDUy0yIHRvIFVuaWNvZGVcclxuXHRcdGlucHV0ID0gdWNzMmRlY29kZShpbnB1dCk7XHJcblxyXG5cdFx0Ly8gQ2FjaGUgdGhlIGxlbmd0aFxyXG5cdFx0aW5wdXRMZW5ndGggPSBpbnB1dC5sZW5ndGg7XHJcblxyXG5cdFx0Ly8gSW5pdGlhbGl6ZSB0aGUgc3RhdGVcclxuXHRcdG4gPSBpbml0aWFsTjtcclxuXHRcdGRlbHRhID0gMDtcclxuXHRcdGJpYXMgPSBpbml0aWFsQmlhcztcclxuXHJcblx0XHQvLyBIYW5kbGUgdGhlIGJhc2ljIGNvZGUgcG9pbnRzXHJcblx0XHRmb3IgKGogPSAwOyBqIDwgaW5wdXRMZW5ndGg7ICsraikge1xyXG5cdFx0XHRjdXJyZW50VmFsdWUgPSBpbnB1dFtqXTtcclxuXHRcdFx0aWYgKGN1cnJlbnRWYWx1ZSA8IDB4ODApIHtcclxuXHRcdFx0XHRvdXRwdXQucHVzaChzdHJpbmdGcm9tQ2hhckNvZGUoY3VycmVudFZhbHVlKSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHJcblx0XHRoYW5kbGVkQ1BDb3VudCA9IGJhc2ljTGVuZ3RoID0gb3V0cHV0Lmxlbmd0aDtcclxuXHJcblx0XHQvLyBgaGFuZGxlZENQQ291bnRgIGlzIHRoZSBudW1iZXIgb2YgY29kZSBwb2ludHMgdGhhdCBoYXZlIGJlZW4gaGFuZGxlZDtcclxuXHRcdC8vIGBiYXNpY0xlbmd0aGAgaXMgdGhlIG51bWJlciBvZiBiYXNpYyBjb2RlIHBvaW50cy5cclxuXHJcblx0XHQvLyBGaW5pc2ggdGhlIGJhc2ljIHN0cmluZyAtIGlmIGl0IGlzIG5vdCBlbXB0eSAtIHdpdGggYSBkZWxpbWl0ZXJcclxuXHRcdGlmIChiYXNpY0xlbmd0aCkge1xyXG5cdFx0XHRvdXRwdXQucHVzaChkZWxpbWl0ZXIpO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIE1haW4gZW5jb2RpbmcgbG9vcDpcclxuXHRcdHdoaWxlIChoYW5kbGVkQ1BDb3VudCA8IGlucHV0TGVuZ3RoKSB7XHJcblxyXG5cdFx0XHQvLyBBbGwgbm9uLWJhc2ljIGNvZGUgcG9pbnRzIDwgbiBoYXZlIGJlZW4gaGFuZGxlZCBhbHJlYWR5LiBGaW5kIHRoZSBuZXh0XHJcblx0XHRcdC8vIGxhcmdlciBvbmU6XHJcblx0XHRcdGZvciAobSA9IG1heEludCwgaiA9IDA7IGogPCBpbnB1dExlbmd0aDsgKytqKSB7XHJcblx0XHRcdFx0Y3VycmVudFZhbHVlID0gaW5wdXRbal07XHJcblx0XHRcdFx0aWYgKGN1cnJlbnRWYWx1ZSA+PSBuICYmIGN1cnJlbnRWYWx1ZSA8IG0pIHtcclxuXHRcdFx0XHRcdG0gPSBjdXJyZW50VmFsdWU7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHQvLyBJbmNyZWFzZSBgZGVsdGFgIGVub3VnaCB0byBhZHZhbmNlIHRoZSBkZWNvZGVyJ3MgPG4saT4gc3RhdGUgdG8gPG0sMD4sXHJcblx0XHRcdC8vIGJ1dCBndWFyZCBhZ2FpbnN0IG92ZXJmbG93XHJcblx0XHRcdGhhbmRsZWRDUENvdW50UGx1c09uZSA9IGhhbmRsZWRDUENvdW50ICsgMTtcclxuXHRcdFx0aWYgKG0gLSBuID4gZmxvb3IoKG1heEludCAtIGRlbHRhKSAvIGhhbmRsZWRDUENvdW50UGx1c09uZSkpIHtcclxuXHRcdFx0XHRlcnJvcignb3ZlcmZsb3cnKTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0ZGVsdGEgKz0gKG0gLSBuKSAqIGhhbmRsZWRDUENvdW50UGx1c09uZTtcclxuXHRcdFx0biA9IG07XHJcblxyXG5cdFx0XHRmb3IgKGogPSAwOyBqIDwgaW5wdXRMZW5ndGg7ICsraikge1xyXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZSA9IGlucHV0W2pdO1xyXG5cclxuXHRcdFx0XHRpZiAoY3VycmVudFZhbHVlIDwgbiAmJiArK2RlbHRhID4gbWF4SW50KSB7XHJcblx0XHRcdFx0XHRlcnJvcignb3ZlcmZsb3cnKTtcclxuXHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdGlmIChjdXJyZW50VmFsdWUgPT0gbikge1xyXG5cdFx0XHRcdFx0Ly8gUmVwcmVzZW50IGRlbHRhIGFzIGEgZ2VuZXJhbGl6ZWQgdmFyaWFibGUtbGVuZ3RoIGludGVnZXJcclxuXHRcdFx0XHRcdGZvciAocSA9IGRlbHRhLCBrID0gYmFzZTsgLyogbm8gY29uZGl0aW9uICovOyBrICs9IGJhc2UpIHtcclxuXHRcdFx0XHRcdFx0dCA9IGsgPD0gYmlhcyA/IHRNaW4gOiAoayA+PSBiaWFzICsgdE1heCA/IHRNYXggOiBrIC0gYmlhcyk7XHJcblx0XHRcdFx0XHRcdGlmIChxIDwgdCkge1xyXG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdHFNaW51c1QgPSBxIC0gdDtcclxuXHRcdFx0XHRcdFx0YmFzZU1pbnVzVCA9IGJhc2UgLSB0O1xyXG5cdFx0XHRcdFx0XHRvdXRwdXQucHVzaChcclxuXHRcdFx0XHRcdFx0XHRzdHJpbmdGcm9tQ2hhckNvZGUoZGlnaXRUb0Jhc2ljKHQgKyBxTWludXNUICUgYmFzZU1pbnVzVCwgMCkpXHJcblx0XHRcdFx0XHRcdCk7XHJcblx0XHRcdFx0XHRcdHEgPSBmbG9vcihxTWludXNUIC8gYmFzZU1pbnVzVCk7XHJcblx0XHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdFx0b3V0cHV0LnB1c2goc3RyaW5nRnJvbUNoYXJDb2RlKGRpZ2l0VG9CYXNpYyhxLCAwKSkpO1xyXG5cdFx0XHRcdFx0YmlhcyA9IGFkYXB0KGRlbHRhLCBoYW5kbGVkQ1BDb3VudFBsdXNPbmUsIGhhbmRsZWRDUENvdW50ID09IGJhc2ljTGVuZ3RoKTtcclxuXHRcdFx0XHRcdGRlbHRhID0gMDtcclxuXHRcdFx0XHRcdCsraGFuZGxlZENQQ291bnQ7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHQrK2RlbHRhO1xyXG5cdFx0XHQrK247XHJcblxyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIG91dHB1dC5qb2luKCcnKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENvbnZlcnRzIGEgUHVueWNvZGUgc3RyaW5nIHJlcHJlc2VudGluZyBhIGRvbWFpbiBuYW1lIG9yIGFuIGVtYWlsIGFkZHJlc3NcclxuXHQgKiB0byBVbmljb2RlLiBPbmx5IHRoZSBQdW55Y29kZWQgcGFydHMgb2YgdGhlIGlucHV0IHdpbGwgYmUgY29udmVydGVkLCBpLmUuXHJcblx0ICogaXQgZG9lc24ndCBtYXR0ZXIgaWYgeW91IGNhbGwgaXQgb24gYSBzdHJpbmcgdGhhdCBoYXMgYWxyZWFkeSBiZWVuXHJcblx0ICogY29udmVydGVkIHRvIFVuaWNvZGUuXHJcblx0ICogQG1lbWJlck9mIHB1bnljb2RlXHJcblx0ICogQHBhcmFtIHtTdHJpbmd9IGlucHV0IFRoZSBQdW55Y29kZWQgZG9tYWluIG5hbWUgb3IgZW1haWwgYWRkcmVzcyB0b1xyXG5cdCAqIGNvbnZlcnQgdG8gVW5pY29kZS5cclxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgVW5pY29kZSByZXByZXNlbnRhdGlvbiBvZiB0aGUgZ2l2ZW4gUHVueWNvZGVcclxuXHQgKiBzdHJpbmcuXHJcblx0ICovXHJcblx0ZnVuY3Rpb24gdG9Vbmljb2RlKGlucHV0KSB7XHJcblx0XHRyZXR1cm4gbWFwRG9tYWluKGlucHV0LCBmdW5jdGlvbihzdHJpbmcpIHtcclxuXHRcdFx0cmV0dXJuIHJlZ2V4UHVueWNvZGUudGVzdChzdHJpbmcpXHJcblx0XHRcdFx0PyBkZWNvZGUoc3RyaW5nLnNsaWNlKDQpLnRvTG93ZXJDYXNlKCkpXHJcblx0XHRcdFx0OiBzdHJpbmc7XHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENvbnZlcnRzIGEgVW5pY29kZSBzdHJpbmcgcmVwcmVzZW50aW5nIGEgZG9tYWluIG5hbWUgb3IgYW4gZW1haWwgYWRkcmVzcyB0b1xyXG5cdCAqIFB1bnljb2RlLiBPbmx5IHRoZSBub24tQVNDSUkgcGFydHMgb2YgdGhlIGRvbWFpbiBuYW1lIHdpbGwgYmUgY29udmVydGVkLFxyXG5cdCAqIGkuZS4gaXQgZG9lc24ndCBtYXR0ZXIgaWYgeW91IGNhbGwgaXQgd2l0aCBhIGRvbWFpbiB0aGF0J3MgYWxyZWFkeSBpblxyXG5cdCAqIEFTQ0lJLlxyXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxyXG5cdCAqIEBwYXJhbSB7U3RyaW5nfSBpbnB1dCBUaGUgZG9tYWluIG5hbWUgb3IgZW1haWwgYWRkcmVzcyB0byBjb252ZXJ0LCBhcyBhXHJcblx0ICogVW5pY29kZSBzdHJpbmcuXHJcblx0ICogQHJldHVybnMge1N0cmluZ30gVGhlIFB1bnljb2RlIHJlcHJlc2VudGF0aW9uIG9mIHRoZSBnaXZlbiBkb21haW4gbmFtZSBvclxyXG5cdCAqIGVtYWlsIGFkZHJlc3MuXHJcblx0ICovXHJcblx0ZnVuY3Rpb24gdG9BU0NJSShpbnB1dCkge1xyXG5cdFx0cmV0dXJuIG1hcERvbWFpbihpbnB1dCwgZnVuY3Rpb24oc3RyaW5nKSB7XHJcblx0XHRcdHJldHVybiByZWdleE5vbkFTQ0lJLnRlc3Qoc3RyaW5nKVxyXG5cdFx0XHRcdD8gJ3huLS0nICsgZW5jb2RlKHN0cmluZylcclxuXHRcdFx0XHQ6IHN0cmluZztcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0LyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXHJcblxyXG5cdC8qKiBEZWZpbmUgdGhlIHB1YmxpYyBBUEkgKi9cclxuXHRwdW55Y29kZSA9IHtcclxuXHRcdC8qKlxyXG5cdFx0ICogQSBzdHJpbmcgcmVwcmVzZW50aW5nIHRoZSBjdXJyZW50IFB1bnljb2RlLmpzIHZlcnNpb24gbnVtYmVyLlxyXG5cdFx0ICogQG1lbWJlck9mIHB1bnljb2RlXHJcblx0XHQgKiBAdHlwZSBTdHJpbmdcclxuXHRcdCAqL1xyXG5cdFx0dmVyc2lvbjogJzEuMy4yJyxcclxuXHRcdC8qKlxyXG5cdFx0ICogQW4gb2JqZWN0IG9mIG1ldGhvZHMgdG8gY29udmVydCBmcm9tIEphdmFTY3JpcHQncyBpbnRlcm5hbCBjaGFyYWN0ZXJcclxuXHRcdCAqIHJlcHJlc2VudGF0aW9uIChVQ1MtMikgdG8gVW5pY29kZSBjb2RlIHBvaW50cywgYW5kIGJhY2suXHJcblx0XHQgKiBAc2VlIDxodHRwczovL21hdGhpYXNieW5lbnMuYmUvbm90ZXMvamF2YXNjcmlwdC1lbmNvZGluZz5cclxuXHRcdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxyXG5cdFx0ICogQHR5cGUgT2JqZWN0XHJcblx0XHQgKi9cclxuXHRcdHVjczI6IHtcclxuXHRcdFx0ZGVjb2RlOiB1Y3MyZGVjb2RlLFxyXG5cdFx0XHRlbmNvZGU6IHVjczJlbmNvZGVcclxuXHRcdH0sXHJcblx0XHRkZWNvZGU6IGRlY29kZSxcclxuXHRcdGVuY29kZTogZW5jb2RlLFxyXG5cdFx0dG9BU0NJSTogdG9BU0NJSSxcclxuXHRcdHRvVW5pY29kZTogdG9Vbmljb2RlXHJcblx0fTtcclxuXHJcblx0cmV0dXJuIHB1bnljb2RlO1xyXG59KCkpO1xyXG5cclxuaWYgKHR5cGVvZiBDT01QSUxFRCA9PT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgbW9kdWxlICE9PSBcInVuZGVmaW5lZFwiKSBtb2R1bGUuZXhwb3J0cyA9IHB1bnljb2RlOyIsIi8vLzxyZWZlcmVuY2UgcGF0aD1cImNvbW1vbmpzLmQudHNcIi8+XHJcbnJlcXVpcmUoXCIuL3NjaGVtZXMvaHR0cFwiKTtcclxucmVxdWlyZShcIi4vc2NoZW1lcy91cm5cIik7XHJcbnJlcXVpcmUoXCIuL3NjaGVtZXMvbWFpbHRvXCIpO1xyXG4iLCIvLy88cmVmZXJlbmNlIHBhdGg9XCIuLi91cmkudHNcIi8+XHJcbmlmICh0eXBlb2YgQ09NUElMRUQgPT09IFwidW5kZWZpbmVkXCIgJiYgdHlwZW9mIFVSSSA9PT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgcmVxdWlyZSA9PT0gXCJmdW5jdGlvblwiKVxyXG4gICAgdmFyIFVSSSA9IHJlcXVpcmUoXCIuLi91cmlcIik7XHJcblVSSS5TQ0hFTUVTW1wiaHR0cFwiXSA9IFVSSS5TQ0hFTUVTW1wiaHR0cHNcIl0gPSB7XHJcbiAgICBkb21haW5Ib3N0OiB0cnVlLFxyXG4gICAgcGFyc2U6IGZ1bmN0aW9uIChjb21wb25lbnRzLCBvcHRpb25zKSB7XHJcbiAgICAgICAgLy9yZXBvcnQgbWlzc2luZyBob3N0XHJcbiAgICAgICAgaWYgKCFjb21wb25lbnRzLmhvc3QpIHtcclxuICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJIVFRQIFVSSXMgbXVzdCBoYXZlIGEgaG9zdC5cIjtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICB9LFxyXG4gICAgc2VyaWFsaXplOiBmdW5jdGlvbiAoY29tcG9uZW50cywgb3B0aW9ucykge1xyXG4gICAgICAgIC8vbm9ybWFsaXplIHRoZSBkZWZhdWx0IHBvcnRcclxuICAgICAgICBpZiAoY29tcG9uZW50cy5wb3J0ID09PSAoU3RyaW5nKGNvbXBvbmVudHMuc2NoZW1lKS50b0xvd2VyQ2FzZSgpICE9PSBcImh0dHBzXCIgPyA4MCA6IDQ0MykgfHwgY29tcG9uZW50cy5wb3J0ID09PSBcIlwiKSB7XHJcbiAgICAgICAgICAgIGNvbXBvbmVudHMucG9ydCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy9ub3JtYWxpemUgdGhlIGVtcHR5IHBhdGhcclxuICAgICAgICBpZiAoIWNvbXBvbmVudHMucGF0aCkge1xyXG4gICAgICAgICAgICBjb21wb25lbnRzLnBhdGggPSBcIi9cIjtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy9OT1RFOiBXZSBkbyBub3QgcGFyc2UgcXVlcnkgc3RyaW5ncyBmb3IgSFRUUCBVUklzXHJcbiAgICAgICAgLy9hcyBXV1cgRm9ybSBVcmwgRW5jb2RlZCBxdWVyeSBzdHJpbmdzIGFyZSBwYXJ0IG9mIHRoZSBIVE1MNCsgc3BlYyxcclxuICAgICAgICAvL2FuZCBub3QgdGhlIEhUVFAgc3BlYy4gXHJcbiAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICB9XHJcbn07XHJcbiIsIi8vLzxyZWZlcmVuY2UgcGF0aD1cIi4uL3VyaS50c1wiLz5cclxuaWYgKHR5cGVvZiBDT01QSUxFRCA9PT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgVVJJID09PSBcInVuZGVmaW5lZFwiICYmIHR5cGVvZiByZXF1aXJlID09PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgIHZhciBVUkkgPSByZXF1aXJlKFwiLi4vdXJpXCIpLCBwdW55Y29kZSA9IHJlcXVpcmUoXCIuLi9wdW55Y29kZVwiKTtcclxufVxyXG4oZnVuY3Rpb24gKCkge1xyXG4gICAgZnVuY3Rpb24gbWVyZ2UoKSB7XHJcbiAgICAgICAgdmFyIHNldHMgPSBbXTtcclxuICAgICAgICBmb3IgKHZhciBfaSA9IDA7IF9pIDwgYXJndW1lbnRzLmxlbmd0aDsgX2krKykge1xyXG4gICAgICAgICAgICBzZXRzW19pIC0gMF0gPSBhcmd1bWVudHNbX2ldO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc2V0cy5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIHNldHNbMF0gPSBzZXRzWzBdLnNsaWNlKDAsIC0xKTtcclxuICAgICAgICAgICAgdmFyIHhsID0gc2V0cy5sZW5ndGggLSAxO1xyXG4gICAgICAgICAgICBmb3IgKHZhciB4ID0gMTsgeCA8IHhsOyArK3gpIHtcclxuICAgICAgICAgICAgICAgIHNldHNbeF0gPSBzZXRzW3hdLnNsaWNlKDEsIC0xKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZXRzW3hsXSA9IHNldHNbeGxdLnNsaWNlKDEpO1xyXG4gICAgICAgICAgICByZXR1cm4gc2V0cy5qb2luKCcnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgIHJldHVybiBzZXRzWzBdO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGZ1bmN0aW9uIHN1YmV4cChzdHIpIHtcclxuICAgICAgICByZXR1cm4gXCIoPzpcIiArIHN0ciArIFwiKVwiO1xyXG4gICAgfVxyXG4gICAgdmFyIE8gPSB7fSwgaXNJUkkgPSBVUkkuSVJJX1NVUFBPUlQsIFxyXG4gICAgLy9SRkMgMzk4NlxyXG4gICAgVU5SRVNFUlZFRCQkID0gXCJbQS1aYS16MC05XFxcXC1cXFxcLlxcXFxfXFxcXH5cIiArIChpc0lSSSA/IFwiXFxcXHhBMC1cXFxcdTIwMERcXFxcdTIwMTAtXFxcXHUyMDI5XFxcXHUyMDJGLVxcXFx1RDdGRlxcXFx1RjkwMC1cXFxcdUZEQ0ZcXFxcdUZERjAtXFxcXHVGRkVGXCIgOiBcIlwiKSArIFwiXVwiLCBIRVhESUckJCA9IFwiWzAtOUEtRmEtZl1cIiwgUENUX0VOQ09ERUQkID0gc3ViZXhwKHN1YmV4cChcIiVbRUZlZl1cIiArIEhFWERJRyQkICsgXCIlXCIgKyBIRVhESUckJCArIEhFWERJRyQkICsgXCIlXCIgKyBIRVhESUckJCArIEhFWERJRyQkKSArIFwifFwiICsgc3ViZXhwKFwiJVs4OUEtRmEtZl1cIiArIEhFWERJRyQkICsgXCIlXCIgKyBIRVhESUckJCArIEhFWERJRyQkKSArIFwifFwiICsgc3ViZXhwKFwiJVwiICsgSEVYRElHJCQgKyBIRVhESUckJCkpLCBcclxuICAgIC8vUkZDIDUzMjIsIGV4Y2VwdCB0aGVzZSBzeW1ib2xzIGFzIHBlciBSRkMgNjA2ODogQCA6IC8gPyAjIFsgXSAmIDsgPSBcclxuICAgIC8vQVRFWFQkJCA9IFwiW0EtWmEtejAtOVxcXFwhXFxcXCNcXFxcJFxcXFwlXFxcXCZcXFxcJ1xcXFwqXFxcXCtcXFxcLVxcXFwvXFxcXD1cXFxcP1xcXFxeXFxcXF9cXFxcYFxcXFx7XFxcXHxcXFxcfVxcXFx+XVwiLFxyXG4gICAgLy9XU1AkJCA9IFwiW1xcXFx4MjBcXFxceDA5XVwiLFxyXG4gICAgLy9PQlNfUVRFWFQkJCA9IFwiW1xcXFx4MDEtXFxcXHgwOFxcXFx4MEJcXFxceDBDXFxcXHgwRS1cXFxceDFGXFxcXHg3Rl1cIiwgIC8vKCVkMS04IC8gJWQxMS0xMiAvICVkMTQtMzEgLyAlZDEyNylcclxuICAgIC8vUVRFWFQkJCA9IG1lcmdlKFwiW1xcXFx4MjFcXFxceDIzLVxcXFx4NUJcXFxceDVELVxcXFx4N0VdXCIsIE9CU19RVEVYVCQkKSwgIC8vJWQzMyAvICVkMzUtOTEgLyAlZDkzLTEyNiAvIG9icy1xdGV4dFxyXG4gICAgLy9WQ0hBUiQkID0gXCJbXFxcXHgyMS1cXFxceDdFXVwiLFxyXG4gICAgLy9XU1AkJCA9IFwiW1xcXFx4MjBcXFxceDA5XVwiLFxyXG4gICAgLy9PQlNfUVAkID0gc3ViZXhwKFwiXFxcXFxcXFxcIiArIG1lcmdlKFwiW1xcXFx4MDBcXFxceDBEXFxcXHgwQV1cIiwgT0JTX1FURVhUJCQpKSwgIC8vJWQwIC8gQ1IgLyBMRiAvIG9icy1xdGV4dFxyXG4gICAgLy9GV1MkID0gc3ViZXhwKHN1YmV4cChXU1AkJCArIFwiKlwiICsgXCJcXFxceDBEXFxcXHgwQVwiKSArIFwiP1wiICsgV1NQJCQgKyBcIitcIiksXHJcbiAgICAvL1FVT1RFRF9QQUlSJCA9IHN1YmV4cChzdWJleHAoXCJcXFxcXFxcXFwiICsgc3ViZXhwKFZDSEFSJCQgKyBcInxcIiArIFdTUCQkKSkgKyBcInxcIiArIE9CU19RUCQpLFxyXG4gICAgLy9RVU9URURfU1RSSU5HJCA9IHN1YmV4cCgnXFxcXFwiJyArIHN1YmV4cChGV1MkICsgXCI/XCIgKyBRQ09OVEVOVCQpICsgXCIqXCIgKyBGV1MkICsgXCI/XCIgKyAnXFxcXFwiJyksXHJcbiAgICBBVEVYVCQkID0gXCJbQS1aYS16MC05XFxcXCFcXFxcJFxcXFwlXFxcXCdcXFxcKlxcXFwrXFxcXC1cXFxcXlxcXFxfXFxcXGBcXFxce1xcXFx8XFxcXH1cXFxcfl1cIiwgUVRFWFQkJCA9IFwiW1xcXFwhXFxcXCRcXFxcJVxcXFwnXFxcXChcXFxcKVxcXFwqXFxcXCtcXFxcLFxcXFwtXFxcXC4wLTlcXFxcPFxcXFw+QS1aXFxcXHg1RS1cXFxceDdFXVwiLCBWQ0hBUiQkID0gbWVyZ2UoUVRFWFQkJCwgXCJbXFxcXFxcXCJcXFxcXFxcXF1cIiksIERPVF9BVE9NX1RFWFQkID0gc3ViZXhwKEFURVhUJCQgKyBcIitcIiArIHN1YmV4cChcIlxcXFwuXCIgKyBBVEVYVCQkICsgXCIrXCIpICsgXCIqXCIpLCBRVU9URURfUEFJUiQgPSBzdWJleHAoXCJcXFxcXFxcXFwiICsgVkNIQVIkJCksIFFDT05URU5UJCA9IHN1YmV4cChRVEVYVCQkICsgXCJ8XCIgKyBRVU9URURfUEFJUiQpLCBRVU9URURfU1RSSU5HJCA9IHN1YmV4cCgnXFxcXFwiJyArIFFDT05URU5UJCArIFwiKlwiICsgJ1xcXFxcIicpLCBcclxuICAgIC8vUkZDIDYwNjhcclxuICAgIERURVhUX05PX09CUyQkID0gXCJbXFxcXHgyMS1cXFxceDVBXFxcXHg1RS1cXFxceDdFXVwiLCBTT01FX0RFTElNUyQkID0gXCJbXFxcXCFcXFxcJFxcXFwnXFxcXChcXFxcKVxcXFwqXFxcXCtcXFxcLFxcXFw7XFxcXDpcXFxcQF1cIiwgUUNIQVIkID0gc3ViZXhwKFVOUkVTRVJWRUQkJCArIFwifFwiICsgUENUX0VOQ09ERUQkICsgXCJ8XCIgKyBTT01FX0RFTElNUyQkKSwgRE9NQUlOJCA9IHN1YmV4cChET1RfQVRPTV9URVhUJCArIFwifFwiICsgXCJcXFxcW1wiICsgRFRFWFRfTk9fT0JTJCQgKyBcIipcIiArIFwiXFxcXF1cIiksIExPQ0FMX1BBUlQkID0gc3ViZXhwKERPVF9BVE9NX1RFWFQkICsgXCJ8XCIgKyBRVU9URURfU1RSSU5HJCksIEFERFJfU1BFQyQgPSBzdWJleHAoTE9DQUxfUEFSVCQgKyBcIlxcXFxAXCIgKyBET01BSU4kKSwgVE8kID0gc3ViZXhwKEFERFJfU1BFQyQgKyBzdWJleHAoXCJcXFxcLFwiICsgQUREUl9TUEVDJCkgKyBcIipcIiksIEhGTkFNRSQgPSBzdWJleHAoUUNIQVIkICsgXCIqXCIpLCBIRlZBTFVFJCA9IEhGTkFNRSQsIEhGSUVMRCQgPSBzdWJleHAoSEZOQU1FJCArIFwiXFxcXD1cIiArIEhGVkFMVUUkKSwgSEZJRUxEUzIkID0gc3ViZXhwKEhGSUVMRCQgKyBzdWJleHAoXCJcXFxcJlwiICsgSEZJRUxEJCkgKyBcIipcIiksIEhGSUVMRFMkID0gc3ViZXhwKFwiXFxcXD9cIiArIEhGSUVMRFMyJCksIE1BSUxUT19VUkkgPSBVUkkuVkFMSURBVEVfU1VQUE9SVCAmJiBuZXcgUmVnRXhwKFwiXm1haWx0b1xcXFw6XCIgKyBUTyQgKyBcIj9cIiArIEhGSUVMRFMkICsgXCI/JFwiKSwgVU5SRVNFUlZFRCA9IG5ldyBSZWdFeHAoVU5SRVNFUlZFRCQkLCBcImdcIiksIFBDVF9FTkNPREVEID0gbmV3IFJlZ0V4cChQQ1RfRU5DT0RFRCQsIFwiZ1wiKSwgTk9UX0xPQ0FMX1BBUlQgPSBuZXcgUmVnRXhwKG1lcmdlKFwiW15dXCIsIEFURVhUJCQsIFwiW1xcXFwuXVwiLCAnW1xcXFxcIl0nLCBWQ0hBUiQkKSwgXCJnXCIpLCBOT1RfRE9NQUlOID0gbmV3IFJlZ0V4cChtZXJnZShcIlteXVwiLCBBVEVYVCQkLCBcIltcXFxcLl1cIiwgXCJbXFxcXFtdXCIsIERURVhUX05PX09CUyQkLCBcIltcXFxcXV1cIiksIFwiZ1wiKSwgTk9UX0hGTkFNRSA9IG5ldyBSZWdFeHAobWVyZ2UoXCJbXl1cIiwgVU5SRVNFUlZFRCQkLCBTT01FX0RFTElNUyQkKSwgXCJnXCIpLCBOT1RfSEZWQUxVRSA9IE5PVF9IRk5BTUUsIFRPID0gVVJJLlZBTElEQVRFX1NVUFBPUlQgJiYgbmV3IFJlZ0V4cChcIl5cIiArIFRPJCArIFwiJFwiKSwgSEZJRUxEUyA9IFVSSS5WQUxJREFURV9TVVBQT1JUICYmIG5ldyBSZWdFeHAoXCJeXCIgKyBIRklFTERTMiQgKyBcIiRcIik7XHJcbiAgICBmdW5jdGlvbiB0b1VwcGVyQ2FzZShzdHIpIHtcclxuICAgICAgICByZXR1cm4gc3RyLnRvVXBwZXJDYXNlKCk7XHJcbiAgICB9XHJcbiAgICBmdW5jdGlvbiBkZWNvZGVVbnJlc2VydmVkKHN0cikge1xyXG4gICAgICAgIHZhciBkZWNTdHIgPSBVUkkucGN0RGVjQ2hhcnMoc3RyKTtcclxuICAgICAgICByZXR1cm4gKCFkZWNTdHIubWF0Y2goVU5SRVNFUlZFRCkgPyBzdHIgOiBkZWNTdHIpO1xyXG4gICAgfVxyXG4gICAgZnVuY3Rpb24gdG9BcnJheShvYmopIHtcclxuICAgICAgICByZXR1cm4gb2JqICE9PSB1bmRlZmluZWQgJiYgb2JqICE9PSBudWxsID8gKG9iaiBpbnN0YW5jZW9mIEFycmF5ICYmICFvYmouY2FsbGVlID8gb2JqIDogKHR5cGVvZiBvYmoubGVuZ3RoICE9PSBcIm51bWJlclwiIHx8IG9iai5zcGxpdCB8fCBvYmouc2V0SW50ZXJ2YWwgfHwgb2JqLmNhbGwgPyBbb2JqXSA6IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKG9iaikpKSA6IFtdO1xyXG4gICAgfVxyXG4gICAgVVJJLlNDSEVNRVNbXCJtYWlsdG9cIl0gPSB7XHJcbiAgICAgICAgcGFyc2U6IGZ1bmN0aW9uIChjb21wb25lbnRzLCBvcHRpb25zKSB7XHJcbiAgICAgICAgICAgIGlmIChVUkkuVkFMSURBVEVfU1VQUE9SVCAmJiAhY29tcG9uZW50cy5lcnJvcikge1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbXBvbmVudHMucGF0aCAmJiAhVE8udGVzdChjb21wb25lbnRzLnBhdGgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IFwiRW1haWwgYWRkcmVzcyBpcyBub3QgdmFsaWRcIjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGNvbXBvbmVudHMucXVlcnkgJiYgIUhGSUVMRFMudGVzdChjb21wb25lbnRzLnF1ZXJ5KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuZXJyb3IgPSBcIkhlYWRlciBmaWVsZHMgYXJlIGludmFsaWRcIjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2YXIgdG8gPSBjb21wb25lbnRzLnRvID0gKGNvbXBvbmVudHMucGF0aCA/IGNvbXBvbmVudHMucGF0aC5zcGxpdChcIixcIikgOiBbXSk7XHJcbiAgICAgICAgICAgIGNvbXBvbmVudHMucGF0aCA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudHMucXVlcnkpIHtcclxuICAgICAgICAgICAgICAgIHZhciB1bmtub3duSGVhZGVycyA9IGZhbHNlLCBoZWFkZXJzID0ge307XHJcbiAgICAgICAgICAgICAgICB2YXIgaGZpZWxkcyA9IGNvbXBvbmVudHMucXVlcnkuc3BsaXQoXCImXCIpO1xyXG4gICAgICAgICAgICAgICAgZm9yICh2YXIgeCA9IDAsIHhsID0gaGZpZWxkcy5sZW5ndGg7IHggPCB4bDsgKyt4KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdmFyIGhmaWVsZCA9IGhmaWVsZHNbeF0uc3BsaXQoXCI9XCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaGZpZWxkWzBdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJ0b1wiOlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHRvQWRkcnMgPSBoZmllbGRbMV0uc3BsaXQoXCIsXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgeF8xID0gMCwgeGxfMSA9IHRvQWRkcnMubGVuZ3RoOyB4XzEgPCB4bF8xOyArK3hfMSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvLnB1c2godG9BZGRyc1t4XzFdKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwic3ViamVjdFwiOlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50cy5zdWJqZWN0ID0gVVJJLnVuZXNjYXBlQ29tcG9uZW50KGhmaWVsZFsxXSwgb3B0aW9ucyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSBcImJvZHlcIjpcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuYm9keSA9IFVSSS51bmVzY2FwZUNvbXBvbmVudChoZmllbGRbMV0sIG9wdGlvbnMpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB1bmtub3duSGVhZGVycyA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBoZWFkZXJzW1VSSS51bmVzY2FwZUNvbXBvbmVudChoZmllbGRbMF0sIG9wdGlvbnMpXSA9IFVSSS51bmVzY2FwZUNvbXBvbmVudChoZmllbGRbMV0sIG9wdGlvbnMpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHVua25vd25IZWFkZXJzKVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuaGVhZGVycyA9IGhlYWRlcnM7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcG9uZW50cy5xdWVyeSA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgZm9yICh2YXIgeCA9IDAsIHhsID0gdG8ubGVuZ3RoOyB4IDwgeGw7ICsreCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIGFkZHIgPSB0b1t4XS5zcGxpdChcIkBcIik7XHJcbiAgICAgICAgICAgICAgICBhZGRyWzBdID0gVVJJLnVuZXNjYXBlQ29tcG9uZW50KGFkZHJbMF0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBwdW55Y29kZSAhPT0gXCJ1bmRlZmluZWRcIiAmJiAhb3B0aW9ucy51bmljb2RlU3VwcG9ydCkge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vY29udmVydCBVbmljb2RlIElETiAtPiBBU0NJSSBJRE5cclxuICAgICAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhZGRyWzFdID0gcHVueWNvZGUudG9BU0NJSShVUkkudW5lc2NhcGVDb21wb25lbnQoYWRkclsxXSwgb3B0aW9ucykudG9Mb3dlckNhc2UoKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuZXJyb3IgPSBjb21wb25lbnRzLmVycm9yIHx8IFwiRW1haWwgYWRkcmVzcydzIGRvbWFpbiBuYW1lIGNhbiBub3QgYmUgY29udmVydGVkIHRvIEFTQ0lJIHZpYSBwdW55Y29kZTogXCIgKyBlO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIGFkZHJbMV0gPSBVUkkudW5lc2NhcGVDb21wb25lbnQoYWRkclsxXSwgb3B0aW9ucykudG9Mb3dlckNhc2UoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHRvW3hdID0gYWRkci5qb2luKFwiQFwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gY29tcG9uZW50cztcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNlcmlhbGl6ZTogZnVuY3Rpb24gKGNvbXBvbmVudHMsIG9wdGlvbnMpIHtcclxuICAgICAgICAgICAgdmFyIHRvID0gdG9BcnJheShjb21wb25lbnRzLnRvKTtcclxuICAgICAgICAgICAgaWYgKHRvKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKHZhciB4ID0gMCwgeGwgPSB0by5sZW5ndGg7IHggPCB4bDsgKyt4KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdmFyIHRvQWRkciA9IFN0cmluZyh0b1t4XSk7XHJcbiAgICAgICAgICAgICAgICAgICAgdmFyIGF0SWR4ID0gdG9BZGRyLmxhc3RJbmRleE9mKFwiQFwiKTtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgbG9jYWxQYXJ0ID0gdG9BZGRyLnNsaWNlKDAsIGF0SWR4KTtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgZG9tYWluID0gdG9BZGRyLnNsaWNlKGF0SWR4ICsgMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxQYXJ0ID0gbG9jYWxQYXJ0LnJlcGxhY2UoUENUX0VOQ09ERUQsIGRlY29kZVVucmVzZXJ2ZWQpLnJlcGxhY2UoUENUX0VOQ09ERUQsIHRvVXBwZXJDYXNlKS5yZXBsYWNlKE5PVF9MT0NBTF9QQVJULCBVUkkucGN0RW5jQ2hhcik7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBwdW55Y29kZSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NvbnZlcnQgSUROIHZpYSBwdW55Y29kZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZG9tYWluID0gKCFvcHRpb25zLmlyaSA/IHB1bnljb2RlLnRvQVNDSUkoVVJJLnVuZXNjYXBlQ29tcG9uZW50KGRvbWFpbiwgb3B0aW9ucykudG9Mb3dlckNhc2UoKSkgOiBwdW55Y29kZS50b1VuaWNvZGUoZG9tYWluKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuZXJyb3IgPSBjb21wb25lbnRzLmVycm9yIHx8IFwiRW1haWwgYWRkcmVzcydzIGRvbWFpbiBuYW1lIGNhbiBub3QgYmUgY29udmVydGVkIHRvIFwiICsgKCFvcHRpb25zLmlyaSA/IFwiQVNDSUlcIiA6IFwiVW5pY29kZVwiKSArIFwiIHZpYSBwdW55Y29kZTogXCIgKyBlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW4gPSBkb21haW4ucmVwbGFjZShQQ1RfRU5DT0RFRCwgZGVjb2RlVW5yZXNlcnZlZCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKFBDVF9FTkNPREVELCB0b1VwcGVyQ2FzZSkucmVwbGFjZShOT1RfRE9NQUlOLCBVUkkucGN0RW5jQ2hhcik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIHRvW3hdID0gbG9jYWxQYXJ0ICsgXCJAXCIgKyBkb21haW47XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLnBhdGggPSB0by5qb2luKFwiLFwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2YXIgaGVhZGVycyA9IGNvbXBvbmVudHMuaGVhZGVycyA9IGNvbXBvbmVudHMuaGVhZGVycyB8fCB7fTtcclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudHMuc3ViamVjdClcclxuICAgICAgICAgICAgICAgIGhlYWRlcnNbXCJzdWJqZWN0XCJdID0gY29tcG9uZW50cy5zdWJqZWN0O1xyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50cy5ib2R5KVxyXG4gICAgICAgICAgICAgICAgaGVhZGVyc1tcImJvZHlcIl0gPSBjb21wb25lbnRzLmJvZHk7XHJcbiAgICAgICAgICAgIHZhciBmaWVsZHMgPSBbXTtcclxuICAgICAgICAgICAgZm9yICh2YXIgbmFtZV8xIGluIGhlYWRlcnMpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoZWFkZXJzW25hbWVfMV0gIT09IE9bbmFtZV8xXSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkcy5wdXNoKG5hbWVfMS5yZXBsYWNlKFBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS5yZXBsYWNlKFBDVF9FTkNPREVELCB0b1VwcGVyQ2FzZSkucmVwbGFjZShOT1RfSEZOQU1FLCBVUkkucGN0RW5jQ2hhcikgK1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBcIj1cIiArXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlYWRlcnNbbmFtZV8xXS5yZXBsYWNlKFBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS5yZXBsYWNlKFBDVF9FTkNPREVELCB0b1VwcGVyQ2FzZSkucmVwbGFjZShOT1RfSEZWQUxVRSwgVVJJLnBjdEVuY0NoYXIpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5xdWVyeSA9IGZpZWxkcy5qb2luKFwiJlwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gY29tcG9uZW50cztcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG59KSgpO1xyXG4iLCIvLy88cmVmZXJlbmNlIHBhdGg9XCIuLi91cmkudHNcIi8+XHJcbmlmICh0eXBlb2YgQ09NUElMRUQgPT09IFwidW5kZWZpbmVkXCIgJiYgdHlwZW9mIFVSSSA9PT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgcmVxdWlyZSA9PT0gXCJmdW5jdGlvblwiKVxyXG4gICAgdmFyIFVSSSA9IHJlcXVpcmUoXCIuLi91cmlcIik7XHJcbihmdW5jdGlvbiAoKSB7XHJcbiAgICB2YXIgcGN0RW5jQ2hhciA9IFVSSS5wY3RFbmNDaGFyLCBOSUQkID0gXCIoPzpbMC05QS1aYS16XVswLTlBLVphLXpcXFxcLV17MSwzMX0pXCIsIFBDVF9FTkNPREVEJCA9IFwiKD86XFxcXCVbMC05QS1GYS1mXXsyfSlcIiwgVFJBTlMkJCA9IFwiWzAtOUEtWmEtelxcXFwoXFxcXClcXFxcK1xcXFwsXFxcXC1cXFxcLlxcXFw6XFxcXD1cXFxcQFxcXFw7XFxcXCRcXFxcX1xcXFwhXFxcXCpcXFxcJ1xcXFwvXFxcXD9cXFxcI11cIiwgTlNTJCA9IFwiKD86KD86XCIgKyBQQ1RfRU5DT0RFRCQgKyBcInxcIiArIFRSQU5TJCQgKyBcIikrKVwiLCBVUk5fU0NIRU1FID0gbmV3IFJlZ0V4cChcIl51cm5cXFxcOihcIiArIE5JRCQgKyBcIikkXCIpLCBVUk5fUEFUSCA9IG5ldyBSZWdFeHAoXCJeKFwiICsgTklEJCArIFwiKVxcXFw6KFwiICsgTlNTJCArIFwiKSRcIiksIFVSTl9QQVJTRSA9IC9eKFteXFw6XSspXFw6KC4qKS8sIFVSTl9FWENMVURFRCA9IC9bXFx4MDAtXFx4MjBcXFxcXFxcIlxcJlxcPFxcPlxcW1xcXVxcXlxcYFxce1xcfFxcfVxcflxceDdGLVxceEZGXS9nLCBVVUlEID0gL15bMC05QS1GYS1mXXs4fSg/OlxcLVswLTlBLUZhLWZdezR9KXszfVxcLVswLTlBLUZhLWZdezEyfSQvO1xyXG4gICAgLy9SRkMgMjE0MVxyXG4gICAgVVJJLlNDSEVNRVNbXCJ1cm5cIl0gPSB7XHJcbiAgICAgICAgcGFyc2U6IGZ1bmN0aW9uIChjb21wb25lbnRzLCBvcHRpb25zKSB7XHJcbiAgICAgICAgICAgIHZhciBtYXRjaGVzID0gY29tcG9uZW50cy5wYXRoLm1hdGNoKFVSTl9QQVRIKSwgc2NoZW1lLCBzY2hlbWVIYW5kbGVyO1xyXG4gICAgICAgICAgICBpZiAoIW1hdGNoZXMpIHtcclxuICAgICAgICAgICAgICAgIGlmICghb3B0aW9ucy50b2xlcmFudCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuZXJyb3IgPSBjb21wb25lbnRzLmVycm9yIHx8IFwiVVJOIGlzIG5vdCBzdHJpY3RseSB2YWxpZC5cIjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIG1hdGNoZXMgPSBjb21wb25lbnRzLnBhdGgubWF0Y2goVVJOX1BBUlNFKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobWF0Y2hlcykge1xyXG4gICAgICAgICAgICAgICAgc2NoZW1lID0gXCJ1cm46XCIgKyBtYXRjaGVzWzFdLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgICAgICAgICBzY2hlbWVIYW5kbGVyID0gVVJJLlNDSEVNRVNbc2NoZW1lXTtcclxuICAgICAgICAgICAgICAgIC8vaW4gb3JkZXIgdG8gc2VyaWFsaXplIHByb3Blcmx5LCBcclxuICAgICAgICAgICAgICAgIC8vZXZlcnkgVVJOIG11c3QgaGF2ZSBhIHNlcmlhbGl6ZXIgdGhhdCBjYWxscyB0aGUgVVJOIHNlcmlhbGl6ZXIgXHJcbiAgICAgICAgICAgICAgICBpZiAoIXNjaGVtZUhhbmRsZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBmYWtlIHNjaGVtZSBoYW5kbGVyXHJcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1lSGFuZGxlciA9IFVSSS5TQ0hFTUVTW3NjaGVtZV0gPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcnNlOiBmdW5jdGlvbiAoY29tcG9uZW50cywgb3B0aW9ucykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNlcmlhbGl6ZTogVVJJLlNDSEVNRVNbXCJ1cm5cIl0uc2VyaWFsaXplXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuc2NoZW1lID0gc2NoZW1lO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5wYXRoID0gbWF0Y2hlc1syXTtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMgPSBzY2hlbWVIYW5kbGVyLnBhcnNlKGNvbXBvbmVudHMsIG9wdGlvbnMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJVUk4gY2FuIG5vdCBiZSBwYXJzZWQuXCI7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBzZXJpYWxpemU6IGZ1bmN0aW9uIChjb21wb25lbnRzLCBvcHRpb25zKSB7XHJcbiAgICAgICAgICAgIHZhciBzY2hlbWUgPSBjb21wb25lbnRzLnNjaGVtZSB8fCBvcHRpb25zLnNjaGVtZSwgbWF0Y2hlcztcclxuICAgICAgICAgICAgaWYgKHNjaGVtZSAmJiBzY2hlbWUgIT09IFwidXJuXCIpIHtcclxuICAgICAgICAgICAgICAgIHZhciBtYXRjaGVzID0gc2NoZW1lLm1hdGNoKFVSTl9TQ0hFTUUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFtYXRjaGVzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2hlcyA9IFtcInVybjpcIiArIHNjaGVtZSwgc2NoZW1lXTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuc2NoZW1lID0gXCJ1cm5cIjtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucGF0aCA9IG1hdGNoZXNbMV0gKyBcIjpcIiArIChjb21wb25lbnRzLnBhdGggPyBjb21wb25lbnRzLnBhdGgucmVwbGFjZShVUk5fRVhDTFVERUQsIHBjdEVuY0NoYXIpIDogXCJcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIC8vUkZDIDQxMjJcclxuICAgIFVSSS5TQ0hFTUVTW1widXJuOnV1aWRcIl0gPSB7XHJcbiAgICAgICAgcGFyc2U6IGZ1bmN0aW9uIChjb21wb25lbnRzLCBvcHRpb25zKSB7XHJcbiAgICAgICAgICAgIGlmICghb3B0aW9ucy50b2xlcmFudCAmJiAoIWNvbXBvbmVudHMucGF0aCB8fCAhY29tcG9uZW50cy5wYXRoLm1hdGNoKFVVSUQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJVVUlEIGlzIG5vdCB2YWxpZC5cIjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gY29tcG9uZW50cztcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNlcmlhbGl6ZTogZnVuY3Rpb24gKGNvbXBvbmVudHMsIG9wdGlvbnMpIHtcclxuICAgICAgICAgICAgLy9lbnN1cmUgVVVJRCBpcyB2YWxpZFxyXG4gICAgICAgICAgICBpZiAoIW9wdGlvbnMudG9sZXJhbnQgJiYgKCFjb21wb25lbnRzLnBhdGggfHwgIWNvbXBvbmVudHMucGF0aC5tYXRjaChVVUlEKSkpIHtcclxuICAgICAgICAgICAgICAgIC8vaW52YWxpZCBVVUlEcyBjYW4gbm90IGhhdmUgdGhpcyBzY2hlbWVcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuc2NoZW1lID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy9ub3JtYWxpemUgVVVJRFxyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5wYXRoID0gKGNvbXBvbmVudHMucGF0aCB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiBVUkkuU0NIRU1FU1tcInVyblwiXS5zZXJpYWxpemUoY29tcG9uZW50cywgb3B0aW9ucyk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxufSgpKTtcclxuIiwiLyoqXHJcbiAqIFVSSS5qc1xyXG4gKlxyXG4gKiBAZmlsZW92ZXJ2aWV3IEFuIFJGQyAzOTg2IGNvbXBsaWFudCwgc2NoZW1lIGV4dGVuZGFibGUgVVJJIHBhcnNpbmcvdmFsaWRhdGluZy9yZXNvbHZpbmcgbGlicmFyeSBmb3IgSmF2YVNjcmlwdC5cclxuICogQGF1dGhvciA8YSBocmVmPVwibWFpbHRvOmdhcnkuY291cnRAZ21haWwuY29tXCI+R2FyeSBDb3VydDwvYT5cclxuICogQHZlcnNpb24gMi4wLjBcclxuICogQHNlZSBodHRwOi8vZ2l0aHViLmNvbS9nYXJ5Y291cnQvdXJpLWpzXHJcbiAqIEBsaWNlbnNlIFVSSS5qcyB2Mi4wLjAgKGMpIDIwMTEgR2FyeSBDb3VydC4gTGljZW5zZTogaHR0cDovL2dpdGh1Yi5jb20vZ2FyeWNvdXJ0L3VyaS1qc1xyXG4gKi9cclxuLyoqXHJcbiAqIENvcHlyaWdodCAyMDExIEdhcnkgQ291cnQuIEFsbCByaWdodHMgcmVzZXJ2ZWQuXHJcbiAqXHJcbiAqIFJlZGlzdHJpYnV0aW9uIGFuZCB1c2UgaW4gc291cmNlIGFuZCBiaW5hcnkgZm9ybXMsIHdpdGggb3Igd2l0aG91dCBtb2RpZmljYXRpb24sIGFyZVxyXG4gKiBwZXJtaXR0ZWQgcHJvdmlkZWQgdGhhdCB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnMgYXJlIG1ldDpcclxuICpcclxuICogICAgMS4gUmVkaXN0cmlidXRpb25zIG9mIHNvdXJjZSBjb2RlIG11c3QgcmV0YWluIHRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlLCB0aGlzIGxpc3Qgb2ZcclxuICogICAgICAgY29uZGl0aW9ucyBhbmQgdGhlIGZvbGxvd2luZyBkaXNjbGFpbWVyLlxyXG4gKlxyXG4gKiAgICAyLiBSZWRpc3RyaWJ1dGlvbnMgaW4gYmluYXJ5IGZvcm0gbXVzdCByZXByb2R1Y2UgdGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UsIHRoaXMgbGlzdFxyXG4gKiAgICAgICBvZiBjb25kaXRpb25zIGFuZCB0aGUgZm9sbG93aW5nIGRpc2NsYWltZXIgaW4gdGhlIGRvY3VtZW50YXRpb24gYW5kL29yIG90aGVyIG1hdGVyaWFsc1xyXG4gKiAgICAgICBwcm92aWRlZCB3aXRoIHRoZSBkaXN0cmlidXRpb24uXHJcbiAqXHJcbiAqIFRISVMgU09GVFdBUkUgSVMgUFJPVklERUQgQlkgR0FSWSBDT1VSVCBgYEFTIElTJycgQU5EIEFOWSBFWFBSRVNTIE9SIElNUExJRURcclxuICogV0FSUkFOVElFUywgSU5DTFVESU5HLCBCVVQgTk9UIExJTUlURUQgVE8sIFRIRSBJTVBMSUVEIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZIEFORFxyXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBUkUgRElTQ0xBSU1FRC4gSU4gTk8gRVZFTlQgU0hBTEwgR0FSWSBDT1VSVCBPUlxyXG4gKiBDT05UUklCVVRPUlMgQkUgTElBQkxFIEZPUiBBTlkgRElSRUNULCBJTkRJUkVDVCwgSU5DSURFTlRBTCwgU1BFQ0lBTCwgRVhFTVBMQVJZLCBPUlxyXG4gKiBDT05TRVFVRU5USUFMIERBTUFHRVMgKElOQ0xVRElORywgQlVUIE5PVCBMSU1JVEVEIFRPLCBQUk9DVVJFTUVOVCBPRiBTVUJTVElUVVRFIEdPT0RTIE9SXHJcbiAqIFNFUlZJQ0VTOyBMT1NTIE9GIFVTRSwgREFUQSwgT1IgUFJPRklUUzsgT1IgQlVTSU5FU1MgSU5URVJSVVBUSU9OKSBIT1dFVkVSIENBVVNFRCBBTkQgT05cclxuICogQU5ZIFRIRU9SWSBPRiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQ09OVFJBQ1QsIFNUUklDVCBMSUFCSUxJVFksIE9SIFRPUlQgKElOQ0xVRElOR1xyXG4gKiBORUdMSUdFTkNFIE9SIE9USEVSV0lTRSkgQVJJU0lORyBJTiBBTlkgV0FZIE9VVCBPRiBUSEUgVVNFIE9GIFRISVMgU09GVFdBUkUsIEVWRU4gSUZcclxuICogQURWSVNFRCBPRiBUSEUgUE9TU0lCSUxJVFkgT0YgU1VDSCBEQU1BR0UuXHJcbiAqXHJcbiAqIFRoZSB2aWV3cyBhbmQgY29uY2x1c2lvbnMgY29udGFpbmVkIGluIHRoZSBzb2Z0d2FyZSBhbmQgZG9jdW1lbnRhdGlvbiBhcmUgdGhvc2Ugb2YgdGhlXHJcbiAqIGF1dGhvcnMgYW5kIHNob3VsZCBub3QgYmUgaW50ZXJwcmV0ZWQgYXMgcmVwcmVzZW50aW5nIG9mZmljaWFsIHBvbGljaWVzLCBlaXRoZXIgZXhwcmVzc2VkXHJcbiAqIG9yIGltcGxpZWQsIG9mIEdhcnkgQ291cnQuXHJcbiAqL1xyXG4vLy88cmVmZXJlbmNlIHBhdGg9XCJwdW55Y29kZS5kLnRzXCIvPlxyXG4vLy88cmVmZXJlbmNlIHBhdGg9XCJjb21tb25qcy5kLnRzXCIvPlxyXG4vKipcclxuICogQ29tcGlsZXIgc3dpdGNoIGZvciBpbmRpY2F0aW5nIGNvZGUgaXMgY29tcGlsZWRcclxuICogQGRlZmluZSB7Ym9vbGVhbn1cclxuICovXHJcbnZhciBDT01QSUxFRCA9IGZhbHNlO1xyXG4vKipcclxuICogQ29tcGlsZXIgc3dpdGNoIGZvciBzdXBwb3J0aW5nIElSSSBVUklzXHJcbiAqIEBkZWZpbmUge2Jvb2xlYW59XHJcbiAqL1xyXG52YXIgVVJJX19JUklfU1VQUE9SVCA9IHRydWU7XHJcbi8qKlxyXG4gKiBDb21waWxlciBzd2l0Y2ggZm9yIHN1cHBvcnRpbmcgVVJJIHZhbGlkYXRpb25cclxuICogQGRlZmluZSB7Ym9vbGVhbn1cclxuICovXHJcbnZhciBVUklfX1ZBTElEQVRFX1NVUFBPUlQgPSB0cnVlO1xyXG52YXIgVVJJID0gKGZ1bmN0aW9uICgpIHtcclxuICAgIGZ1bmN0aW9uIG1lcmdlKCkge1xyXG4gICAgICAgIHZhciBzZXRzID0gW107XHJcbiAgICAgICAgZm9yICh2YXIgX2kgPSAwOyBfaSA8IGFyZ3VtZW50cy5sZW5ndGg7IF9pKyspIHtcclxuICAgICAgICAgICAgc2V0c1tfaSAtIDBdID0gYXJndW1lbnRzW19pXTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNldHMubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBzZXRzWzBdID0gc2V0c1swXS5zbGljZSgwLCAtMSk7XHJcbiAgICAgICAgICAgIHZhciB4bCA9IHNldHMubGVuZ3RoIC0gMTtcclxuICAgICAgICAgICAgZm9yICh2YXIgeCA9IDE7IHggPCB4bDsgKyt4KSB7XHJcbiAgICAgICAgICAgICAgICBzZXRzW3hdID0gc2V0c1t4XS5zbGljZSgxLCAtMSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2V0c1t4bF0gPSBzZXRzW3hsXS5zbGljZSgxKTtcclxuICAgICAgICAgICAgcmV0dXJuIHNldHMuam9pbignJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICByZXR1cm4gc2V0c1swXTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBmdW5jdGlvbiBzdWJleHAoc3RyKSB7XHJcbiAgICAgICAgcmV0dXJuIFwiKD86XCIgKyBzdHIgKyBcIilcIjtcclxuICAgIH1cclxuICAgIGZ1bmN0aW9uIGJ1aWxkRXhwcyhpc0lSSSkge1xyXG4gICAgICAgIHZhciBBTFBIQSQkID0gXCJbQS1aYS16XVwiLCBDUiQgPSBcIltcXFxceDBEXVwiLCBESUdJVCQkID0gXCJbMC05XVwiLCBEUVVPVEUkJCA9IFwiW1xcXFx4MjJdXCIsIEhFWERJRyQkID0gbWVyZ2UoRElHSVQkJCwgXCJbQS1GYS1mXVwiKSwgTEYkJCA9IFwiW1xcXFx4MEFdXCIsIFNQJCQgPSBcIltcXFxceDIwXVwiLCBQQ1RfRU5DT0RFRCQgPSBzdWJleHAoc3ViZXhwKFwiJVtFRmVmXVwiICsgSEVYRElHJCQgKyBcIiVcIiArIEhFWERJRyQkICsgSEVYRElHJCQgKyBcIiVcIiArIEhFWERJRyQkICsgSEVYRElHJCQpICsgXCJ8XCIgKyBzdWJleHAoXCIlWzg5QS1GYS1mXVwiICsgSEVYRElHJCQgKyBcIiVcIiArIEhFWERJRyQkICsgSEVYRElHJCQpICsgXCJ8XCIgKyBzdWJleHAoXCIlXCIgKyBIRVhESUckJCArIEhFWERJRyQkKSksIEdFTl9ERUxJTVMkJCA9IFwiW1xcXFw6XFxcXC9cXFxcP1xcXFwjXFxcXFtcXFxcXVxcXFxAXVwiLCBTVUJfREVMSU1TJCQgPSBcIltcXFxcIVxcXFwkXFxcXCZcXFxcJ1xcXFwoXFxcXClcXFxcKlxcXFwrXFxcXCxcXFxcO1xcXFw9XVwiLCBSRVNFUlZFRCQkID0gbWVyZ2UoR0VOX0RFTElNUyQkLCBTVUJfREVMSU1TJCQpLCBVQ1NDSEFSJCQgPSBpc0lSSSA/IFwiW1xcXFx4QTAtXFxcXHUyMDBEXFxcXHUyMDEwLVxcXFx1MjAyOVxcXFx1MjAyRi1cXFxcdUQ3RkZcXFxcdUY5MDAtXFxcXHVGRENGXFxcXHVGREYwLVxcXFx1RkZFRl1cIiA6IFwiW11cIiwgSVBSSVZBVEUkJCA9IGlzSVJJID8gXCJbXFxcXHVFMDAwLVxcXFx1RjhGRl1cIiA6IFwiW11cIiwgVU5SRVNFUlZFRCQkID0gbWVyZ2UoQUxQSEEkJCwgRElHSVQkJCwgXCJbXFxcXC1cXFxcLlxcXFxfXFxcXH5dXCIsIFVDU0NIQVIkJCksIFNDSEVNRSQgPSBzdWJleHAoQUxQSEEkJCArIG1lcmdlKEFMUEhBJCQsIERJR0lUJCQsIFwiW1xcXFwrXFxcXC1cXFxcLl1cIikgKyBcIipcIiksIFVTRVJJTkZPJCA9IHN1YmV4cChzdWJleHAoUENUX0VOQ09ERUQkICsgXCJ8XCIgKyBtZXJnZShVTlJFU0VSVkVEJCQsIFNVQl9ERUxJTVMkJCwgXCJbXFxcXDpdXCIpKSArIFwiKlwiKSwgREVDX09DVEVUJCA9IHN1YmV4cChzdWJleHAoXCIyNVswLTVdXCIpICsgXCJ8XCIgKyBzdWJleHAoXCIyWzAtNF1cIiArIERJR0lUJCQpICsgXCJ8XCIgKyBzdWJleHAoXCIxXCIgKyBESUdJVCQkICsgRElHSVQkJCkgKyBcInxcIiArIHN1YmV4cChcIlsxLTldXCIgKyBESUdJVCQkKSArIFwifFwiICsgRElHSVQkJCksIElQVjRBRERSRVNTJCA9IHN1YmV4cChERUNfT0NURVQkICsgXCJcXFxcLlwiICsgREVDX09DVEVUJCArIFwiXFxcXC5cIiArIERFQ19PQ1RFVCQgKyBcIlxcXFwuXCIgKyBERUNfT0NURVQkKSwgSDE2JCA9IHN1YmV4cChIRVhESUckJCArIFwiezEsNH1cIiksIExTMzIkID0gc3ViZXhwKHN1YmV4cChIMTYkICsgXCJcXFxcOlwiICsgSDE2JCkgKyBcInxcIiArIElQVjRBRERSRVNTJCksIElQVjZBRERSRVNTJCA9IHN1YmV4cChtZXJnZShVTlJFU0VSVkVEJCQsIFNVQl9ERUxJTVMkJCwgXCJbXFxcXDpdXCIpICsgXCIrXCIpLCBJUFZGVVRVUkUkID0gc3ViZXhwKFwidlwiICsgSEVYRElHJCQgKyBcIitcXFxcLlwiICsgbWVyZ2UoVU5SRVNFUlZFRCQkLCBTVUJfREVMSU1TJCQsIFwiW1xcXFw6XVwiKSArIFwiK1wiKSwgSVBfTElURVJBTCQgPSBzdWJleHAoXCJcXFxcW1wiICsgc3ViZXhwKElQVjZBRERSRVNTJCArIFwifFwiICsgSVBWRlVUVVJFJCkgKyBcIlxcXFxdXCIpLCBSRUdfTkFNRSQgPSBzdWJleHAoc3ViZXhwKFBDVF9FTkNPREVEJCArIFwifFwiICsgbWVyZ2UoVU5SRVNFUlZFRCQkLCBTVUJfREVMSU1TJCQpKSArIFwiKlwiKSwgSE9TVCQgPSBzdWJleHAoSVBfTElURVJBTCQgKyBcInxcIiArIElQVjRBRERSRVNTJCArIFwiKD8hXCIgKyBSRUdfTkFNRSQgKyBcIilcIiArIFwifFwiICsgUkVHX05BTUUkKSwgUE9SVCQgPSBzdWJleHAoRElHSVQkJCArIFwiKlwiKSwgQVVUSE9SSVRZJCA9IHN1YmV4cChzdWJleHAoVVNFUklORk8kICsgXCJAXCIpICsgXCI/XCIgKyBIT1NUJCArIHN1YmV4cChcIlxcXFw6XCIgKyBQT1JUJCkgKyBcIj9cIiksIFBDSEFSJCA9IHN1YmV4cChQQ1RfRU5DT0RFRCQgKyBcInxcIiArIG1lcmdlKFVOUkVTRVJWRUQkJCwgU1VCX0RFTElNUyQkLCBcIltcXFxcOlxcXFxAXVwiKSksIFNFR01FTlQkID0gc3ViZXhwKFBDSEFSJCArIFwiKlwiKSwgU0VHTUVOVF9OWiQgPSBzdWJleHAoUENIQVIkICsgXCIrXCIpLCBTRUdNRU5UX05aX05DJCA9IHN1YmV4cChzdWJleHAoUENUX0VOQ09ERUQkICsgXCJ8XCIgKyBtZXJnZShVTlJFU0VSVkVEJCQsIFNVQl9ERUxJTVMkJCwgXCJbXFxcXEBdXCIpKSArIFwiK1wiKSwgUEFUSF9BQkVNUFRZJCA9IHN1YmV4cChzdWJleHAoXCJcXFxcL1wiICsgU0VHTUVOVCQpICsgXCIqXCIpLCBQQVRIX0FCU09MVVRFJCA9IHN1YmV4cChcIlxcXFwvXCIgKyBzdWJleHAoU0VHTUVOVF9OWiQgKyBQQVRIX0FCRU1QVFkkKSArIFwiP1wiKSwgUEFUSF9OT1NDSEVNRSQgPSBzdWJleHAoU0VHTUVOVF9OWl9OQyQgKyBQQVRIX0FCRU1QVFkkKSwgUEFUSF9ST09UTEVTUyQgPSBzdWJleHAoU0VHTUVOVF9OWiQgKyBQQVRIX0FCRU1QVFkkKSwgUEFUSF9FTVBUWSQgPSBcIig/IVwiICsgUENIQVIkICsgXCIpXCIsIFBBVEgkID0gc3ViZXhwKFBBVEhfQUJFTVBUWSQgKyBcInxcIiArIFBBVEhfQUJTT0xVVEUkICsgXCJ8XCIgKyBQQVRIX05PU0NIRU1FJCArIFwifFwiICsgUEFUSF9ST09UTEVTUyQgKyBcInxcIiArIFBBVEhfRU1QVFkkKSwgUVVFUlkkID0gc3ViZXhwKHN1YmV4cChQQ0hBUiQgKyBcInxcIiArIG1lcmdlKFwiW1xcXFwvXFxcXD9dXCIsIElQUklWQVRFJCQpKSArIFwiKlwiKSwgRlJBR01FTlQkID0gc3ViZXhwKHN1YmV4cChQQ0hBUiQgKyBcInxbXFxcXC9cXFxcP11cIikgKyBcIipcIiksIEhJRVJfUEFSVCQgPSBzdWJleHAoc3ViZXhwKFwiXFxcXC9cXFxcL1wiICsgQVVUSE9SSVRZJCArIFBBVEhfQUJFTVBUWSQpICsgXCJ8XCIgKyBQQVRIX0FCU09MVVRFJCArIFwifFwiICsgUEFUSF9ST09UTEVTUyQgKyBcInxcIiArIFBBVEhfRU1QVFkkKSwgVVJJJCA9IHN1YmV4cChTQ0hFTUUkICsgXCJcXFxcOlwiICsgSElFUl9QQVJUJCArIHN1YmV4cChcIlxcXFw/XCIgKyBRVUVSWSQpICsgXCI/XCIgKyBzdWJleHAoXCJcXFxcI1wiICsgRlJBR01FTlQkKSArIFwiP1wiKSwgUkVMQVRJVkVfUEFSVCQgPSBzdWJleHAoc3ViZXhwKFwiXFxcXC9cXFxcL1wiICsgQVVUSE9SSVRZJCArIFBBVEhfQUJFTVBUWSQpICsgXCJ8XCIgKyBQQVRIX0FCU09MVVRFJCArIFwifFwiICsgUEFUSF9OT1NDSEVNRSQgKyBcInxcIiArIFBBVEhfRU1QVFkkKSwgUkVMQVRJVkUkID0gc3ViZXhwKFJFTEFUSVZFX1BBUlQkICsgc3ViZXhwKFwiXFxcXD9cIiArIFFVRVJZJCkgKyBcIj9cIiArIHN1YmV4cChcIlxcXFwjXCIgKyBGUkFHTUVOVCQpICsgXCI/XCIpLCBVUklfUkVGRVJFTkNFJCA9IHN1YmV4cChVUkkkICsgXCJ8XCIgKyBSRUxBVElWRSQpLCBBQlNPTFVURV9VUkkkID0gc3ViZXhwKFNDSEVNRSQgKyBcIlxcXFw6XCIgKyBISUVSX1BBUlQkICsgc3ViZXhwKFwiXFxcXD9cIiArIFFVRVJZJCkgKyBcIj9cIiksIEdFTkVSSUNfUkVGJCA9IFwiXihcIiArIFNDSEVNRSQgKyBcIilcXFxcOlwiICsgc3ViZXhwKHN1YmV4cChcIlxcXFwvXFxcXC8oXCIgKyBzdWJleHAoXCIoXCIgKyBVU0VSSU5GTyQgKyBcIilAXCIpICsgXCI/KFwiICsgSE9TVCQgKyBcIilcIiArIHN1YmV4cChcIlxcXFw6KFwiICsgUE9SVCQgKyBcIilcIikgKyBcIj8pXCIpICsgXCI/KFwiICsgUEFUSF9BQkVNUFRZJCArIFwifFwiICsgUEFUSF9BQlNPTFVURSQgKyBcInxcIiArIFBBVEhfUk9PVExFU1MkICsgXCJ8XCIgKyBQQVRIX0VNUFRZJCArIFwiKVwiKSArIHN1YmV4cChcIlxcXFw/KFwiICsgUVVFUlkkICsgXCIpXCIpICsgXCI/XCIgKyBzdWJleHAoXCJcXFxcIyhcIiArIEZSQUdNRU5UJCArIFwiKVwiKSArIFwiPyRcIiwgUkVMQVRJVkVfUkVGJCA9IFwiXigpezB9XCIgKyBzdWJleHAoc3ViZXhwKFwiXFxcXC9cXFxcLyhcIiArIHN1YmV4cChcIihcIiArIFVTRVJJTkZPJCArIFwiKUBcIikgKyBcIj8oXCIgKyBIT1NUJCArIFwiKVwiICsgc3ViZXhwKFwiXFxcXDooXCIgKyBQT1JUJCArIFwiKVwiKSArIFwiPylcIikgKyBcIj8oXCIgKyBQQVRIX0FCRU1QVFkkICsgXCJ8XCIgKyBQQVRIX0FCU09MVVRFJCArIFwifFwiICsgUEFUSF9OT1NDSEVNRSQgKyBcInxcIiArIFBBVEhfRU1QVFkkICsgXCIpXCIpICsgc3ViZXhwKFwiXFxcXD8oXCIgKyBRVUVSWSQgKyBcIilcIikgKyBcIj9cIiArIHN1YmV4cChcIlxcXFwjKFwiICsgRlJBR01FTlQkICsgXCIpXCIpICsgXCI/JFwiLCBBQlNPTFVURV9SRUYkID0gXCJeKFwiICsgU0NIRU1FJCArIFwiKVxcXFw6XCIgKyBzdWJleHAoc3ViZXhwKFwiXFxcXC9cXFxcLyhcIiArIHN1YmV4cChcIihcIiArIFVTRVJJTkZPJCArIFwiKUBcIikgKyBcIj8oXCIgKyBIT1NUJCArIFwiKVwiICsgc3ViZXhwKFwiXFxcXDooXCIgKyBQT1JUJCArIFwiKVwiKSArIFwiPylcIikgKyBcIj8oXCIgKyBQQVRIX0FCRU1QVFkkICsgXCJ8XCIgKyBQQVRIX0FCU09MVVRFJCArIFwifFwiICsgUEFUSF9ST09UTEVTUyQgKyBcInxcIiArIFBBVEhfRU1QVFkkICsgXCIpXCIpICsgc3ViZXhwKFwiXFxcXD8oXCIgKyBRVUVSWSQgKyBcIilcIikgKyBcIj8kXCIsIFNBTUVET0NfUkVGJCA9IFwiXlwiICsgc3ViZXhwKFwiXFxcXCMoXCIgKyBGUkFHTUVOVCQgKyBcIilcIikgKyBcIj8kXCIsIEFVVEhPUklUWV9SRUYkID0gXCJeXCIgKyBzdWJleHAoXCIoXCIgKyBVU0VSSU5GTyQgKyBcIilAXCIpICsgXCI/KFwiICsgSE9TVCQgKyBcIilcIiArIHN1YmV4cChcIlxcXFw6KFwiICsgUE9SVCQgKyBcIilcIikgKyBcIj8kXCI7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgVVJJX1JFRjogVVJJX19WQUxJREFURV9TVVBQT1JUICYmIG5ldyBSZWdFeHAoXCIoXCIgKyBHRU5FUklDX1JFRiQgKyBcIil8KFwiICsgUkVMQVRJVkVfUkVGJCArIFwiKVwiKSxcclxuICAgICAgICAgICAgTk9UX1NDSEVNRTogbmV3IFJlZ0V4cChtZXJnZShcIlteXVwiLCBBTFBIQSQkLCBESUdJVCQkLCBcIltcXFxcK1xcXFwtXFxcXC5dXCIpLCBcImdcIiksXHJcbiAgICAgICAgICAgIE5PVF9VU0VSSU5GTzogbmV3IFJlZ0V4cChtZXJnZShcIlteXFxcXCVcXFxcOl1cIiwgVU5SRVNFUlZFRCQkLCBTVUJfREVMSU1TJCQpLCBcImdcIiksXHJcbiAgICAgICAgICAgIE5PVF9IT1NUOiBuZXcgUmVnRXhwKG1lcmdlKFwiW15cXFxcJV1cIiwgVU5SRVNFUlZFRCQkLCBTVUJfREVMSU1TJCQpLCBcImdcIiksXHJcbiAgICAgICAgICAgIE5PVF9QQVRIOiBuZXcgUmVnRXhwKG1lcmdlKFwiW15cXFxcJVxcXFwvXFxcXDpcXFxcQF1cIiwgVU5SRVNFUlZFRCQkLCBTVUJfREVMSU1TJCQpLCBcImdcIiksXHJcbiAgICAgICAgICAgIE5PVF9QQVRIX05PU0NIRU1FOiBuZXcgUmVnRXhwKG1lcmdlKFwiW15cXFxcJVxcXFwvXFxcXEBdXCIsIFVOUkVTRVJWRUQkJCwgU1VCX0RFTElNUyQkKSwgXCJnXCIpLFxyXG4gICAgICAgICAgICBOT1RfUVVFUlk6IG5ldyBSZWdFeHAobWVyZ2UoXCJbXlxcXFwlXVwiLCBVTlJFU0VSVkVEJCQsIFNVQl9ERUxJTVMkJCwgXCJbXFxcXDpcXFxcQFxcXFwvXFxcXD9dXCIsIElQUklWQVRFJCQpLCBcImdcIiksXHJcbiAgICAgICAgICAgIE5PVF9GUkFHTUVOVDogbmV3IFJlZ0V4cChtZXJnZShcIlteXFxcXCVdXCIsIFVOUkVTRVJWRUQkJCwgU1VCX0RFTElNUyQkLCBcIltcXFxcOlxcXFxAXFxcXC9cXFxcP11cIiksIFwiZ1wiKSxcclxuICAgICAgICAgICAgRVNDQVBFOiBuZXcgUmVnRXhwKG1lcmdlKFwiW15dXCIsIFVOUkVTRVJWRUQkJCwgU1VCX0RFTElNUyQkKSwgXCJnXCIpLFxyXG4gICAgICAgICAgICBVTlJFU0VSVkVEOiBuZXcgUmVnRXhwKFVOUkVTRVJWRUQkJCwgXCJnXCIpLFxyXG4gICAgICAgICAgICBPVEhFUl9DSEFSUzogbmV3IFJlZ0V4cChtZXJnZShcIlteXFxcXCVdXCIsIFVOUkVTRVJWRUQkJCwgUkVTRVJWRUQkJCksIFwiZ1wiKSxcclxuICAgICAgICAgICAgUENUX0VOQ09ERUQ6IG5ldyBSZWdFeHAoUENUX0VOQ09ERUQkLCBcImdcIilcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgdmFyIFVSSV9QUk9UT0NPTCA9IGJ1aWxkRXhwcyhmYWxzZSksIElSSV9QUk9UT0NPTCA9IFVSSV9fSVJJX1NVUFBPUlQgPyBidWlsZEV4cHModHJ1ZSkgOiB1bmRlZmluZWQsIFVSSV9QQVJTRSA9IC9eKD86KFteOlxcLz8jXSspOik/KD86XFwvXFwvKCg/OihbXlxcLz8jQF0qKUApPyhbXlxcLz8jOl0qKSg/OlxcOihcXGQqKSk/KSk/KFtePyNdKikoPzpcXD8oW14jXSopKT8oPzojKCg/Oi58XFxuKSopKT8vaSwgUkRTMSA9IC9eXFwuXFwuP1xcLy8sIFJEUzIgPSAvXlxcL1xcLihcXC98JCkvLCBSRFMzID0gL15cXC9cXC5cXC4oXFwvfCQpLywgUkRTNCA9IC9eXFwuXFwuPyQvLCBSRFM1ID0gL15cXC8/KD86LnxcXG4pKj8oPz1cXC98JCkvLCBOT19NQVRDSF9JU19VTkRFRklORUQgPSAoXCJcIikubWF0Y2goLygpezB9LylbMV0gPT09IHVuZGVmaW5lZDtcclxuICAgIGZ1bmN0aW9uIHBjdEVuY0NoYXIoY2hyKSB7XHJcbiAgICAgICAgdmFyIGMgPSBjaHIuY2hhckNvZGVBdCgwKSwgZTtcclxuICAgICAgICBpZiAoYyA8IDE2KVxyXG4gICAgICAgICAgICBlID0gXCIlMFwiICsgYy50b1N0cmluZygxNikudG9VcHBlckNhc2UoKTtcclxuICAgICAgICBlbHNlIGlmIChjIDwgMTI4KVxyXG4gICAgICAgICAgICBlID0gXCIlXCIgKyBjLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICAgIGVsc2UgaWYgKGMgPCAyMDQ4KVxyXG4gICAgICAgICAgICBlID0gXCIlXCIgKyAoKGMgPj4gNikgfCAxOTIpLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpICsgXCIlXCIgKyAoKGMgJiA2MykgfCAxMjgpLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICAgIGVsc2VcclxuICAgICAgICAgICAgZSA9IFwiJVwiICsgKChjID4+IDEyKSB8IDIyNCkudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKCkgKyBcIiVcIiArICgoKGMgPj4gNikgJiA2MykgfCAxMjgpLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpICsgXCIlXCIgKyAoKGMgJiA2MykgfCAxMjgpLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpO1xyXG4gICAgICAgIHJldHVybiBlO1xyXG4gICAgfVxyXG4gICAgZnVuY3Rpb24gcGN0RGVjQ2hhcnMoc3RyKSB7XHJcbiAgICAgICAgdmFyIG5ld1N0ciA9IFwiXCIsIGkgPSAwLCBpbCA9IHN0ci5sZW5ndGgsIGMsIGMyLCBjMztcclxuICAgICAgICB3aGlsZSAoaSA8IGlsKSB7XHJcbiAgICAgICAgICAgIGMgPSBwYXJzZUludChzdHIuc3Vic3RyKGkgKyAxLCAyKSwgMTYpO1xyXG4gICAgICAgICAgICBpZiAoYyA8IDEyOCkge1xyXG4gICAgICAgICAgICAgICAgbmV3U3RyICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYyk7XHJcbiAgICAgICAgICAgICAgICBpICs9IDM7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSBpZiAoYyA+PSAxOTQgJiYgYyA8IDIyNCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKChpbCAtIGkpID49IDYpIHtcclxuICAgICAgICAgICAgICAgICAgICBjMiA9IHBhcnNlSW50KHN0ci5zdWJzdHIoaSArIDQsIDIpLCAxNik7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV3U3RyICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoKChjICYgMzEpIDw8IDYpIHwgKGMyICYgNjMpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIG5ld1N0ciArPSBzdHIuc3Vic3RyKGksIDYpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaSArPSA2O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2UgaWYgKGMgPj0gMjI0KSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoKGlsIC0gaSkgPj0gOSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGMyID0gcGFyc2VJbnQoc3RyLnN1YnN0cihpICsgNCwgMiksIDE2KTtcclxuICAgICAgICAgICAgICAgICAgICBjMyA9IHBhcnNlSW50KHN0ci5zdWJzdHIoaSArIDcsIDIpLCAxNik7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV3U3RyICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoKChjICYgMTUpIDw8IDEyKSB8ICgoYzIgJiA2MykgPDwgNikgfCAoYzMgJiA2MykpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV3U3RyICs9IHN0ci5zdWJzdHIoaSwgOSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpICs9IDk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXdTdHIgKz0gc3RyLnN1YnN0cihpLCAzKTtcclxuICAgICAgICAgICAgICAgIGkgKz0gMztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbmV3U3RyO1xyXG4gICAgfVxyXG4gICAgZnVuY3Rpb24gdHlwZU9mKG8pIHtcclxuICAgICAgICByZXR1cm4gbyA9PT0gdW5kZWZpbmVkID8gXCJ1bmRlZmluZWRcIiA6IChvID09PSBudWxsID8gXCJudWxsXCIgOiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobykuc3BsaXQoXCIgXCIpLnBvcCgpLnNwbGl0KFwiXVwiKS5zaGlmdCgpLnRvTG93ZXJDYXNlKCkpO1xyXG4gICAgfVxyXG4gICAgZnVuY3Rpb24gdG9VcHBlckNhc2Uoc3RyKSB7XHJcbiAgICAgICAgcmV0dXJuIHN0ci50b1VwcGVyQ2FzZSgpO1xyXG4gICAgfVxyXG4gICAgdmFyIFNDSEVNRVMgPSB7fTtcclxuICAgIGZ1bmN0aW9uIF9ub3JtYWxpemVDb21wb25lbnRFbmNvZGluZyhjb21wb25lbnRzLCBwcm90b2NvbCkge1xyXG4gICAgICAgIGZ1bmN0aW9uIGRlY29kZVVucmVzZXJ2ZWQoc3RyKSB7XHJcbiAgICAgICAgICAgIHZhciBkZWNTdHIgPSBwY3REZWNDaGFycyhzdHIpO1xyXG4gICAgICAgICAgICByZXR1cm4gKCFkZWNTdHIubWF0Y2gocHJvdG9jb2wuVU5SRVNFUlZFRCkgPyBzdHIgOiBkZWNTdHIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY29tcG9uZW50cy5zY2hlbWUpXHJcbiAgICAgICAgICAgIGNvbXBvbmVudHMuc2NoZW1lID0gU3RyaW5nKGNvbXBvbmVudHMuc2NoZW1lKS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UocHJvdG9jb2wuTk9UX1NDSEVNRSwgXCJcIik7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudHMudXNlcmluZm8gIT09IHVuZGVmaW5lZClcclxuICAgICAgICAgICAgY29tcG9uZW50cy51c2VyaW5mbyA9IFN0cmluZyhjb21wb25lbnRzLnVzZXJpbmZvKS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS5yZXBsYWNlKHByb3RvY29sLk5PVF9VU0VSSU5GTywgcGN0RW5jQ2hhcikucmVwbGFjZShwcm90b2NvbC5QQ1RfRU5DT0RFRCwgdG9VcHBlckNhc2UpO1xyXG4gICAgICAgIGlmIChjb21wb25lbnRzLmhvc3QgIT09IHVuZGVmaW5lZClcclxuICAgICAgICAgICAgY29tcG9uZW50cy5ob3N0ID0gU3RyaW5nKGNvbXBvbmVudHMuaG9zdCkucmVwbGFjZShwcm90b2NvbC5QQ1RfRU5DT0RFRCwgZGVjb2RlVW5yZXNlcnZlZCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKHByb3RvY29sLk5PVF9IT1NULCBwY3RFbmNDaGFyKS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCB0b1VwcGVyQ2FzZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudHMucGF0aCAhPT0gdW5kZWZpbmVkKVxyXG4gICAgICAgICAgICBjb21wb25lbnRzLnBhdGggPSBTdHJpbmcoY29tcG9uZW50cy5wYXRoKS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS5yZXBsYWNlKChjb21wb25lbnRzLnNjaGVtZSA/IHByb3RvY29sLk5PVF9QQVRIIDogcHJvdG9jb2wuTk9UX1BBVEhfTk9TQ0hFTUUpLCBwY3RFbmNDaGFyKS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCB0b1VwcGVyQ2FzZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudHMucXVlcnkgIT09IHVuZGVmaW5lZClcclxuICAgICAgICAgICAgY29tcG9uZW50cy5xdWVyeSA9IFN0cmluZyhjb21wb25lbnRzLnF1ZXJ5KS5yZXBsYWNlKHByb3RvY29sLlBDVF9FTkNPREVELCBkZWNvZGVVbnJlc2VydmVkKS5yZXBsYWNlKHByb3RvY29sLk5PVF9RVUVSWSwgcGN0RW5jQ2hhcikucmVwbGFjZShwcm90b2NvbC5QQ1RfRU5DT0RFRCwgdG9VcHBlckNhc2UpO1xyXG4gICAgICAgIGlmIChjb21wb25lbnRzLmZyYWdtZW50ICE9PSB1bmRlZmluZWQpXHJcbiAgICAgICAgICAgIGNvbXBvbmVudHMuZnJhZ21lbnQgPSBTdHJpbmcoY29tcG9uZW50cy5mcmFnbWVudCkucmVwbGFjZShwcm90b2NvbC5QQ1RfRU5DT0RFRCwgZGVjb2RlVW5yZXNlcnZlZCkucmVwbGFjZShwcm90b2NvbC5OT1RfRlJBR01FTlQsIHBjdEVuY0NoYXIpLnJlcGxhY2UocHJvdG9jb2wuUENUX0VOQ09ERUQsIHRvVXBwZXJDYXNlKTtcclxuICAgICAgICByZXR1cm4gY29tcG9uZW50cztcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIHBhcnNlKHVyaVN0cmluZywgb3B0aW9ucykge1xyXG4gICAgICAgIGlmIChvcHRpb25zID09PSB2b2lkIDApIHsgb3B0aW9ucyA9IHt9OyB9XHJcbiAgICAgICAgdmFyIHByb3RvY29sID0gKFVSSV9fSVJJX1NVUFBPUlQgJiYgb3B0aW9ucy5pcmkgIT09IGZhbHNlID8gSVJJX1BST1RPQ09MIDogVVJJX1BST1RPQ09MKSwgbWF0Y2hlcywgcGFyc2VFcnJvciA9IGZhbHNlLCBjb21wb25lbnRzID0ge30sIHNjaGVtZUhhbmRsZXI7XHJcbiAgICAgICAgaWYgKG9wdGlvbnMucmVmZXJlbmNlID09PSBcInN1ZmZpeFwiKVxyXG4gICAgICAgICAgICB1cmlTdHJpbmcgPSAob3B0aW9ucy5zY2hlbWUgPyBvcHRpb25zLnNjaGVtZSArIFwiOlwiIDogXCJcIikgKyBcIi8vXCIgKyB1cmlTdHJpbmc7XHJcbiAgICAgICAgaWYgKFVSSV9fVkFMSURBVEVfU1VQUE9SVCkge1xyXG4gICAgICAgICAgICBtYXRjaGVzID0gdXJpU3RyaW5nLm1hdGNoKHByb3RvY29sLlVSSV9SRUYpO1xyXG4gICAgICAgICAgICBpZiAobWF0Y2hlcykge1xyXG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoZXNbMV0pIHtcclxuICAgICAgICAgICAgICAgICAgICAvL2dlbmVyaWMgVVJJXHJcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2hlcyA9IG1hdGNoZXMuc2xpY2UoMSwgMTApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy9yZWxhdGl2ZSBVUklcclxuICAgICAgICAgICAgICAgICAgICBtYXRjaGVzID0gbWF0Y2hlcy5zbGljZSgxMCwgMTkpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghbWF0Y2hlcykge1xyXG4gICAgICAgICAgICAgICAgcGFyc2VFcnJvciA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW9wdGlvbnMudG9sZXJhbnQpXHJcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJVUkkgaXMgbm90IHN0cmljdGx5IHZhbGlkLlwiO1xyXG4gICAgICAgICAgICAgICAgbWF0Y2hlcyA9IHVyaVN0cmluZy5tYXRjaChVUklfUEFSU0UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICBtYXRjaGVzID0gdXJpU3RyaW5nLm1hdGNoKFVSSV9QQVJTRSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChtYXRjaGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChOT19NQVRDSF9JU19VTkRFRklORUQpIHtcclxuICAgICAgICAgICAgICAgIC8vc3RvcmUgZWFjaCBjb21wb25lbnRcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMuc2NoZW1lID0gbWF0Y2hlc1sxXTtcclxuICAgICAgICAgICAgICAgIC8vY29tcG9uZW50cy5hdXRob3JpdHkgPSBtYXRjaGVzWzJdO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy51c2VyaW5mbyA9IG1hdGNoZXNbM107XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLmhvc3QgPSBtYXRjaGVzWzRdO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5wb3J0ID0gcGFyc2VJbnQobWF0Y2hlc1s1XSwgMTApO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5wYXRoID0gbWF0Y2hlc1s2XSB8fCBcIlwiO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5xdWVyeSA9IG1hdGNoZXNbN107XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLmZyYWdtZW50ID0gbWF0Y2hlc1s4XTtcclxuICAgICAgICAgICAgICAgIC8vZml4IHBvcnQgbnVtYmVyXHJcbiAgICAgICAgICAgICAgICBpZiAoaXNOYU4oY29tcG9uZW50cy5wb3J0KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucG9ydCA9IG1hdGNoZXNbNV07XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvL3N0b3JlIGVhY2ggY29tcG9uZW50XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLnNjaGVtZSA9IG1hdGNoZXNbMV0gfHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgLy9jb21wb25lbnRzLmF1dGhvcml0eSA9ICh1cmlTdHJpbmcuaW5kZXhPZihcIi8vXCIpICE9PSAtMSA/IG1hdGNoZXNbMl0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy51c2VyaW5mbyA9ICh1cmlTdHJpbmcuaW5kZXhPZihcIkBcIikgIT09IC0xID8gbWF0Y2hlc1szXSA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLmhvc3QgPSAodXJpU3RyaW5nLmluZGV4T2YoXCIvL1wiKSAhPT0gLTEgPyBtYXRjaGVzWzRdIDogdW5kZWZpbmVkKTtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucG9ydCA9IHBhcnNlSW50KG1hdGNoZXNbNV0sIDEwKTtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucGF0aCA9IG1hdGNoZXNbNl0gfHwgXCJcIjtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucXVlcnkgPSAodXJpU3RyaW5nLmluZGV4T2YoXCI/XCIpICE9PSAtMSA/IG1hdGNoZXNbN10gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5mcmFnbWVudCA9ICh1cmlTdHJpbmcuaW5kZXhPZihcIiNcIikgIT09IC0xID8gbWF0Y2hlc1s4XSA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgICAgICAvL2ZpeCBwb3J0IG51bWJlclxyXG4gICAgICAgICAgICAgICAgaWYgKGlzTmFOKGNvbXBvbmVudHMucG9ydCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzLnBvcnQgPSAodXJpU3RyaW5nLm1hdGNoKC9cXC9cXC8oPzoufFxcbikqXFw6KD86XFwvfFxcP3xcXCN8JCkvKSA/IG1hdGNoZXNbNF0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vZGV0ZXJtaW5lIHJlZmVyZW5jZSB0eXBlXHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnRzLnNjaGVtZSA9PT0gdW5kZWZpbmVkICYmIGNvbXBvbmVudHMudXNlcmluZm8gPT09IHVuZGVmaW5lZCAmJiBjb21wb25lbnRzLmhvc3QgPT09IHVuZGVmaW5lZCAmJiBjb21wb25lbnRzLnBvcnQgPT09IHVuZGVmaW5lZCAmJiAhY29tcG9uZW50cy5wYXRoICYmIGNvbXBvbmVudHMucXVlcnkgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5yZWZlcmVuY2UgPSBcInNhbWUtZG9jdW1lbnRcIjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbHNlIGlmIChjb21wb25lbnRzLnNjaGVtZSA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLnJlZmVyZW5jZSA9IFwicmVsYXRpdmVcIjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbHNlIGlmIChjb21wb25lbnRzLmZyYWdtZW50ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucmVmZXJlbmNlID0gXCJhYnNvbHV0ZVwiO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5yZWZlcmVuY2UgPSBcInVyaVwiO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vY2hlY2sgZm9yIHJlZmVyZW5jZSBlcnJvcnNcclxuICAgICAgICAgICAgaWYgKG9wdGlvbnMucmVmZXJlbmNlICYmIG9wdGlvbnMucmVmZXJlbmNlICE9PSBcInN1ZmZpeFwiICYmIG9wdGlvbnMucmVmZXJlbmNlICE9PSBjb21wb25lbnRzLnJlZmVyZW5jZSkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJVUkkgaXMgbm90IGEgXCIgKyBvcHRpb25zLnJlZmVyZW5jZSArIFwiIHJlZmVyZW5jZS5cIjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAvL2ZpbmQgc2NoZW1lIGhhbmRsZXJcclxuICAgICAgICAgICAgc2NoZW1lSGFuZGxlciA9IFNDSEVNRVNbKG9wdGlvbnMuc2NoZW1lIHx8IGNvbXBvbmVudHMuc2NoZW1lIHx8IFwiXCIpLnRvTG93ZXJDYXNlKCldO1xyXG4gICAgICAgICAgICAvL2NoZWNrIGlmIHNjaGVtZSBjYW4ndCBoYW5kbGUgSVJJc1xyXG4gICAgICAgICAgICBpZiAoVVJJX19JUklfU1VQUE9SVCAmJiB0eXBlb2YgcHVueWNvZGUgIT09IFwidW5kZWZpbmVkXCIgJiYgIW9wdGlvbnMudW5pY29kZVN1cHBvcnQgJiYgKCFzY2hlbWVIYW5kbGVyIHx8ICFzY2hlbWVIYW5kbGVyLnVuaWNvZGVTdXBwb3J0KSkge1xyXG4gICAgICAgICAgICAgICAgLy9pZiBob3N0IGNvbXBvbmVudCBpcyBhIGRvbWFpbiBuYW1lXHJcbiAgICAgICAgICAgICAgICBpZiAoY29tcG9uZW50cy5ob3N0ICYmIChvcHRpb25zLmRvbWFpbkhvc3QgfHwgKHNjaGVtZUhhbmRsZXIgJiYgc2NoZW1lSGFuZGxlci5kb21haW5Ib3N0KSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAvL2NvbnZlcnQgVW5pY29kZSBJRE4gLT4gQVNDSUkgSUROXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50cy5ob3N0ID0gcHVueWNvZGUudG9BU0NJSShjb21wb25lbnRzLmhvc3QucmVwbGFjZShwcm90b2NvbC5QQ1RfRU5DT0RFRCwgcGN0RGVjQ2hhcnMpLnRvTG93ZXJDYXNlKCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzLmVycm9yID0gY29tcG9uZW50cy5lcnJvciB8fCBcIkhvc3QncyBkb21haW4gbmFtZSBjYW4gbm90IGJlIGNvbnZlcnRlZCB0byBBU0NJSSB2aWEgcHVueWNvZGU6IFwiICsgZTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAvL2NvbnZlcnQgSVJJIC0+IFVSSVxyXG4gICAgICAgICAgICAgICAgX25vcm1hbGl6ZUNvbXBvbmVudEVuY29kaW5nKGNvbXBvbmVudHMsIFVSSV9QUk9UT0NPTCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvL25vcm1hbGl6ZSBlbmNvZGluZ3NcclxuICAgICAgICAgICAgICAgIF9ub3JtYWxpemVDb21wb25lbnRFbmNvZGluZyhjb21wb25lbnRzLCBwcm90b2NvbCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgLy9wZXJmb3JtIHNjaGVtZSBzcGVjaWZpYyBwYXJzaW5nXHJcbiAgICAgICAgICAgIGlmIChzY2hlbWVIYW5kbGVyICYmIHNjaGVtZUhhbmRsZXIucGFyc2UpIHtcclxuICAgICAgICAgICAgICAgIHNjaGVtZUhhbmRsZXIucGFyc2UoY29tcG9uZW50cywgb3B0aW9ucyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgIHBhcnNlRXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICBjb21wb25lbnRzLmVycm9yID0gY29tcG9uZW50cy5lcnJvciB8fCBcIlVSSSBjYW4gbm90IGJlIHBhcnNlZC5cIjtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGNvbXBvbmVudHM7XHJcbiAgICB9XHJcbiAgICA7XHJcbiAgICBmdW5jdGlvbiBfcmVjb21wb3NlQXV0aG9yaXR5KGNvbXBvbmVudHMsIG9wdGlvbnMpIHtcclxuICAgICAgICB2YXIgdXJpVG9rZW5zID0gW107XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudHMudXNlcmluZm8gIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICB1cmlUb2tlbnMucHVzaChjb21wb25lbnRzLnVzZXJpbmZvKTtcclxuICAgICAgICAgICAgdXJpVG9rZW5zLnB1c2goXCJAXCIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY29tcG9uZW50cy5ob3N0ICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgdXJpVG9rZW5zLnB1c2goY29tcG9uZW50cy5ob3N0KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHR5cGVvZiBjb21wb25lbnRzLnBvcnQgPT09IFwibnVtYmVyXCIpIHtcclxuICAgICAgICAgICAgdXJpVG9rZW5zLnB1c2goXCI6XCIpO1xyXG4gICAgICAgICAgICB1cmlUb2tlbnMucHVzaChjb21wb25lbnRzLnBvcnQudG9TdHJpbmcoMTApKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVyaVRva2Vucy5sZW5ndGggPyB1cmlUb2tlbnMuam9pbihcIlwiKSA6IHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIHJlbW92ZURvdFNlZ21lbnRzKGlucHV0KSB7XHJcbiAgICAgICAgdmFyIG91dHB1dCA9IFtdLCBzO1xyXG4gICAgICAgIHdoaWxlIChpbnB1dC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgaWYgKGlucHV0Lm1hdGNoKFJEUzEpKSB7XHJcbiAgICAgICAgICAgICAgICBpbnB1dCA9IGlucHV0LnJlcGxhY2UoUkRTMSwgXCJcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSBpZiAoaW5wdXQubWF0Y2goUkRTMikpIHtcclxuICAgICAgICAgICAgICAgIGlucHV0ID0gaW5wdXQucmVwbGFjZShSRFMyLCBcIi9cIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSBpZiAoaW5wdXQubWF0Y2goUkRTMykpIHtcclxuICAgICAgICAgICAgICAgIGlucHV0ID0gaW5wdXQucmVwbGFjZShSRFMzLCBcIi9cIik7XHJcbiAgICAgICAgICAgICAgICBvdXRwdXQucG9wKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZSBpZiAoaW5wdXQgPT09IFwiLlwiIHx8IGlucHV0ID09PSBcIi4uXCIpIHtcclxuICAgICAgICAgICAgICAgIGlucHV0ID0gXCJcIjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHMgPSBpbnB1dC5tYXRjaChSRFM1KVswXTtcclxuICAgICAgICAgICAgICAgIGlucHV0ID0gaW5wdXQuc2xpY2Uocy5sZW5ndGgpO1xyXG4gICAgICAgICAgICAgICAgb3V0cHV0LnB1c2gocyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG91dHB1dC5qb2luKFwiXCIpO1xyXG4gICAgfVxyXG4gICAgO1xyXG4gICAgZnVuY3Rpb24gc2VyaWFsaXplKGNvbXBvbmVudHMsIG9wdGlvbnMpIHtcclxuICAgICAgICBpZiAob3B0aW9ucyA9PT0gdm9pZCAwKSB7IG9wdGlvbnMgPSB7fTsgfVxyXG4gICAgICAgIHZhciBwcm90b2NvbCA9IChVUklfX0lSSV9TVVBQT1JUICYmIG9wdGlvbnMuaXJpID8gSVJJX1BST1RPQ09MIDogVVJJX1BST1RPQ09MKSwgdXJpVG9rZW5zID0gW10sIHNjaGVtZUhhbmRsZXIsIGF1dGhvcml0eSwgcztcclxuICAgICAgICAvL2ZpbmQgc2NoZW1lIGhhbmRsZXJcclxuICAgICAgICBzY2hlbWVIYW5kbGVyID0gU0NIRU1FU1sob3B0aW9ucy5zY2hlbWUgfHwgY29tcG9uZW50cy5zY2hlbWUgfHwgXCJcIikudG9Mb3dlckNhc2UoKV07XHJcbiAgICAgICAgLy9wZXJmb3JtIHNjaGVtZSBzcGVjaWZpYyBzZXJpYWxpemF0aW9uXHJcbiAgICAgICAgaWYgKHNjaGVtZUhhbmRsZXIgJiYgc2NoZW1lSGFuZGxlci5zZXJpYWxpemUpXHJcbiAgICAgICAgICAgIHNjaGVtZUhhbmRsZXIuc2VyaWFsaXplKGNvbXBvbmVudHMsIG9wdGlvbnMpO1xyXG4gICAgICAgIC8vaWYgaG9zdCBjb21wb25lbnQgaXMgYSBkb21haW4gbmFtZVxyXG4gICAgICAgIGlmIChVUklfX0lSSV9TVVBQT1JUICYmIHR5cGVvZiBwdW55Y29kZSAhPT0gXCJ1bmRlZmluZWRcIiAmJiBjb21wb25lbnRzLmhvc3QgJiYgKG9wdGlvbnMuZG9tYWluSG9zdCB8fCAoc2NoZW1lSGFuZGxlciAmJiBzY2hlbWVIYW5kbGVyLmRvbWFpbkhvc3QpKSkge1xyXG4gICAgICAgICAgICAvL2NvbnZlcnQgSUROIHZpYSBwdW55Y29kZVxyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5ob3N0ID0gKCFvcHRpb25zLmlyaSA/IHB1bnljb2RlLnRvQVNDSUkoY29tcG9uZW50cy5ob3N0LnJlcGxhY2UocHJvdG9jb2wuUENUX0VOQ09ERUQsIHBjdERlY0NoYXJzKS50b0xvd2VyQ2FzZSgpKSA6IHB1bnljb2RlLnRvVW5pY29kZShjb21wb25lbnRzLmhvc3QpKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cy5lcnJvciA9IGNvbXBvbmVudHMuZXJyb3IgfHwgXCJIb3N0J3MgZG9tYWluIG5hbWUgY2FuIG5vdCBiZSBjb252ZXJ0ZWQgdG8gXCIgKyAoIW9wdGlvbnMuaXJpID8gXCJBU0NJSVwiIDogXCJVbmljb2RlXCIpICsgXCIgdmlhIHB1bnljb2RlOiBcIiArIGU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgLy9ub3JtYWxpemUgZW5jb2RpbmdcclxuICAgICAgICBfbm9ybWFsaXplQ29tcG9uZW50RW5jb2RpbmcoY29tcG9uZW50cywgcHJvdG9jb2wpO1xyXG4gICAgICAgIGlmIChvcHRpb25zLnJlZmVyZW5jZSAhPT0gXCJzdWZmaXhcIiAmJiBjb21wb25lbnRzLnNjaGVtZSkge1xyXG4gICAgICAgICAgICB1cmlUb2tlbnMucHVzaChjb21wb25lbnRzLnNjaGVtZSk7XHJcbiAgICAgICAgICAgIHVyaVRva2Vucy5wdXNoKFwiOlwiKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXV0aG9yaXR5ID0gX3JlY29tcG9zZUF1dGhvcml0eShjb21wb25lbnRzLCBvcHRpb25zKTtcclxuICAgICAgICBpZiAoYXV0aG9yaXR5ICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgaWYgKG9wdGlvbnMucmVmZXJlbmNlICE9PSBcInN1ZmZpeFwiKSB7XHJcbiAgICAgICAgICAgICAgICB1cmlUb2tlbnMucHVzaChcIi8vXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHVyaVRva2Vucy5wdXNoKGF1dGhvcml0eSk7XHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnRzLnBhdGggJiYgY29tcG9uZW50cy5wYXRoLmNoYXJBdCgwKSAhPT0gXCIvXCIpIHtcclxuICAgICAgICAgICAgICAgIHVyaVRva2Vucy5wdXNoKFwiL1wiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY29tcG9uZW50cy5wYXRoICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgcyA9IGNvbXBvbmVudHMucGF0aDtcclxuICAgICAgICAgICAgaWYgKCFvcHRpb25zLmFic29sdXRlUGF0aCAmJiAoIXNjaGVtZUhhbmRsZXIgfHwgIXNjaGVtZUhhbmRsZXIuYWJzb2x1dGVQYXRoKSkge1xyXG4gICAgICAgICAgICAgICAgcyA9IHJlbW92ZURvdFNlZ21lbnRzKHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChhdXRob3JpdHkgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgcyA9IHMucmVwbGFjZSgvXlxcL1xcLy8sIFwiLyUyRlwiKTsgLy9kb24ndCBhbGxvdyB0aGUgcGF0aCB0byBzdGFydCB3aXRoIFwiLy9cIlxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHVyaVRva2Vucy5wdXNoKHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY29tcG9uZW50cy5xdWVyeSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIHVyaVRva2Vucy5wdXNoKFwiP1wiKTtcclxuICAgICAgICAgICAgdXJpVG9rZW5zLnB1c2goY29tcG9uZW50cy5xdWVyeSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjb21wb25lbnRzLmZyYWdtZW50ICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgdXJpVG9rZW5zLnB1c2goXCIjXCIpO1xyXG4gICAgICAgICAgICB1cmlUb2tlbnMucHVzaChjb21wb25lbnRzLmZyYWdtZW50KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVyaVRva2Vucy5qb2luKCcnKTsgLy9tZXJnZSB0b2tlbnMgaW50byBhIHN0cmluZ1xyXG4gICAgfVxyXG4gICAgO1xyXG4gICAgZnVuY3Rpb24gcmVzb2x2ZUNvbXBvbmVudHMoYmFzZSwgcmVsYXRpdmUsIG9wdGlvbnMsIHNraXBOb3JtYWxpemF0aW9uKSB7XHJcbiAgICAgICAgaWYgKG9wdGlvbnMgPT09IHZvaWQgMCkgeyBvcHRpb25zID0ge307IH1cclxuICAgICAgICB2YXIgdGFyZ2V0ID0ge307XHJcbiAgICAgICAgaWYgKCFza2lwTm9ybWFsaXphdGlvbikge1xyXG4gICAgICAgICAgICBiYXNlID0gcGFyc2Uoc2VyaWFsaXplKGJhc2UsIG9wdGlvbnMpLCBvcHRpb25zKTsgLy9ub3JtYWxpemUgYmFzZSBjb21wb25lbnRzXHJcbiAgICAgICAgICAgIHJlbGF0aXZlID0gcGFyc2Uoc2VyaWFsaXplKHJlbGF0aXZlLCBvcHRpb25zKSwgb3B0aW9ucyk7IC8vbm9ybWFsaXplIHJlbGF0aXZlIGNvbXBvbmVudHNcclxuICAgICAgICB9XHJcbiAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XHJcbiAgICAgICAgaWYgKCFvcHRpb25zLnRvbGVyYW50ICYmIHJlbGF0aXZlLnNjaGVtZSkge1xyXG4gICAgICAgICAgICB0YXJnZXQuc2NoZW1lID0gcmVsYXRpdmUuc2NoZW1lO1xyXG4gICAgICAgICAgICAvL3RhcmdldC5hdXRob3JpdHkgPSByZWxhdGl2ZS5hdXRob3JpdHk7XHJcbiAgICAgICAgICAgIHRhcmdldC51c2VyaW5mbyA9IHJlbGF0aXZlLnVzZXJpbmZvO1xyXG4gICAgICAgICAgICB0YXJnZXQuaG9zdCA9IHJlbGF0aXZlLmhvc3Q7XHJcbiAgICAgICAgICAgIHRhcmdldC5wb3J0ID0gcmVsYXRpdmUucG9ydDtcclxuICAgICAgICAgICAgdGFyZ2V0LnBhdGggPSByZW1vdmVEb3RTZWdtZW50cyhyZWxhdGl2ZS5wYXRoKTtcclxuICAgICAgICAgICAgdGFyZ2V0LnF1ZXJ5ID0gcmVsYXRpdmUucXVlcnk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICBpZiAocmVsYXRpdmUudXNlcmluZm8gIT09IHVuZGVmaW5lZCB8fCByZWxhdGl2ZS5ob3N0ICE9PSB1bmRlZmluZWQgfHwgcmVsYXRpdmUucG9ydCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAvL3RhcmdldC5hdXRob3JpdHkgPSByZWxhdGl2ZS5hdXRob3JpdHk7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQudXNlcmluZm8gPSByZWxhdGl2ZS51c2VyaW5mbztcclxuICAgICAgICAgICAgICAgIHRhcmdldC5ob3N0ID0gcmVsYXRpdmUuaG9zdDtcclxuICAgICAgICAgICAgICAgIHRhcmdldC5wb3J0ID0gcmVsYXRpdmUucG9ydDtcclxuICAgICAgICAgICAgICAgIHRhcmdldC5wYXRoID0gcmVtb3ZlRG90U2VnbWVudHMocmVsYXRpdmUucGF0aCk7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQucXVlcnkgPSByZWxhdGl2ZS5xdWVyeTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmICghcmVsYXRpdmUucGF0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldC5wYXRoID0gYmFzZS5wYXRoO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWxhdGl2ZS5xdWVyeSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldC5xdWVyeSA9IHJlbGF0aXZlLnF1ZXJ5O1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LnF1ZXJ5ID0gYmFzZS5xdWVyeTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocmVsYXRpdmUucGF0aC5jaGFyQXQoMCkgPT09IFwiL1wiKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldC5wYXRoID0gcmVtb3ZlRG90U2VnbWVudHMocmVsYXRpdmUucGF0aCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoKGJhc2UudXNlcmluZm8gIT09IHVuZGVmaW5lZCB8fCBiYXNlLmhvc3QgIT09IHVuZGVmaW5lZCB8fCBiYXNlLnBvcnQgIT09IHVuZGVmaW5lZCkgJiYgIWJhc2UucGF0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LnBhdGggPSBcIi9cIiArIHJlbGF0aXZlLnBhdGg7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgZWxzZSBpZiAoIWJhc2UucGF0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LnBhdGggPSByZWxhdGl2ZS5wYXRoO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LnBhdGggPSBiYXNlLnBhdGguc2xpY2UoMCwgYmFzZS5wYXRoLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpICsgcmVsYXRpdmUucGF0aDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQucGF0aCA9IHJlbW92ZURvdFNlZ21lbnRzKHRhcmdldC5wYXRoKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LnF1ZXJ5ID0gcmVsYXRpdmUucXVlcnk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAvL3RhcmdldC5hdXRob3JpdHkgPSBiYXNlLmF1dGhvcml0eTtcclxuICAgICAgICAgICAgICAgIHRhcmdldC51c2VyaW5mbyA9IGJhc2UudXNlcmluZm87XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQuaG9zdCA9IGJhc2UuaG9zdDtcclxuICAgICAgICAgICAgICAgIHRhcmdldC5wb3J0ID0gYmFzZS5wb3J0O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRhcmdldC5zY2hlbWUgPSBiYXNlLnNjaGVtZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGFyZ2V0LmZyYWdtZW50ID0gcmVsYXRpdmUuZnJhZ21lbnQ7XHJcbiAgICAgICAgcmV0dXJuIHRhcmdldDtcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIHJlc29sdmUoYmFzZVVSSSwgcmVsYXRpdmVVUkksIG9wdGlvbnMpIHtcclxuICAgICAgICByZXR1cm4gc2VyaWFsaXplKHJlc29sdmVDb21wb25lbnRzKHBhcnNlKGJhc2VVUkksIG9wdGlvbnMpLCBwYXJzZShyZWxhdGl2ZVVSSSwgb3B0aW9ucyksIG9wdGlvbnMsIHRydWUpLCBvcHRpb25zKTtcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIG5vcm1hbGl6ZSh1cmksIG9wdGlvbnMpIHtcclxuICAgICAgICBpZiAodHlwZW9mIHVyaSA9PT0gXCJzdHJpbmdcIikge1xyXG4gICAgICAgICAgICB1cmkgPSBzZXJpYWxpemUocGFyc2UodXJpLCBvcHRpb25zKSwgb3B0aW9ucyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2UgaWYgKHR5cGVPZih1cmkpID09PSBcIm9iamVjdFwiKSB7XHJcbiAgICAgICAgICAgIHVyaSA9IHBhcnNlKHNlcmlhbGl6ZSh1cmksIG9wdGlvbnMpLCBvcHRpb25zKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVyaTtcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIGVxdWFsKHVyaUEsIHVyaUIsIG9wdGlvbnMpIHtcclxuICAgICAgICBpZiAodHlwZW9mIHVyaUEgPT09IFwic3RyaW5nXCIpIHtcclxuICAgICAgICAgICAgdXJpQSA9IHNlcmlhbGl6ZShwYXJzZSh1cmlBLCBvcHRpb25zKSwgb3B0aW9ucyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2UgaWYgKHR5cGVPZih1cmlBKSA9PT0gXCJvYmplY3RcIikge1xyXG4gICAgICAgICAgICB1cmlBID0gc2VyaWFsaXplKHVyaUEsIG9wdGlvbnMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodHlwZW9mIHVyaUIgPT09IFwic3RyaW5nXCIpIHtcclxuICAgICAgICAgICAgdXJpQiA9IHNlcmlhbGl6ZShwYXJzZSh1cmlCLCBvcHRpb25zKSwgb3B0aW9ucyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2UgaWYgKHR5cGVPZih1cmlCKSA9PT0gXCJvYmplY3RcIikge1xyXG4gICAgICAgICAgICB1cmlCID0gc2VyaWFsaXplKHVyaUIsIG9wdGlvbnMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdXJpQSA9PT0gdXJpQjtcclxuICAgIH1cclxuICAgIDtcclxuICAgIGZ1bmN0aW9uIGVzY2FwZUNvbXBvbmVudChzdHIsIG9wdGlvbnMpIHtcclxuICAgICAgICByZXR1cm4gc3RyICYmIHN0ci50b1N0cmluZygpLnJlcGxhY2UoKCFVUklfX0lSSV9TVVBQT1JUIHx8ICFvcHRpb25zIHx8ICFvcHRpb25zLmlyaSA/IFVSSV9QUk9UT0NPTC5FU0NBUEUgOiBJUklfUFJPVE9DT0wuRVNDQVBFKSwgcGN0RW5jQ2hhcik7XHJcbiAgICB9XHJcbiAgICA7XHJcbiAgICBmdW5jdGlvbiB1bmVzY2FwZUNvbXBvbmVudChzdHIsIG9wdGlvbnMpIHtcclxuICAgICAgICByZXR1cm4gc3RyICYmIHN0ci50b1N0cmluZygpLnJlcGxhY2UoKCFVUklfX0lSSV9TVVBQT1JUIHx8ICFvcHRpb25zIHx8ICFvcHRpb25zLmlyaSA/IFVSSV9QUk9UT0NPTC5QQ1RfRU5DT0RFRCA6IElSSV9QUk9UT0NPTC5QQ1RfRU5DT0RFRCksIHBjdERlY0NoYXJzKTtcclxuICAgIH1cclxuICAgIDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgSVJJX1NVUFBPUlQ6IFVSSV9fSVJJX1NVUFBPUlQsXHJcbiAgICAgICAgVkFMSURBVEVfU1VQUE9SVDogVVJJX19WQUxJREFURV9TVVBQT1JULFxyXG4gICAgICAgIHBjdEVuY0NoYXI6IHBjdEVuY0NoYXIsXHJcbiAgICAgICAgcGN0RGVjQ2hhcnM6IHBjdERlY0NoYXJzLFxyXG4gICAgICAgIFNDSEVNRVM6IFNDSEVNRVMsXHJcbiAgICAgICAgcGFyc2U6IHBhcnNlLFxyXG4gICAgICAgIF9yZWNvbXBvc2VBdXRob3JpdHk6IF9yZWNvbXBvc2VBdXRob3JpdHksXHJcbiAgICAgICAgcmVtb3ZlRG90U2VnbWVudHM6IHJlbW92ZURvdFNlZ21lbnRzLFxyXG4gICAgICAgIHNlcmlhbGl6ZTogc2VyaWFsaXplLFxyXG4gICAgICAgIHJlc29sdmVDb21wb25lbnRzOiByZXNvbHZlQ29tcG9uZW50cyxcclxuICAgICAgICByZXNvbHZlOiByZXNvbHZlLFxyXG4gICAgICAgIG5vcm1hbGl6ZTogbm9ybWFsaXplLFxyXG4gICAgICAgIGVxdWFsOiBlcXVhbCxcclxuICAgICAgICBlc2NhcGVDb21wb25lbnQ6IGVzY2FwZUNvbXBvbmVudCxcclxuICAgICAgICB1bmVzY2FwZUNvbXBvbmVudDogdW5lc2NhcGVDb21wb25lbnRcclxuICAgIH07XHJcbn0pKCk7XHJcbmlmICghQ09NUElMRUQgJiYgdHlwZW9mIG1vZHVsZSAhPT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgcmVxdWlyZSA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICB2YXIgcHVueWNvZGUgPSByZXF1aXJlKFwiLi9wdW55Y29kZVwiKTtcclxuICAgIG1vZHVsZS5leHBvcnRzID0gVVJJO1xyXG4gICAgcmVxdWlyZShcIi4vc2NoZW1lc1wiKTtcclxufVxyXG4iXX0=
