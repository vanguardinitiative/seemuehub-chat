import mongoose, { Document } from "mongoose";
declare enum StaffRole {
    SUPER_ADMIN = "SUPER_ADMIN",
    EV_ADMIN = "EV_ADMIN",
    EV_MANAGER = "EV_MANAGER",
    EV_STAFF = "EV_STAFF",
    TAXI_ADMIN = "TAXI_ADMIN",
    TAXI_MANAGER = "TAXI_MANAGER",
    TAXI_STAFF = "TAXI_STAFF",
    FRANCHISE_ADMIN = "FRANCHISE_ADMIN"
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
export declare const staffModel: mongoose.Model<IStaff, {}, {}, {}, mongoose.Document<unknown, {}, IStaff, {}> & IStaff & Required<{
    _id: unknown;
}> & {
    __v: number;
}, any>;
export {};
//# sourceMappingURL=staff.d.ts.map