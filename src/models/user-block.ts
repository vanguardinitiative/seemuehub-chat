import mongoose, { Schema } from "mongoose";

/**
 * seemuehub-backend's user blocks (worktrees/STORE-SAFETY-CONTRACT.md §2),
 * read only: one row per "blockerId blocked blockedId", written by the
 * backend's POST / DELETE /me/blocks and nothing else. This service never
 * writes to it.
 *
 * The backend owns the collection and its indexes (unique {blockerId:1,
 * blockedId:1} and {blockedId:1}, built by its index sync), so this declares
 * none and never creates the collection: an index declared here would be
 * built by this service at start and dropped again by the backend's sync.
 * Until the backend ships, the collection does not exist; a read of it finds
 * nothing, so nothing is refused.
 */
const userBlockSchema = new Schema(
  { blockerId: Schema.Types.ObjectId, blockedId: Schema.Types.ObjectId, createdAt: Date },
  { collection: "userblocks", autoIndex: false, autoCreate: false, versionKey: false }
);

export interface UserBlockRow {
  blockerId?: unknown;
  blockedId?: unknown;
}

export const userBlockModel: mongoose.Model<any> =
  mongoose.models.UserBlock ?? mongoose.model("UserBlock", userBlockSchema);
