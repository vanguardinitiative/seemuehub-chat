/**
 * The part of the Redis configuration that may go to the logs: where Redis is.
 * The whole config object used to be logged at boot, REDIS_PASSWORD included,
 * into `docker logs` and wherever those are shipped.
 */
export const describeRedisConfig = (config: { socket: { host?: string; port?: number } }) => ({
  host: config.socket.host,
  port: config.socket.port,
});
