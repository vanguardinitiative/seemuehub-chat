import type { Request } from "express";
import { Types } from "mongoose";
export declare const participantOf: (userId: string) => {
    "participants.user": Types.ObjectId;
};
export declare const userIdOf: (req: Request) => string | null;
export declare const isParticipant: (conversationId: string, userId: string) => Promise<boolean>;
//# sourceMappingURL=conversation-access.d.ts.map