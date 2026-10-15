create schema if not exists "public";

create table "public"."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "public"."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "public"."user" ("id") on delete cascade);

create table "public"."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "public"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "public"."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "public"."jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table "public"."oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "public"."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table "public"."oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "public"."oauthClientResource" ("id" text not null primary key, "clientId" text not null references "public"."oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "public"."oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "public"."oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "public"."oauthClient" ("clientId") on delete cascade, "sessionId" text references "public"."session" ("id") on delete set null, "userId" text not null references "public"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "public"."oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "public"."oauthClient" ("clientId") on delete cascade, "sessionId" text references "public"."session" ("id") on delete set null, "userId" text references "public"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "public"."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "public"."oauthConsent" ("id" text not null primary key, "clientId" text not null references "public"."oauthClient" ("clientId") on delete cascade, "userId" text references "public"."user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "public"."oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create index "session_userId_idx" on "public"."session" ("userId");

create index "account_userId_idx" on "public"."account" ("userId");

create index "verification_identifier_idx" on "public"."verification" ("identifier");

create index "oauthClient_userId_idx" on "public"."oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "public"."oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "public"."oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "public"."oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "public"."oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "public"."oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "public"."oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "public"."oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "public"."oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "public"."oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "public"."oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "public"."oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "public"."oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "public"."oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "public"."oauthClientResource" ("clientId", "resourceId");