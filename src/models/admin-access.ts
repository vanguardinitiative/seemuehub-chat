import mongoose, { Schema } from "mongoose";

/**
 * seemuehub-backend's staff access collections (ADMIN-RBAC-CONTRACT.md §3, §7,
 * §9), as far as the admin oversight endpoints need them.
 *
 * The backend owns all three, their indexes and their shapes
 * (src/modules/admin-access/admin-role.model.ts, admin-audit.model.ts and
 * bootstrap-marker.ts there). So these declare no index - one declared here
 * would be built by this service at start and dropped again by the backend's
 * index sync - and no defaults that would write anything the backend did not.
 */

/** `adminroles`: read only. A staff member's roles, by `users.staff.roleIds`. */
export type AdminRoleRow = { _id: unknown; key?: string | null; permissions?: string[] | null; system?: boolean | null };

const adminRoleSchema = new Schema(
  { key: String, permissions: [String], system: Boolean },
  { collection: "adminroles", autoIndex: false }
);

export const adminRoleModel: mongoose.Model<any> =
  mongoose.models.AdminRole ?? mongoose.model("AdminRole", adminRoleSchema);

/**
 * `adminauditlogs`: append only. This service writes `HTTP` rows for its
 * oversight reads and never updates or deletes one. No `__v` and no
 * timestamps, as the backend's own rows: `at` is the one time.
 */
const adminAuditLogSchema = new Schema(
  {
    at: { type: Date, required: true },
    actorId: { type: Schema.Types.ObjectId },
    actorEmail: String,
    actorRoleKeys: { type: [String], default: undefined },
    event: { type: String, required: true },
    method: String,
    route: String,
    path: String,
    query: Schema.Types.Mixed,
    status: Number,
    permission: String,
    targetType: String,
    targetId: String,
    requestId: String,
    ip: String,
    country: String,
    userAgent: { type: String, maxlength: 256 },
    metadata: Schema.Types.Mixed,
  },
  { collection: "adminauditlogs", autoIndex: false, versionKey: false }
);

export const adminAuditLogModel: mongoose.Model<any> =
  mongoose.models.AdminAuditLog ?? mongoose.model("AdminAuditLog", adminAuditLogSchema);

/**
 * `adminaccessstate`: read only. One row per fact, by `_id`; the one read here
 * is "staff-bootstrap", written by the backend's `staff:bootstrap --apply`.
 */
export const BOOTSTRAP_MARKER_ID = "staff-bootstrap";

const adminAccessStateSchema = new Schema(
  { _id: { type: String, required: true }, at: Date },
  { collection: "adminaccessstate", autoIndex: false, versionKey: false }
);

export const adminAccessStateModel: mongoose.Model<any> =
  mongoose.models.AdminAccessState ?? mongoose.model("AdminAccessState", adminAccessStateSchema);
