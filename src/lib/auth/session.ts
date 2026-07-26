import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import type {
	TeamMembershipRole,
	TeamMembershipRow,
	UserRow,
	UserSessionRow,
} from "../db-contract.ts";
import type { AuthRepository } from "../repositories/auth-repository.ts";
import { verifyPassword } from "./password.ts";

export const SESSION_COOKIE_NAME = "bot_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_ORDER: Record<TeamMembershipRole, number> = {
	restricted: 0,
	viewer: 1,
	agent: 2,
	manager: 3,
	owner: 4,
};

export class AuthError extends Error {
	constructor(
		public readonly status: 401 | 403,
		message: "auth_unauthorized" | "auth_forbidden",
	) {
		super(message);
	}
}

export interface SessionContext {
	session: UserSessionRow;
	user: UserRow;
	memberships: TeamMembershipRow[];
	role: TeamMembershipRole;
	teamId: number | null;
}

export interface SessionDeps {
	repo: AuthRepository;
	now?: () => Date;
	randomToken?: () => string;
	sessionTtlMs?: number;
}

export interface LoginInput {
	email: string;
	password: string;
	requestMetadata?: Record<string, unknown>;
}

export interface SessionRouteDeps extends SessionDeps {
	secureCookies?: boolean;
}

function defaultNow() {
	return new Date();
}

function defaultToken() {
	return randomBytes(24).toString("hex");
}

function readCookie(request: Request, name: string) {
	const raw = request.headers.get("cookie");
	if (!raw) return null;
	for (const chunk of raw.split(";")) {
		const [key, ...rest] = chunk.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

function pickRole(memberships: TeamMembershipRow[]) {
	return memberships.reduce<TeamMembershipRole | null>((current, membership) => {
		if (!current) return membership.role;
		return ROLE_ORDER[membership.role] > ROLE_ORDER[current] ? membership.role : current;
	}, null);
}

function toSessionContext(
	user: UserRow,
	session: UserSessionRow,
	memberships: TeamMembershipRow[],
): SessionContext | null {
	const role = pickRole(memberships);
	if (!role) return null;
	return {
		session,
		user,
		memberships,
		role,
		teamId: memberships[0]?.team_id ?? null,
	};
}

export function hashSessionToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

export function setSessionCookie(
	response: NextResponse,
	token: string,
	input: { secure?: boolean; maxAgeSeconds?: number } = {},
) {
	response.cookies.set(SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		secure: input.secure ?? process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: input.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000),
	});
	return response;
}

export function clearSessionCookie(response: NextResponse) {
	response.cookies.set(SESSION_COOKIE_NAME, "", {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 0,
	});
	return response;
}

export async function getSessionFromRequest(
	request: Request,
	deps: SessionDeps,
): Promise<SessionContext | null> {
	const token = readCookie(request, SESSION_COOKIE_NAME);
	if (!token) return null;

	const now = (deps.now ?? defaultNow)();
	const session = await deps.repo.getSessionByTokenHash(hashSessionToken(token));
	if (!session || session.revoked_at || session.expires_at.getTime() <= now.getTime()) {
		return null;
	}

	const user = await deps.repo.findUserById(session.user_id);
	if (!user || user.status !== "active") return null;

	const memberships = await deps.repo.listTeamMembershipsByUserId(user.id);
	return toSessionContext(user, session, memberships);
}

export async function requireSession(request: Request, deps: SessionDeps) {
	const session = await getSessionFromRequest(request, deps);
	if (!session) throw new AuthError(401, "auth_unauthorized");
	return session;
}

export async function requireRole(
	context: SessionContext,
	minimumRole: TeamMembershipRole,
) {
	if (ROLE_ORDER[context.role] < ROLE_ORDER[minimumRole]) {
		throw new AuthError(403, "auth_forbidden");
	}
	return context;
}

export async function requireRequestRole(
	request: Request,
	deps: SessionDeps,
	minimumRole: TeamMembershipRole,
) {
	const context = await requireSession(request, deps);
	return requireRole(context, minimumRole);
}

export function authErrorToResponse(error: unknown) {
	if (error instanceof AuthError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	return null;
}

export function createSessionService(deps: SessionDeps) {
	const now = deps.now ?? defaultNow;
	const randomToken = deps.randomToken ?? defaultToken;
	const sessionTtlMs = deps.sessionTtlMs ?? SESSION_TTL_MS;

	return {
		async login(input: LoginInput) {
			const user = await deps.repo.findUserByEmail(input.email);
			const userId = user?.id ?? null;
			const memberships = user ? await deps.repo.listTeamMembershipsByUserId(user.id) : [];
			const teamId = memberships[0]?.team_id ?? null;
			const credential = user ? await deps.repo.getPasswordCredentialByUserId(user.id) : null;
			const passwordOk =
				!!user &&
				user.status === "active" &&
				!!credential &&
				(await verifyPassword(input.password, credential.password_hash));

			if (!passwordOk) {
				await deps.repo.recordAuditEvent({
					actor_user_id: userId,
					team_id: teamId,
					entity_type: "user_session",
					entity_id: userId ? String(userId) : input.email.trim().toLowerCase(),
					action: "auth.login_failed",
					request_metadata: input.requestMetadata ?? {},
				});
				return { status: "invalid_credentials" as const };
			}

			const issuedAt = now();
			const token = randomToken();
			const session = await deps.repo.createSession({
				user_id: user.id,
				session_token_hash: hashSessionToken(token),
				expires_at: new Date(issuedAt.getTime() + sessionTtlMs),
				created_at: issuedAt,
			});
			const context = toSessionContext(user, session, memberships);
			if (!context) {
				await deps.repo.revokeSessionByTokenHash(session.session_token_hash, issuedAt);
				return { status: "invalid_credentials" as const };
			}

			await deps.repo.recordAuditEvent({
				actor_user_id: user.id,
				team_id: context.teamId,
				entity_type: "user_session",
				entity_id: String(session.id),
				action: "auth.login_succeeded",
				after_json: { role: context.role, expires_at: session.expires_at.toISOString() },
				request_metadata: input.requestMetadata ?? {},
				created_at: issuedAt,
			});

			return { status: "authenticated" as const, token, session, user, context };
		},

		getSessionFromRequest(request: Request) {
			return getSessionFromRequest(request, { ...deps, now });
		},

		async revokeFromRequest(
			request: Request,
			input: { requestMetadata?: Record<string, unknown> } = {},
		) {
			const token = readCookie(request, SESSION_COOKIE_NAME);
			if (!token) return { status: "missing" as const };

			const tokenHash = hashSessionToken(token);
			const context = await getSessionFromRequest(request, { ...deps, now });
			const revokedAt = now();
			const session = await deps.repo.revokeSessionByTokenHash(tokenHash, revokedAt);
			if (!session) return { status: "missing" as const };

			await deps.repo.recordAuditEvent({
				actor_user_id: context?.user.id ?? null,
				team_id: context?.teamId ?? null,
				entity_type: "user_session",
				entity_id: String(session.id),
				action: "auth.logout",
				after_json: { revoked_at: revokedAt.toISOString() },
				request_metadata: input.requestMetadata ?? {},
				created_at: revokedAt,
			});

			return { status: "revoked" as const, session };
		},
	};
}
