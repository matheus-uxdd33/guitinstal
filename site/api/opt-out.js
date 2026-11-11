'use strict';

/**
 * A second route onto the same handler: /api/opt-out removes an address, and
 * the handler picks the behaviour from the request path.
 */

module.exports = require('./waitlist.js');
