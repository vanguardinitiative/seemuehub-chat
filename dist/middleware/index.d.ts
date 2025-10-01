import { Request, Response, NextFunction } from "express";
export interface TokenData {
    id: string;
    fullName: string;
    status: string;
    role: string;
}
export declare const checkAuthorizationMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=index.d.ts.map