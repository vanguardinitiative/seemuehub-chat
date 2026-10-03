/**
 * Lets a test require the REST routes from dist/ with neither Redis nor Mongo.
 *
 * - Sets the env vars config/env.ts insists on at import time.
 * - Puts a fake config/redis in require.cache before anything loads the real
 *   one, which connects (and retries) the moment it is imported. The fake
 *   records what would have been published.
 * - Turns off mongoose's command buffering, so a query nobody stubbed fails at
 *   once instead of hanging the test for ten seconds.
 *
 * Require this before any dist/ module. Not a test file (node --test only
 * picks up *.test.js here).
 */
const mongoose = require("mongoose");

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:1/chat-test";
process.env.REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
process.env.REDIS_PORT = process.env.REDIS_PORT || "6379";
process.env.REDIS_PASSWORD = process.env.REDIS_PASSWORD || "test-redis-password";
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";

mongoose.set("bufferCommands", false);

const published = [];
/** The key-value cache config/redis exports (org chat's authorize answers, memberships), with what was set. */
const cached = new Map();
const redisFile = require.resolve("../../dist/config/redis.js");
require.cache[redisFile] = {
  id: redisFile,
  filename: redisFile,
  loaded: true,
  exports: {
    pub: {
      publish: async (channel, message) => {
        published.push({ channel, message: JSON.parse(message) });
      },
      isConnected: () => true,
    },
    sub: {},
    subscribeToClient: async () => {},
    redisConfig: {},
    cache: {
      get: async (key) => (cached.has(key) ? cached.get(key).value : null),
      set: async (key, value, ttlSeconds) => {
        cached.set(key, { value, ttlSeconds });
      },
    },
  },
};

/** Temporarily replace `object[name]`; returns the restore function. */
const stub = (object, name, value) => {
  const had = Object.prototype.hasOwnProperty.call(object, name);
  const original = object[name];
  object[name] = value;
  return () => {
    if (had) object[name] = original;
    else delete object[name];
  };
};

/** A resolved mongoose-like query: awaitable, and chainable through the usual methods. */
const query = (result) => {
  const chain = {
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    lean: () => chain,
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    session: () => chain,
  };
  return chain;
};

module.exports = { published, cached, stub, query };
