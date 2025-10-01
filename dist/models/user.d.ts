import mongoose, { Document } from "mongoose";
declare enum UserRole {
    CUSTOMER = "CUSTOMER",
    DRIVER = "DRIVER"
}
export interface IUser extends Document {
    firstName: string;
    lastName: string;
    fullName: string;
    phone: string;
    email: string;
    licensePlate: string;
    role: UserRole;
    profileImage: string;
    deviceToken: string;
    isOnline: boolean;
    socketId: string;
}
export declare const userModel: mongoose.Model<IUser, {}, {}, {}, mongoose.Document<unknown, {}, IUser, {}> & IUser & Required<{
    _id: unknown;
}> & {
    __v: number;
}, any>;
export {};
//# sourceMappingURL=user.d.ts.map