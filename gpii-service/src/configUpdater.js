/* Updates files from a remote server.
 *
 * Automatic updates are defined in the config file, under the `autoUpdate` block. Each file has a corresponding
 * url, from where the file is downloaded.
 *
 * Copyright 2019 Raising the Floor - International
 *
 * Licensed under the New BSD license. You may not use this file except in
 * compliance with this License.
 *
 * The R&D leading to these results received funding from the
 * Department of Education - Grant H421A150005 (GPII-APCP). However,
 * these results do not necessarily represent the policy of the
 * Department of Education, and you should not assume endorsement by the
 * Federal Government.
 *
 * You may obtain a copy of the License at
 * https://github.com/GPII/universal/blob/master/LICENSE.txt
 */

"use strict";

var service = require("./service.js"),
    fs = require("fs"),
    os = require("os"),
    path = require("path"),
    crypto = require("crypto"),
    JSON5 = require("json5"),
    mkdirp = require("mkdirp"),
    request = require("request");

var configUpdater = {};
module.exports = configUpdater;

/**
 * Configuration for the config auto update.
 * @typedef {Object} AutoUpdateConfig
 * @property {Boolean} enabled `true` to enable automatic config updates.
 * @property {String} lastUpdatesFile The path to the last updates file.
 * @property {Array<AutoUpdateFile>} files The files to update.
 */
/**
 * @typedef {Object} AutoUpdateFile
 * @property {String} url The address from which the file will be downloaded.
 * @property {String} path The local file to update.
 * @property {Boolean} always `true` to always fetch the file.
 * @property {Boolean} isJSON `true` if this file is a JSON (or JSON5) file.
 */

/**
 * The last-updates.json5 file. Contains information about the last update of each file.
 * @typedef {Object} LastUpdatesFile
 * @property String lastCheck ISO-8601 Timestamp of when the last check for updates occurred (only written).
 * @property {Object<String,LastUpdate>} files Information about the last update of each local file.
 */
/**
 * A file entry in the last-updates.json5 file.
 * @typedef {Object} LastUpdate
 * @property {String} etag The ETag header from the last successful download.
 * @property {String} date The date of the last successful download.
 * @property {String} previous The filename of the previous version.
 */

/**
 * Loads the last update journal (usually %ProgramData%\Morphic\last-updates.json5).
 *
 * @param {String} path [optional] The path to the file.
 * @return {Promise<LastUpdatesFile>} Resolves when loaded, or with an empty object if the file isn't found.
 */
configUpdater.loadLastUpdates = function (path) {
    return new Promise(function (resolve) {
        if (!path) {
            path = service.config.autoUpdate.lastUpdatesFile;
        }
        fs.readFile(path, "utf8", function (err, content) {
            var result;
            if (err) {
                service.log("Error loading last updates file ", path, err);
            } else {
                try {
                    result = JSON5.parse(content);
                } catch (e) {
                    service.log("Error parsing last updates file ", path, err);
                }
            }
            if (!result) {
                result = {
                    files: {}
                };
            }
            resolve(result);
        });
    });
};

/**
 * Saves the last update journal (usually %ProgramData%\Morphic\last-updates.json5).
 *
 * @param {LastUpdatesFile} lastUpdates The last updates data
 * @param {String} path [optional] The path to the file.
 * @return {Promise} Resolves when saved.
 */
configUpdater.saveLastUpdates = function (lastUpdates, path) {
    return new Promise(function (resolve, reject) {
        if (!path) {
            path = service.config.autoUpdate.lastUpdatesFile;
        }

        var saveData = Object.assign({}, lastUpdates);
        saveData.lastCheck = new Date().toISOString();

        var content = "// This file is automatically generated, and will be over-written.\n" + JSON.stringify(saveData);
        fs.writeFile(path, content, function (err) {
            if (err) {
                service.logWarn("Error saving last updates file ", path, err);
                reject({
                    isError: true,
                    err: err,
                    path: path
                });
            } else {
                resolve();
            }
        });
    });
};

/**
 * Updates all of the files in the auto update configuration (config.autoUpdate).
 * @return {Promise<unknown>} Resolves when complete (even if some fail).
 */
configUpdater.updateAll = function () {
    service.logImportant("Checking for configuration updates");
    return configUpdater.loadLastUpdates().then(function (lastUpdates) {
        if (!lastUpdates.files) {
            lastUpdates.files = {};
        }

        var promises = service.config.autoUpdate.files.map(function (file) {
            var lastUpdate = lastUpdates.files[file.path] || {};

            return configUpdater.updateFile(file, lastUpdate)["catch"](function (err) {
                service.logWarn("updateFile error", err);
            }).then(function (newLastUpdate) {
                if (newLastUpdate) {
                    lastUpdates.files[file.path] = newLastUpdate;
                }
            });
        });

        return Promise.all(promises).then(function () {
            configUpdater.saveLastUpdates(lastUpdates);
        });
    });
};

/**
 * Updates a config file.
 *
 * The file copy is only performed if the new content doesn't match the current.
 *
 * @param {AutoUpdateFile} update Details about the file update.
 * @param {LastUpdate} lastUpdate Information on the last update.
 * @return {Promise<LastUpdate>} Resolves when complete.
 */
configUpdater.updateFile = function (update, lastUpdate) {
    var togo = Object.assign({}, lastUpdate);
    var downloadHash, localHash;

    var url = configUpdater.expand(update.url, service.getSecrets());
    if (url) {
        var downloadOptions;
        var hashPromise;
        if (fs.existsSync(update.path)) {
            // Hash the existing file.
            hashPromise = configUpdater.hashFile(update.path, "sha512")["catch"](function (err) {
                service.log("updateFile: hash failed", err);
            }).then(function (hash) {
                localHash = hash;
            });

            if (!update.always) {
                // Ask the server to only send the file if it's newer.
                downloadOptions = {
                    date: lastUpdate.date,
                    etag: lastUpdate.etag
                };
            }
        }

        // Download the file.
        var tempFile = path.join(os.tmpdir(), "morphic-update." + Math.random());
        var downloadPromise = configUpdater.downloadFile(url, tempFile, downloadOptions).then(function (result) {
            if (!result.notModified) {
                // Validate the JSON
                var p = update.isJSON
                    ? configUpdater.validateJSON(tempFile)
                    : Promise.resolve(true);
                return p.then(function (isValid) {
                    if (isValid) {
                        downloadHash = result.hash;
                        togo.etag = result.etag;
                        togo.date = result.date;
                    }
                });
            }
        }, function (err) {
            service.logWarn("updateFile: download failed", err);
        });

        return Promise.all([downloadPromise, hashPromise]).then(function () {
            var updatePromise;
            // Only perform the update if the file is different, to avoid needlessly overwriting the backup.
            if (downloadHash && downloadHash !== localHash) {
                updatePromise = configUpdater.applyUpdate(tempFile, update.path).then(function (backupPath) {
                    togo.previous = backupPath;
                    return togo;
                });
            }

            return updatePromise || togo;
        });
    } else {
        service.log("Not updating " + update.path + ": no url");
        return Promise.resolve(togo);
    }
};

/**
 * Expands "${expanders}" in a string, whose content is a path to a field in the given object.
 *
 * Expanders are in the format of ${path} or ${path?default}.
 * Examples:
 *  "${a.b.c}", {a:{b:{c:"result"}}} returns "result".
 *  "${a.x?no}", {a:{b:{c:"result"}}} returns "no".
 *
 * @param {String} unexpanded The input string, containing zero or more expanders.
 * @param {Object} sourceObject The object which the paths in the expanders refer to.
 * @param {String} alwaysExpand `true` to make expanders that resolve to null/undefined resolve to an empty
 *  string, otherwise the function returns null.
 * @return {String} The input string, with the expanders replaced by the value of the field they refer to.
 */
configUpdater.expand = function (unexpanded, sourceObject, alwaysExpand) {
    var unresolved = false;
    // Replace all occurences of "${...}"
    var result = unexpanded.replace(/\$\{([^?}]*)(\?([^}]*))?\}/g, function (match, expression, defaultGroup, defaultValue) {
        // Resolve the path to a field, deep in the object.
        var value = expression.split(".").reduce(function (parent, property) {
            return (parent && parent.hasOwnProperty(property)) ? parent[property] : undefined;
        }, sourceObject);

        if (value === undefined || (typeof(value) === "object")) {
            if (defaultGroup) {
                value = defaultValue;
            }
            if (value === undefined || value === null) {
                if (!alwaysExpand) {
                    unresolved = true;
                }
                value = "";
            }
        }
        return value;
    });
    return unresolved ? null : result;
};

/**
 * Applies an updated file, by moving the newly downloaded file in the target location, after backing up the original
 * file.
 *
 * @param {String} source The newly downloaded file.
 * @param {String} destination The target path.
 * @return {Promise<String>} Resolves with the path to the back-up of the original (or undefined).
 */
configUpdater.applyUpdate = function (source, destination) {
    var backupPromise;
    var backupPath;
    // Back up the current file
    if (fs.existsSync(destination)) {
        backupPath = destination + ".previous";
        backupPromise = configUpdater.moveFile(destination, backupPath)["catch"](function () {
            // Try a different location.
            backupPath = path.join(process.env.ProgramData, "Morphic", path.basename(backupPath));
            return configUpdater.moveFile(destination, backupPath);
        });
    } else {
        backupPromise = Promise.resolve();
    }

    // Move the new file in place
    return backupPromise.then(function () {
        // Copy + delete, because moving will cause the target file to retain the original permissions of the file which
        // were inherited from the directory.
        return configUpdater.moveFile(source, destination, true).then(function () {
            fs.unlinkSync(source);
            return backupPath;
        });
    });
};

/**
 * Moves a file from one place to another, or if that fails then copy it (leaving the source in place).
 *
 * @param {String} source Path to the file.
 * @param {String} destination Path to where the new file should be placed.
 * @param {Boolean} copy Copy the file, instead of moving it.
 * @return {Promise} Resolves when complete, with a value of `true` if the file was moved or `false` if it was copied.
 */
configUpdater.moveFile = function (source, destination, copy) {
    return new Promise(function (resolve, reject) {

        // Make sure the target directory exists
        var destDir = path.dirname(destination);
        if (!fs.existsSync(destDir)) {
            mkdirp.sync(destDir);
        }

        var fn = copy ? fs.copyFile : fs.rename;

        fn(source, destination, function (err) {
            if (err) {
                if (copy) {
                    reject({
                        isError: "moveFile failed (copyFile):" + err.message,
                        error: err
                    });
                } else {
                    // try to copy it
                    configUpdater.moveFile(source, destination, true).then(resolve, reject);
                }
            } else {
                resolve(copy);
            }
        });
    });
};


/**
 * Returns the current date/time in a format for HTTP.
 * @return {String} The current date, like `Thu, 01 Jan 1970 00:00:00 GMT`
 */
configUpdater.getDateString = function () {
    return new Date().toUTCString();
};

/**
 * Downloads a file.
 *
 * Can use an ETag and/or date value to ask the server to only respond with updated files.
 *
 * @param {String} url The remote uri.
 * @param {String} localPath Destination path.
 * @param {Object} options Extra options.
 * @param {String} options.date The 'If-Modified-Since' header value, to ask the server to check if the remote file has
 *  been updated after that date. The date is in the format of 'Thu, 01 Jan 1970 00:00:00 GMT', and is usually the value
 *  of the Last-Modified header from the previous successful request to the same URL.
 * @param {String} options.etag The ETag (If-None-Match header), to ask the server only return the file if it's a
 *  different ETag (or version). This value is from the previous successful request to the same URL.
 * @param {String} options.hashAlgorithm The hash algorithm (default: sha512)
 * @return {Promise<Object>} Resolves with the hash, etag, and server's date (if known) when the download is complete,
 *  or with `{notModified: true}` if the remote file has not changed, according to the options.date and/or options.etag values.
 */
configUpdater.downloadFile = function (url, localPath, options) {
    options = Object.assign({
        date: null,
        hashAlgorithm: "sha512"
    }, options);

    return new Promise(function (resolve, reject) {

        service.log("Downloading", url, "to", localPath);

        var headers = {};
        if (options.etag) {
            // If supported, the server should respond with "304 Not Updated" if the resource is the same.
            headers["If-None-Match"] = "\"" + options.etag + "\"";
        }
        if (options.date) {
            // If supported, the server should respond with "304 Not Updated" if the resource hasn't changed since
            // the date.
            headers["If-Modified-Since"] = options.date;
        }

        var req = request.get({
            url: url,
            headers: headers
        });

        req.on("error", function (err) {
            reject({
                isError: true,
                message: "Unable to download from " + url  + ": " + err.message,
                url: url,
                error: err
            });
        });

        req.on("response", function (response) {
            service.log("Download response", url, response.statusCode, response.statusMessage);
            if (response.statusCode === 200) {
                var content = fs.createWriteStream(localPath);

                response.pipe(content);

                content.on("finish", function () {
                    service.log("Download complete", url);
                    configUpdater.hashFile(localPath, options.hashAlgorithm).then(function (hash) {
                        var result = {
                            hash: hash
                        };

                        // Return the ETag header if it exists, but not weak ones.
                        var etag = response.headers.etag;
                        if (etag && !etag.startsWith("W/")) {
                            if (etag.startsWith("\"") && etag.endsWith("\"")) {
                                // remove the surrounding quotes.
                                result.etag = etag.substring(1, etag.length - 1);
                            } else {
                                result.etag = etag;
                            }
                        }

                        result.date = response.headers["last-modified"] || undefined;

                        resolve(result);
                    }, reject);
                });
                content.on("error", function (err) {
                    reject({
                        isError: true,
                        message: "Unable to download from " + url + " to " + localPath + ": " + err.message,
                        error: err,
                        url: url,
                        localPath: localPath
                    });
                });
            } else if (response.statusCode === 304) {
                // "Not Modified"
                resolve({notModified: true});
            } else {
                reject({
                    isError: true,
                    message: "Unable to download from " + url + ": " + response.statusCode + " " + response.statusMessage,
                    url: url
                });
            }
        });
    });
};

/**
 * Calculate the hash of a file.
 *
 * @param {String} file The file.
 * @param {String} algorithm [optional] The algorithm. [default: sha512]
 * @return {Promise<String>} Resolves with the hash, as hex string.
 */
configUpdater.hashFile = function (file, algorithm) {
    return new Promise(function (resolve, reject) {
        if (!algorithm) {
            algorithm = "sha512";
        }

        try {
            var hash = crypto.createHash(algorithm);

            hash.on("error", function (e) {
                reject(e);
            });
            hash.on("finish", function () {
                var result = hash.read().toString("hex");
                resolve(result);
            });

            var input = fs.createReadStream(file);
            input.pipe(hash);

            input.on("error", function (e) {
                reject(e);
            });

        } catch (e) {
            reject(e);
        }
    });
};

/**
 * Validates the JSON (or JSON5) content of a file.
 * @param {String} file The file whose content to check.
 * @return {Promise<unknown>} Resolves with a boolean indicating if the content is valid JSON/JSON5.
 */
configUpdater.validateJSON = function (file) {
    return new Promise(function (resolve, reject) {
        fs.readFile(file, "utf8", function (err, content) {
            if (err) {
                reject({
                    isError: true,
                    err: err,
                    message: "validateJSON:" + err.message,
                    file: file
                });
            } else {
                var valid = false;
                try {
                    JSON.parse(content);
                    valid = true;
                } catch (e) {
                    try {
                        JSON5.parse(content);
                        valid = true;
                    } catch (e) {
                        // Ignore - invalid content is an expected condition for this function.
                    }
                }

                resolve(valid);
            }
        });
    });
};

if (service.config.autoUpdate.enabled) {
    service.readyWhen(configUpdater.updateAll());
}
