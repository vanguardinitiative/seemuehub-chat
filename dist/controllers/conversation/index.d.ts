import { Request, Response } from "express";
declare const createPrivateConversation: (req: Request, res: Response) => Promise<void>;
declare const createGroupConversation: (req: Request, res: Response) => Promise<void>;
declare const getConversation: (req: Request, res: Response) => Promise<void>;
declare const getAllConversions: (req: Request, res: Response) => Promise<void>;
export { createPrivateConversation, createGroupConversation, getConversation, getAllConversions };
//# sourceMappingURL=index.d.ts.map