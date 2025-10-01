import mongoose, { Document, Schema } from "mongoose";

export enum Gender {
  MALE = "MALE",
  FEMALE = "FEMALE",
  OTHER = "OTHER",
}

export enum UserRole {
  USER = "USER",
  ADMIN = "ADMIN",
}

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  userName: string;
  gender?: Gender;
  displayName?: string;
  password?: string;
  role: UserRole;
  isFreelancer?: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  freelancerInfo?: any; // Simplified for chat service
  profileImage?: string;
  phone?: string;
  dateOfBirth?: Date;
  address?: {
    village?: string;
    district?: string;
    province?: string;
  };
  // Chat-specific fields
  deviceToken?: string;
  isOnline?: boolean;
  socketId?: string;
}

const UserSchema: Schema = new Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid email"],
      index: true,
    },
    userName: {
      type: String,
      required: true,
    },
    gender: {
      type: String,
      enum: Object.values(Gender),
      default: Gender.OTHER,
    },
    displayName: {
      type: String,
      default: null,
    },
    password: {
      type: String,
      required: false,
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.USER,
      required: true,
    },
    profileImage: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    isFreelancer: {
      type: Boolean,
      default: false,
    },
    freelancerInfo: {
      type: Schema.Types.Mixed,
      default: null,
    },
    address: {
      village: { type: String, default: null },
      district: { type: String, default: null },
      province: { type: String, default: null },
    },
    // Chat-specific fields
    deviceToken: {
      type: String,
      default: null,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    socketId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for chat functionality
UserSchema.index({ email: 1 });
UserSchema.index({ isOnline: 1 });
UserSchema.index({ socketId: 1 });

export const userModel = mongoose.model<IUser>("User", UserSchema);
