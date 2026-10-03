import mongoose, { Schema } from "mongoose";

/**
 * seemuehub-backend's organization memberships, read only. The backend owns
 * the collection and its indexes, so this declares none: an index declared
 * here would be built by this service at start and dropped again by the
 * backend's index sync.
 *
 * Used where the chat service decides on its own who is a member: the
 * organization routes while ORG_CHAT_ENABLED is off (as they always did), and
 * the socket SETUP, which looks up the organizations whose rooms to join.
 */
const organizationMemberSchema = new Schema(
  { organizationId: Schema.Types.ObjectId, userId: Schema.Types.ObjectId, role: String, status: String },
  { collection: "organizationmembers", autoIndex: false }
);

export const organizationMemberModel: mongoose.Model<any> =
  mongoose.models.OrganizationMember ?? mongoose.model("OrganizationMember", organizationMemberSchema);

/** The user's ACTIVE membership of the organization, or null. */
export const findActiveMembership = (organizationId: string, userId: string) =>
  organizationMemberModel.findOne({ organizationId, userId, status: "ACTIVE" }).lean();
