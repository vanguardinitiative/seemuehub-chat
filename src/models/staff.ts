import mongoose, { Document, Schema } from "mongoose";

enum StaffRole {
  SUPER_ADMIN = "SUPER_ADMIN",
  EV_ADMIN = "EV_ADMIN",
  EV_MANAGER = "EV_MANAGER",
  EV_STAFF = "EV_STAFF",
  TAXI_ADMIN = "TAXI_ADMIN",
  TAXI_MANAGER = "TAXI_MANAGER",
  TAXI_STAFF = "TAXI_STAFF",
  FRANCHISE_ADMIN = "FRANCHISE_ADMIN",
}

enum UserStatus {
  NOT_REGISTER = "NOT_REGISTER",
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  BLOCKED = "BLOCKED",
}

export interface IStaff extends Document {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  userName: string;
  password: string;
  status: string;
  role: StaffRole;
  profileImage: string;
  createdAt: Date;
  createdBy: mongoose.Types.ObjectId;
  updatedAt: Date;
  updatedBy: mongoose.Types.ObjectId;
  phone: string;
  userID: string;
  country: string;
}

const StaffSchema = new Schema({
  firstName: {
    type: String,
    required: false,
  },
  lastName: {
    type: String,
    required: false,
  },
  fullName: {
    type: String,
    required: false,
  },
  email: {
    type: String,
    required: false,
  },
  userName: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: Object.values(StaffRole),
    default: StaffRole.EV_STAFF,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(UserStatus),
    default: UserStatus.APPROVED,
  },
  profileImage: {
    type: String,
    required: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
    required: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
  },
  phone: {
    type: String,
    default: null,
  },
  userID: {
    type: String,
    required: true,
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Country",
  },
});

export const staffModel = mongoose.model<IStaff>("Staff", StaffSchema);
