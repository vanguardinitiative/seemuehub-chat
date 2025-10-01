import mongoose, { Document } from "mongoose";
export declare enum Gender {
    MALE = "MALE",
    FEMALE = "FEMALE",
    OTHER = "OTHER"
}
export declare enum UserRole {
    USER = "USER",
    ADMIN = "ADMIN"
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
    freelancerInfo?: any;
    profileImage?: string;
    phone?: string;
    dateOfBirth?: Date;
    address?: {
        village?: string;
        district?: string;
        province?: string;
    };
    deviceToken?: string;
    isOnline?: boolean;
    socketId?: string;
}
export declare const userModel: mongoose.Model<IUser, {}, {}, {}, mongoose.Document<unknown, {}, IUser, {}> & IUser & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=user.d.ts.map