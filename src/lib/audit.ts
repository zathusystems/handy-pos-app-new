
'use client';

import { db, type AuditLog, type ActionType } from './db';

interface LogProps {
    userId: string;
    userName: string;
    branchId: string;
    actionType: ActionType;
    entityType: AuditLog['entityType'];
    entityId: string;
    details?: Record<string, any>;
}

export const logAuditAction = async (props: LogProps) => {
    try {
        const auditEntry: AuditLog = {
            id: `AUDIT-${Date.now()}`,
            timestamp: new Date().toISOString(),
            ...props,
            details: props.details || {},
        };
        await db.auditLog.add(auditEntry);
    } catch (error) {
        console.error("Failed to log audit action:", error);
        // Fail silently so as not to interrupt user flow
    }
};
