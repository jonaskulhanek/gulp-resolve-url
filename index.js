/*
 * MIT License http://opensource.org/licenses/MIT
 * Author: Jonas Kulhanek @jonaskulhanek
 */
'use strict';

var path = require('path'),
  fs = require('fs'),
  through = require('through2'),
  rework = require('rework'),
  log = require('fancy-log'),
  visit = require('rework-visit'),
  convert = require('convert-source-map'),
  camelcase = require('camelcase'),
  defaults = require('lodash.defaults'),
  applySourceMap = require('vinyl-sourcemaps-apply'),
  SourceMapConsumer = require('source-map').SourceMapConsumer;

var findFile = require('./lib/find-file'),
  absoluteToRelative = require('./lib/sources-absolute-to-relative'),
  adjustSourceMap    = require('adjust-sourcemap-loader/lib/process');

var PACKAGE_NAME = require('./package.json').name;

/**
 * A gulp plugin that resolves absolute url() paths relative to their original source file.
 * Requires source-maps to do any meaningful work.
 * @param {object} config Options
 */
function resolveUrl(config) {
  return through.obj(function (file, encoding, cb) {

    if (!file.sourceMap) {
      handleException('Source maps are not initialized!');
      cb();
      return;
    }

    var sourceMap = file.sourceMap;
    var options = defaults(config || {}, {
      absolute: false,
      fail: true,
      silent: false,
      keepQuery: false,
      attempts: 0,
      debug: false,
      root: null,
      includeRoot: false
    });

    var filePath = path.dirname(file.path);

    var content = file.contents.toString();

    // validate root directory
    var resolvedRoot = (typeof options.root === 'string') && path.resolve(options.root) || undefined,
      isValidRoot = resolvedRoot && fs.existsSync(resolvedRoot);
    if (options.root && !isValidRoot) {
      handleException('"root" option does not resolve to a valid path');
      cb();
      return;
    }

    // incoming source-map
    var sourceMapConsumer, contentWithMap, sourceRoot;

    // support non-standard string encoded source-map (per less-loader)
    if (typeof sourceMap === 'string') {
      try {
        sourceMap = JSON.parse(sourceMap);
      } catch (exception) {
        return handleException('source-map error', 'cannot parse source-map string (from less-loader?)');
      }
    }

    

    // Make source map absolute
    var absSourceMap = sourceMap;
    absSourceMap.sources = absSourceMap.sources.map(x=>path.join(file.base, x));

    // Note the current sourceRoot before it is removed
    //  later when we go back to relative paths, we need to add it again
    sourceRoot = sourceMap.sourceRoot;

    // prepare the adjusted sass source-map for later look-ups
    sourceMapConsumer = new SourceMapConsumer(absSourceMap);

    // embed source-map in css for rework-css to use
    contentWithMap = content + convert.fromObject(absSourceMap).toComment({
      multiline: true
    });

    // process
    //  rework-css will throw on css syntax errors
    var reworked;
   // try {
      reworked = rework(contentWithMap, {
          source: file.path
        })
        .use(reworkPlugin)
        .toString({
          sourcemap: true,
          sourcemapAsObject: true
        });/*{
          sourcemap: sourceMap,
          sourcemapAsObject: sourceMap
        });*/
      //}

    // complete with source-map
    // source-map sources seem to be relative to the file being processed
    absoluteToRelative(reworked.map.sources, path.resolve(filePath, sourceRoot || '.'));
    // Set source root again
     reworked.map.sourceRoot = sourceRoot;

    var nfile = file.clone({contents: false});
    nfile.sourceMap = file.sourceMap;
    file = nfile;
    // need to use callback when there are multiple arguments
    file.contents = new Buffer(reworked.code);
    file.sourceMap = reworked.map;

    // Pushed output file
    this.push(file);
    cb();
    return;


    /**
     * Push an error for the given exception and return the original content.
     * @param {string} label Summary of the error
     * @param {string|Error} [exception] Optional extended error details
     * @returns {string} The original CSS content
     */
    function handleException(label, exception) {
      var rest = (typeof exception === 'string') ? [exception] :
        (exception instanceof Error) ? [exception.message, exception.stack.split('\n')[1].trim()] : [];
      var message = '  resolve-url-loader cannot operate: ' + [label].concat(rest).filter(Boolean).join('\n  ');
      if (options.fail) {
        log.error("gulp-resolve-url: " + message);
        throw message;
      } else if (!options.silent) {
        log.warn("gulp-resolve-url: " + message);
      }
    }

    function stripDriveName(name){
      if(name.indexOf("/")){
        name = name.substr(name.indexOf("/"));
      }

      return name;
    }

    /**
     * Plugin for css rework that follows SASS transpilation
     * @param {object} stylesheet AST for the CSS output from SASS
     */
    function reworkPlugin(stylesheet) {
      var URL_STATEMENT_REGEX = /(url\s*\()\s*(?:(['"])((?:(?!\2).)*)(\2)|([^'"](?:(?!\)).)*[^'"]))\s*(\))/g;

      // visit each node (selector) in the stylesheet recursively using the official utility method
      //  each node may have multiple declarations
      visit(stylesheet, function visitor(declarations) {
        if (declarations) {
          declarations
            .forEach(eachDeclaration);
        }
      });

      /**
       * Process a declaration from the syntax tree.
       * @param declaration
       */
      function eachDeclaration(declaration) {
        var isValid = declaration.value && (declaration.value.indexOf('url') >= 0),
          directory;
        if (isValid) {
          // reverse the original source-map to find the original sass file
          var startPosApparent = declaration.position.start,
            startPosOriginal = sourceMapConsumer && sourceMapConsumer.originalPositionFor(startPosApparent);

          // we require a valid directory for the specified file
          directory = startPosOriginal && startPosOriginal.source && path.dirname(startPosOriginal.source);
          if (directory) {
            // allow multiple url() values in the declaration
            //  split by url statements and process the content
            //  additional capture groups are needed to match quotations correctly
            //  escaped quotations are not considered
            declaration.value = declaration.value
              .split(URL_STATEMENT_REGEX)
              .map(eachSplitOrGroup)
              .join('');
          
          }

          // source-map present but invalid entry
          else if (sourceMapConsumer) {
            throw new Error('source-map information is not available at url() declaration');
          }
        }

        /**
         * Encode the content portion of <code>url()</code> statements.
         * There are 4 capture groups in the split making every 5th unmatched.
         * @param {string} token A single split item
         * @param i The index of the item in the split
         * @returns {string} Every 3 or 5 items is an encoded url everything else is as is
         */
        function eachSplitOrGroup(token, i) {
          var BACKSLASH_REGEX = /\\/g;

          // we can get groups as undefined under certain match circumstances
          var initialised = token || '';

          // the content of the url() statement is either in group 3 or group 5
          var mod = i % 7;
          if ((mod === 3) || (mod === 5)) {
            // split into uri and query/hash and then find the absolute path to the uri
            var split = initialised.split(/([?#])/g),
              uri = split[0],
              absolute = uri && findFile(options).absolute(directory, uri, resolvedRoot),
              query = options.keepQuery ? split.slice(1).join('') : '';

            // use the absolute path (or default to initialised)
            if (options.absolute) {
              return absolute && absolute.replace(BACKSLASH_REGEX, '/').concat(query) || initialised;
            }
            // module relative path (or default to initialised)
            else {
              var relative     = absolute && path.relative(filePath, absolute);
                //  rootRelative = relative && loaderUtils.urlToRequest(relative, '~');
              return (relative) ? relative.replace(BACKSLASH_REGEX, '/').concat(query) : initialised;
            }
          }
          // everything else, including parentheses and quotation (where present) and media statements
          else {
            return initialised;
          }
        }
      }
    }
  });
}

module.exports = resolveUrl;