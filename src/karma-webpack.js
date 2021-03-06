/* eslint-disable
  max-len,
  no-console,
  func-style,
*/

const os = require('os');
const path = require('path');

const _ = require('lodash');
const async = require('async');
const webpack = require('webpack');
const WebpackDevMiddleware = require('webpack-dev-middleware');
const SingleEntryDependency = require('webpack/lib/dependencies/SingleEntryDependency');

let blocked = [];
let isBlocked = false;

const escapeRegExp = function(str) {
  // See details here https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex
  return str.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
};

function invalidate(middleware) {
  if (middleware.context.watching) {
    return middleware.context.watching.invalidate();
  }

  return middleware.invalidate();
}

function Plugin(
  /* config.webpack */ webpackOptions,
  /* config.webpackServer */ webpackServerOptions,
  /* config.webpackMiddleware */ webpackMiddlewareOptions,
  /* config.basePath */ basePath,
  /* config.files */ files,
  /* config.frameworks */ frameworks,
  /* config.singleRun */ singleRun,
  customFileHandlers,
  emitter
) {
  webpackOptions = _.clone(webpackOptions) || {};
  webpackMiddlewareOptions =
    _.clone(webpackMiddlewareOptions || webpackServerOptions) || {};

  const applyOptions = Array.isArray(webpackOptions)
    ? webpackOptions
    : [webpackOptions];
  const includeIndex = applyOptions.length > 1;

  applyOptions.forEach((webpackOptions, index) => {
    // The webpack tier owns the watch behavior so we want to force it in the config
    webpackOptions.watch = !singleRun;

    // Webpack 2.1.0-beta.7+ will throw in error if both entry and plugins are not specified in options
    // https://github.com/webpack/webpack/commit/b3bc5427969e15fd3663d9a1c57dbd1eb2c94805
    if (!webpackOptions.entry) {
      webpackOptions.entry = function() {
        return {};
      };
    }

    if (!webpackOptions.output) {
      webpackOptions.output = {};
    }

    // When using an array, even of length 1, we want to include the index value for the build.
    // This is due to the way that the dev server exposes commonPath for build output.
    const indexPath = includeIndex ? `${index}/` : '';
    const publicPath = indexPath !== '' ? `${indexPath}/` : '';

    // Must have the common _karma_webpack_ prefix on path here to avoid
    // https://github.com/webpack/webpack/issues/645
    webpackOptions.output.path = path.join(
      os.tmpdir(),
      '_karma_webpack_',
      indexPath,
      '/'
    );
    webpackOptions.output.publicPath = path.join(
      os.tmpdir(),
      '_karma_webpack_',
      publicPath,
      '/'
    );

    if (includeIndex) {
      webpackOptions.output.jsonpFunction = `webpackJsonp${index}`;
    }

    if (!webpackOptions.output.filename) {
      webpackOptions.output.filename = '[name]';
    }

    if (!webpackOptions.output.chunkFilename) {
      webpackOptions.output.chunkFilename = '[id].bundle.js';
    }

    // For webpack 4+, optimization.splitChunks and optimization.runtimeChunk must be false.
    // Otherwise it hangs at 'Compiled successfully'
    if (webpackOptions.optimization) {
      webpackOptions.optimization.splitChunks = false;
      webpackOptions.optimization.runtimeChunk = false;
    }
  });

  this.emitter = emitter;
  this.wrapMocha = frameworks.indexOf('mocha') >= 0 && includeIndex;
  this.optionsCount = applyOptions.length;
  this.files = [];
  this.basePath = basePath;
  this.waiting = [];
  this.plugin = { name: 'KarmaWebpack' };

  let compiler;

  try {
    compiler = webpack(webpackOptions);
  } catch (e) {
    console.error(e.stack || e);
    if (e.details) {
      console.error(e.details);
    }
    throw e;
  }

  const applyPlugins = compiler.compilers || [compiler];

  applyPlugins.forEach(function(compiler) {
    compiler.hooks.thisCompilation.tap(this.plugin, (compilation, params) => {
      compilation.dependencyFactories.set(
        SingleEntryDependency,
        params.normalModuleFactory
      );
    });
    compiler.hooks.make.tapAsync(this.plugin, this.make.bind(this));
  }, this);

  function handler(callback) {
    isBlocked = true;

    if (typeof callback === 'function') {
      callback(null);
    }
  }

  compiler.hooks.invalid.tap(this.plugin, () => handler());
  compiler.hooks.watchRun.tap(this.plugin, () => handler());
  compiler.hooks.run.tapAsync(this.plugin, (_, callback) => handler(callback));

  function done(stats) {
    const applyStats = Array.isArray(stats.stats) ? stats.stats : [stats];
    const assets = [];
    let noAssets = false;

    applyStats.forEach((stats) => {
      stats = stats.toJson();

      assets.push(...stats.assets);
      if (stats.assets.length === 0) {
        noAssets = true;
      }
    });

    if (!this.waiting || this.waiting.length === 0) {
      this.notifyKarmaAboutChanges();
    }

    if (this.waiting && !noAssets) {
      const w = this.waiting;

      this.waiting = null;
      w.forEach((cb) => {
        cb();
      });
    }

    isBlocked = false;
    for (let i = 0; i < blocked.length; i++) {
      blocked[i]();
    }
    blocked = [];
  }

  function invalid() {
    if (!this.waiting) {
      this.waiting = [];
    }
  }

  compiler.hooks.done.tap(this.plugin, done.bind(this));
  compiler.hooks.invalid.tap(this.plugin, invalid.bind(this));

  webpackMiddlewareOptions.publicPath = path.join(
    os.tmpdir(),
    '_karma_webpack_',
    '/'
  );
  const middleware = new WebpackDevMiddleware(
    compiler,
    webpackMiddlewareOptions
  );
  this.middleware = middleware;

  customFileHandlers.push({
    urlRegex: new RegExp(
      `^${escapeRegExp(webpackMiddlewareOptions.publicPath)}.*`
    ),
    handler(req, res) {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      });
    },
  });

  emitter.on('exit', (done) => {
    middleware.close();
    done();
  });
}

Plugin.prototype.notifyKarmaAboutChanges = function() {
  // Force a rebuild
  this.emitter.refreshFiles();
};

Plugin.prototype.addFile = function(entry) {
  if (this.files.indexOf(entry) >= 0) {
    return false;
  }

  this.files.push(entry);

  return true;
};

Plugin.prototype.make = function(compilation, callback) {
  async.forEach(
    this.files.slice(),
    (file, callback) => {
      let entry = file;

      if (this.wrapMocha) {
        entry = `${require.resolve('./mocha-env-loader')}?name=${
          compilation.name
        }!${entry}`;
      }

      const dep = new SingleEntryDependency(entry);

      compilation.addEntry(
        '',
        dep,
        path.relative(this.basePath, file).replace(/\\/g, '/'),
        (err) => {
          // If the module fails because of an File not found error, remove the test file
          if (
            dep.module &&
            dep.module.error &&
            dep.module.error.error &&
            dep.module.error.error.code === 'ENOENT'
          ) {
            this.files = this.files.filter((f) => file !== f);
            invalidate(this.middleware);
          }
          callback(err);
        }
      );
    },
    callback
  );
};

Plugin.prototype.readFile = function(file, callback) {
  const middleware = this.middleware;
  const optionsCount = this.optionsCount;

  const doRead = function() {
    if (optionsCount > 1) {
      async.times(
        optionsCount,
        (idx, callback) => {
          middleware.fileSystem.readFile(
            path.join(
              os.tmpdir(),
              '_karma_webpack_',
              String(idx),
              file.replace(/\\/g, '/')
            ),
            callback
          );
        },
        (err, contents) => {
          if (err) {
            return callback(err);
          }

          contents = contents.reduce((arr, x) => {
            if (!arr) {
              return [x];
            }

            arr.push(new Buffer('\n'), x);

            return arr;
          }, null);

          return callback(null, Buffer.concat(contents));
        }
      );
    } else {
      try {
        const fileContents = middleware.fileSystem.readFileSync(
          path.join(os.tmpdir(), '_karma_webpack_', file.replace(/\\/g, '/'))
        );

        callback(null, fileContents);
      } catch (e) {
        // If this is an error from `readFileSync` method, wait for the next tick.
        // Credit #69 @mewdriller
        if (e.code === 'ENOENT') {
          // eslint-disable-line quotes
          this.waiting = [
            process.nextTick.bind(
              process,
              this.readFile.bind(this, file, callback)
            ),
          ];

          // throw otherwise
        } else {
          callback(e);
        }
      }
    }
  }.bind(this);

  if (!this.waiting) {
    doRead();
  } else {
    // Retry to read once a build is finished
    // do it on process.nextTick to catch changes while building
    this.waiting.push(
      process.nextTick.bind(process, this.readFile.bind(this, file, callback))
    );
  }
};

function createPreprocesor(/* config.basePath */ basePath, webpackPlugin) {
  return function(content, file, done) {
    if (webpackPlugin.addFile(file.originalPath)) {
      // recompile as we have an asset that we have not seen before
      invalidate(webpackPlugin.middleware);
    }

    // read blocks until bundle is done
    webpackPlugin.readFile(
      path.relative(basePath, file.originalPath),
      (err, content) => {
        if (err) {
          throw err;
        }

        done(err, content && content.toString());
      }
    );
  };
}

function createWebpackBlocker() {
  return function(request, response, next) {
    if (isBlocked) {
      blocked.push(next);
    } else {
      next();
    }
  };
}

module.exports = {
  webpackPlugin: ['type', Plugin],
  'preprocessor:webpack': ['factory', createPreprocesor],
  'middleware:webpackBlocker': ['factory', createWebpackBlocker],
};
