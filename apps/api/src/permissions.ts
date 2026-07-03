import { createPermissionChecker } from "@cohub/core/auth";
import { db } from "./db/index.js";

const checker = createPermissionChecker({ db });

export const hasPermission = checker.hasPermission;
export const getRoleForSpaceUser = checker.getRoleForSpaceUser;
export const getSpaceMemberRole = checker.getSpaceMemberRole;
export const resolvePermissionAccess = checker.resolvePermissionAccess;
export const getSessionSpaceId = checker.getSessionSpaceId;
export const filterSessionsByPermission = checker.filterSessionsByPermission;

export type { Audience, Permission, PermissionAccess } from "@cohub/core/auth";
export type { AccessPolicy } from "@cohub/core/permissions";
