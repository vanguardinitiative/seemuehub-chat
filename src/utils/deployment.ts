/**
 * Is this a production deployment? NODE_ENV or DEPLOY_ENV is "production", in
 * any case: the image sets NODE_ENV=production, `npm run start:prod` sets
 * PRODUCTION, and seemuehub-backend's own rule (config/env.ts
 * isProductionDeployment there) reads DEPLOY_ENV as well. Read at call time,
 * so tests can change the environment.
 */
export const isProductionDeployment = (source: { NODE_ENV?: string; DEPLOY_ENV?: string } = process.env): boolean =>
  [source.NODE_ENV, source.DEPLOY_ENV].some((value) => typeof value === "string" && value.trim().toLowerCase() === "production");
