import mongoose, { Schema } from "mongoose";

/**
 * seemuehub-backend's payments, read only: the backend writes every row (a
 * bank payment it created, and the bank's confirmation). This service reads
 * one thing from it: whether a donation a signed-out donate page names is one
 * it may follow (src/socket/donation-follow.ts).
 *
 * The backend owns the collection and its indexes (`referenceId` is indexed),
 * so this declares none and never creates the collection, like
 * models/user-block.ts.
 */
const paymentSchema = new Schema(
  {
    userId: Schema.Types.ObjectId,
    type: String,
    status: String,
    referenceId: String,
    createdAt: Date,
  },
  { collection: "payments", autoIndex: false, autoCreate: false, versionKey: false }
);

export const paymentModel: mongoose.Model<any> = mongoose.models.ChatPaymentRead ?? mongoose.model("ChatPaymentRead", paymentSchema);
