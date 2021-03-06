var crypto = require('crypto');
var debug = require('debug')('autolander:bugstore');
var thunkify = require('thunkify');

/**
 * The bug store manages the currently subscribed bugs.
 * A bug is subscribed to when we open a pull request for the bug.
 * The subscription is removed after we no longer have open pull requests
 * attached to a bug. The bug store is necessary so we don't need to query
 * for *every* single bug update that we receive over pulse.
 */

// This might make us sad in the future.
// Currently we safeguard against collisions by using different azure keys per environment.
// In the future we may want to make the tablename itself configurable.
const BUG_TABLE = 'autolandersubscribedbugs';

/**
 * Returns the partition for a bug ID.
 * Hashes the bugId.
 */
function partitionForBug(bugId) {
  var shasum = crypto.createHash('sha1');
  return shasum.update(String(bugId)).digest('hex');
}

var BugStore = function(config, api) {
  this._api = api;
  this._config = config;
  return this;
}

/**
 * Sets up the necessary azure table if it doesn't exist.
 */
BugStore.prototype.init = function * (config) {
  var createTable = thunkify(this._api.createTable.bind(this._api));
  yield createTable(BUG_TABLE, {
    ignoreIfExists: true
  });

  return this;
};

/**
 * Checks if we are subscribed to a single bug.
 */
BugStore.prototype.isSubscribed = function * (bugId) {
  debug('isSubscribed bugId', bugId);
  var getEntity = thunkify(this._api.getEntity.bind(this._api));
  var partitionKey = partitionForBug(bugId);

  var storedBug;
  try {
    storedBug = yield getEntity(BUG_TABLE, partitionKey, String(bugId));
  } catch(e) {
    debug('subscription not found');
    return false;
  }
  debug('bug subscription found', storedBug);

  return storedBug;
};

/**
 * Stops tracking a stored bug.
 * @param {Integer} bugId
 */
BugStore.prototype.remove = function * (bugId) {
  var deleteEntity = thunkify(this._api.deleteEntity.bind(this._api));
  yield deleteEntity(BUG_TABLE, {
    PartitionKey: partitionForBug(bugId),
    RowKey: String(bugId)
  }, {force: true});
  debug('bug subscription removed', bugId);
};

/**
 * starts tracking a stored bug.
 * @param {Integer} bugId
 */
BugStore.prototype.subscribe = function * (bugId) {
  var insertOrReplaceEntity = thunkify(this._api.insertOrReplaceEntity.bind(this._api));
  var response = yield insertOrReplaceEntity(BUG_TABLE, {
    PartitionKey: partitionForBug(bugId),
    RowKey: bugId
  });
  debug('subscribe', response);
};

/**
 * Initializes the Bug Storage API.
 * When a pull request is opened for a bug we subscribe to it so we can quickly tell if we need to
 * look it up and process it from a pulse request.
 */
exports.init = function * (config, api) {
  var api = new BugStore(config, api);
  return yield api.init();
};
